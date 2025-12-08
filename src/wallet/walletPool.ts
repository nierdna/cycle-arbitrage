/**
 * Wallet Pool Manager
 * Quản lý pool của nhiều wallet và rotate để tránh conflict
 * 
 * Features:
 * - Round-robin selection với lock mechanism
 * - Auto cleanup locks sau lock duration
 * - Thread-safe (mỗi wallet chỉ được dùng bởi 1 execution tại 1 thời điểm)
 */

import { ethers } from 'ethers';
import winston from 'winston';
import { NonceCachedWallet, NonceCachedWalletConfig } from './nonceCachedWallet.js';

export interface WalletPoolConfig {
  lockDurationMs?: number; // Thời gian lock sau khi release (default: 2000ms = 2s)
  logger?: winston.Logger;
}

export interface WalletLock {
  wallet: NonceCachedWallet;
  lockedUntil: number; // Timestamp khi lock expires
}

export class WalletPool {
  private wallets: NonceCachedWallet[];
  private locks: Map<string, number> = new Map(); // wallet address -> lockedUntil timestamp
  private currentIndex: number = 0;
  private readonly lockDurationMs: number;
  private logger?: winston.Logger;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(
    wallets: (ethers.Wallet | NonceCachedWallet)[],
    provider: ethers.Provider,
    walletConfig?: NonceCachedWalletConfig,
    poolConfig?: WalletPoolConfig
  ) {
    if (wallets.length === 0) {
      throw new Error('WalletPool requires at least one wallet');
    }

    this.lockDurationMs = poolConfig?.lockDurationMs ?? 2000; // Default 2s
    this.logger = poolConfig?.logger;

    // Convert all wallets to NonceCachedWallet
    this.wallets = wallets.map((wallet) => {
      if (wallet instanceof NonceCachedWallet) {
        return wallet;
      } else {
        // Create NonceCachedWallet từ ethers.Wallet
        return new NonceCachedWallet(wallet.privateKey, provider, {
          ...walletConfig,
          logger: this.logger,
        });
      }
    });

    // Start cleanup interval để remove expired locks
    this.startCleanupInterval();

    this.logger?.info(
      `[WalletPool] Initialized with ${this.wallets.length} wallets, lock duration: ${this.lockDurationMs}ms`
    );
  }

  /**
   * Acquire available wallet từ pool (round-robin với lock check)
   * 
   * @returns Wallet lock object hoặc undefined nếu tất cả đều locked
   */
  acquireWallet(): WalletLock | undefined {
    const now = Date.now();
    const startIndex = this.currentIndex;
    let attempts = 0;

    // Try round-robin, skip locked wallets
    while (attempts < this.wallets.length) {
      const wallet = this.wallets[this.currentIndex];
      const address = wallet.address.toLowerCase();

      // Check if wallet is locked
      const lockedUntil = this.locks.get(address);
      const isLocked = lockedUntil !== undefined && lockedUntil > now;

      if (!isLocked) {
        // Wallet available, lock it
        const lockUntil = now + this.lockDurationMs;
        this.locks.set(address, lockUntil);

        // Move to next wallet for next call
        this.currentIndex = (this.currentIndex + 1) % this.wallets.length;

        this.logger?.debug(
          `[WalletPool] Acquired wallet: ${address} (lock until: ${new Date(lockUntil).toISOString()})`
        );

        return {
          wallet,
          lockedUntil: lockUntil,
        };
      }

      // Wallet is locked, try next one
      this.currentIndex = (this.currentIndex + 1) % this.wallets.length;
      attempts++;
    }

    // All wallets are locked
    this.logger?.warn(
      `[WalletPool] All ${this.wallets.length} wallets are locked. Cannot acquire wallet.`
    );

    // Reset index to start position
    this.currentIndex = startIndex;

    return undefined;
  }

  /**
   * Release wallet lock (extend lock duration để tránh nonce conflict)
   * Lock sẽ tự động expire sau lockDurationMs
   * 
   * @param walletAddress Address của wallet cần release
   */
  releaseWallet(walletAddress: string): void {
    const address = walletAddress.toLowerCase();
    const now = Date.now();

    // Extend lock để tránh nonce conflict ngay sau khi release
    const lockUntil = now + this.lockDurationMs;
    this.locks.set(address, lockUntil);

    this.logger?.debug(
      `[WalletPool] Released wallet: ${address} (lock extended until: ${new Date(lockUntil).toISOString()})`
    );
  }

  /**
   * Get all wallet addresses (for logging/debugging)
   */
  getWalletAddresses(): string[] {
    return this.wallets.map((w) => w.address);
  }

  /**
   * Get pool size
   */
  getPoolSize(): number {
    return this.wallets.length;
  }

  /**
   * Get provider from first wallet (for shared resources like DecimalCache)
   */
  getProvider(): ethers.Provider {
    return this.wallets[0]?.provider || new ethers.JsonRpcProvider();
  }

  /**
   * Get number of currently locked wallets
   */
  getLockedCount(): number {
    const now = Date.now();
    let count = 0;

    for (const lockedUntil of this.locks.values()) {
      if (lockedUntil > now) {
        count++;
      }
    }

    return count;
  }

  /**
   * Start cleanup interval để remove expired locks
   */
  private startCleanupInterval(): void {
    // Cleanup mỗi 1s
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredLocks();
    }, 1000);
  }

  /**
   * Cleanup expired locks
   */
  private cleanupExpiredLocks(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [address, lockedUntil] of this.locks.entries()) {
      if (lockedUntil <= now) {
        this.locks.delete(address);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger?.debug(`[WalletPool] Cleaned up ${cleaned} expired lock(s)`);
    }
  }

  /**
   * Stop cleanup interval (cleanup)
   */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
      this.logger?.info('[WalletPool] Cleanup interval stopped');
    }
  }

  /**
   * Destroy pool (cleanup resources)
   */
  destroy(): void {
    this.stopCleanup();
    this.locks.clear();

    // Stop nonce sync cho tất cả wallets
    for (const wallet of this.wallets) {
      if (wallet instanceof NonceCachedWallet) {
        wallet.stopNonceSync();
      }
    }

    this.logger?.info('[WalletPool] Pool destroyed');
  }
}

