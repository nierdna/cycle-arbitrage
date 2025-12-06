/**
 * Nonce Cached Wallet
 * Extends ethers.Wallet với nonce caching để tối ưu thời gian submit
 * 
 * Features:
 * - Cache nonce khi bootstrap
 * - Auto-increment sau mỗi transaction
 * - Interval sync để detect và fix mismatch
 */

import { ethers } from 'ethers';
import winston from 'winston';

export interface NonceCachedWalletConfig {
  syncIntervalMs?: number; // Interval để sync nonce (default: 30000ms = 30s)
  logger?: winston.Logger; // Optional logger
}

export class NonceCachedWallet extends ethers.Wallet {
  private cachedNonce: number | null = null;
  private nonceSyncInterval?: NodeJS.Timeout;
  private config: Required<Pick<NonceCachedWalletConfig, 'syncIntervalMs'>> & {
    logger?: winston.Logger;
  };

  constructor(
    privateKey: string | ethers.SigningKey,
    provider: ethers.Provider,
    config: NonceCachedWalletConfig = {}
  ) {
    super(privateKey, provider);
    this.config = {
      syncIntervalMs: config.syncIntervalMs ?? 30000,
      logger: config.logger,
    };

    // Initialize nonce khi bootstrap (async, không block constructor)
    this.initializeNonce().catch((err) => {
      this.config.logger?.warn('[NonceCachedWallet] Failed to initialize nonce:', err.message);
    });

    // Start nonce sync interval
    this.startNonceSync();
  }

  /**
   * Initialize nonce từ RPC khi bootstrap
   */
  private async initializeNonce(): Promise<void> {
    if (!this.provider) {
      throw new Error('Provider not set');
    }

    this.cachedNonce = await this.provider.getTransactionCount(this.address, 'pending');
    this.config.logger?.info(`[NonceCachedWallet] Initialized nonce: ${this.cachedNonce}`);
  }

  /**
   * Get current nonce (lazy load nếu chưa có)
   */
  async getCachedNonce(): Promise<number> {
    if (this.cachedNonce === null) {
      await this.initializeNonce();
    }
    return this.cachedNonce!;
  }

  /**
   * Increment nonce sau khi submit tx thành công
   */
  incrementNonce(): void {
    if (this.cachedNonce !== null) {
      this.cachedNonce++;
      this.config.logger?.debug(`[NonceCachedWallet] Incremented nonce to: ${this.cachedNonce}`);
    }
  }

  /**
   * Sync nonce từ RPC và check mismatch
   */
  async syncNonce(): Promise<void> {
    if (!this.provider) {
      return;
    }

    try {
      const rpcNonce = await this.provider.getTransactionCount(this.address, 'pending');

      if (this.cachedNonce !== null && this.cachedNonce !== rpcNonce) {
        this.config.logger?.warn(
          `[NonceCachedWallet] Mismatch detected! Cached: ${this.cachedNonce}, RPC: ${rpcNonce}. Syncing...`
        );
        this.cachedNonce = rpcNonce;
      } else if (this.cachedNonce === null) {
        // First time sync
        this.cachedNonce = rpcNonce;
        this.config.logger?.info(`[NonceCachedWallet] Synced nonce: ${this.cachedNonce}`);
      }
    } catch (error: any) {
      this.config.logger?.error(`[NonceCachedWallet] Sync failed:`, error.message || error);
    }
  }

  /**
   * Start interval để sync nonce định kỳ
   */
  private startNonceSync(): void {
    this.nonceSyncInterval = setInterval(() => {
      this.syncNonce().catch((err) => {
        this.config.logger?.error(`[NonceCachedWallet] Interval sync error:`, err.message || err);
      });
    }, this.config.syncIntervalMs);

    this.config.logger?.info(
      `[NonceCachedWallet] Sync interval started: ${this.config.syncIntervalMs}ms`
    );
  }

  /**
   * Stop nonce sync interval (cleanup)
   */
  stopNonceSync(): void {
    if (this.nonceSyncInterval) {
      clearInterval(this.nonceSyncInterval);
      this.nonceSyncInterval = undefined;
      this.config.logger?.info('[NonceCachedWallet] Sync interval stopped');
    }
  }

  /**
   * Get current cached nonce value (synchronous, có thể null)
   */
  getCurrentNonce(): number | null {
    return this.cachedNonce;
  }
}

