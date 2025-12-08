/**
 * Token Price Service
 * Background service to update token prices periodically
 */

import { ethers } from 'ethers';
import winston from 'winston';
import { getTokenPriceInUSDT } from '../utils/poolLiquidityHelper.js';
import { DecimalCache } from '../tokens/decimalCache.js';

export class TokenPriceService {
  private priceCache: Map<string, number> = new Map();
  private updateInterval: number;
  private updateTimer?: NodeJS.Timeout;
  private isRunning: boolean = false;
  private provider: ethers.Provider;
  private decimalCache: DecimalCache;
  private tokenAddresses: Set<string> = new Set();
  private logger?: winston.Logger;

  constructor(
    provider: ethers.Provider,
    decimalCache: DecimalCache,
    updateIntervalMs: number = 30000, // Default: 30 seconds
    logger?: winston.Logger
  ) {
    this.provider = provider;
    this.decimalCache = decimalCache;
    this.updateInterval = updateIntervalMs;
    this.logger = logger;
  }

  /**
   * Register token addresses to track
   */
  registerTokens(tokenAddresses: string[]): void {
    for (const address of tokenAddresses) {
      this.tokenAddresses.add(address.toLowerCase());
    }
    this.logger?.debug(`Registered ${tokenAddresses.length} tokens for price tracking`);
  }

  /**
   * Start background price updates
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger?.warn('TokenPriceService is already running');
      return;
    }

    this.isRunning = true;
    
    // Initial update
    await this.updatePrices();

    // Schedule periodic updates
    this.updateTimer = setInterval(async () => {
      if (this.isRunning) {
        await this.updatePrices();
      }
    }, this.updateInterval);

    this.logger?.info(
      `TokenPriceService started (update interval: ${this.updateInterval}ms, tracking ${this.tokenAddresses.size} tokens)`
    );
  }

  /**
   * Stop background updates
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = undefined;
    }

    this.logger?.info('TokenPriceService stopped');
  }

  /**
   * Get token price in USDT
   */
  getPrice(tokenAddress: string): number | null {
    const addressLower = tokenAddress.toLowerCase();
    return this.priceCache.get(addressLower) || null;
  }

  /**
   * Update prices for all registered tokens
   */
  private async updatePrices(): Promise<void> {
    const updates: Promise<void>[] = [];

    for (const tokenAddress of this.tokenAddresses) {
      updates.push(
        (async () => {
          try {
            const price = await getTokenPriceInUSDT(
              this.provider,
              tokenAddress,
              this.decimalCache
            );
            
            if (price !== null && price > 0) {
              this.priceCache.set(tokenAddress, price);
            }
          } catch (error: any) {
            this.logger?.warn(
              `Failed to update price for ${tokenAddress}: ${error.message}`
            );
            // Keep using cached value on error
          }
        })()
      );
    }

    await Promise.all(updates);
    
    const updatedCount = Array.from(this.priceCache.values()).filter(p => p > 0).length;
    this.logger?.debug(`Updated prices for ${updatedCount}/${this.tokenAddresses.size} tokens`);
  }

  /**
   * Check if service is running
   */
  get running(): boolean {
    return this.isRunning;
  }
}

