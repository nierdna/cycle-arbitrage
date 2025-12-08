/**
 * Gas Price Service
 * Background service to update gas price periodically
 */

import { ethers } from 'ethers';
import winston from 'winston';

export class GasPriceService {
  private currentGasPrice: bigint = ethers.parseUnits('3', 'gwei'); // Default: 3 gwei
  private updateInterval: number;
  private updateTimer?: NodeJS.Timeout;
  private isRunning: boolean = false;
  private provider: ethers.Provider;
  private logger?: winston.Logger;

  constructor(
    provider: ethers.Provider,
    updateIntervalMs: number = 5000, // Default: 5 seconds
    logger?: winston.Logger
  ) {
    this.provider = provider;
    this.updateInterval = updateIntervalMs;
    this.logger = logger;
  }

  /**
   * Start background gas price updates
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger?.warn('GasPriceService is already running');
      return;
    }

    this.isRunning = true;
    
    // Initial update
    await this.updateGasPrice();

    // Schedule periodic updates
    this.updateTimer = setInterval(async () => {
      if (this.isRunning) {
        await this.updateGasPrice();
      }
    }, this.updateInterval);

    this.logger?.info(`GasPriceService started (update interval: ${this.updateInterval}ms)`);
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

    this.logger?.info('GasPriceService stopped');
  }

  /**
   * Get current gas price
   */
  getGasPrice(): bigint {
    return this.currentGasPrice;
  }

  /**
   * Update gas price from provider
   */
  private async updateGasPrice(): Promise<void> {
    try {
      const feeData = await this.provider.getFeeData();
      
      // Use maxFeePerGas if available (EIP-1559), otherwise use gasPrice
      if (feeData.maxFeePerGas) {
        this.currentGasPrice = feeData.maxFeePerGas;
      } else if (feeData.gasPrice) {
        this.currentGasPrice = feeData.gasPrice;
      } else {
        // Fallback to default
        this.currentGasPrice = ethers.parseUnits('3', 'gwei');
      }

      this.logger?.debug(
        `Gas price updated: ${ethers.formatUnits(this.currentGasPrice, 'gwei')} gwei`
      );
    } catch (error: any) {
      this.logger?.warn(`Failed to update gas price: ${error.message}. Using cached value.`);
      // Keep using current value on error
    }
  }

  /**
   * Check if service is running
   */
  get running(): boolean {
    return this.isRunning;
  }
}

