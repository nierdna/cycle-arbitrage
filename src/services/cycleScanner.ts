/**
 * Cycle Scanner Service
 * Handles continuous scanning of a single cycle for arbitrage opportunities
 */

import { ethers } from 'ethers';
import winston from 'winston';
import { EventEmitter } from 'events';
import { AmountOptimizer } from '../optimization/amountOptimizer.js';
import { CycleWithState } from '../cycleArbitrage.js';
import { CycleFormatter } from './cycleFormatter.js';

export interface ScanOptions {
  minArbitrageBps: number;
  scanIntervalMs: number;
  amountIn: bigint;
  optimizeAmountIn: boolean;
  optimizationInterval: number;
  optimizationPrecision: bigint;
}

export interface ScanResult {
  arbitrageBps: number;
  amountIn: bigint;
  amountOut: bigint;
  optimalAmountIn?: bigint;
  optimalArbBps?: number;
}

export class CycleScanner extends EventEmitter {
  private scanCount = 0;
  private currentAmountIn: bigint;
  private optimalAmountIn: bigint;
  private optimalArbBps = 0;
  private isRunning: boolean = false;

  constructor(
    private cycleId: string,
    private cycle: CycleWithState,
    private estimateAmountOut: (cycleId: string, amountIn: bigint) => Promise<bigint>,
    private options: ScanOptions,
    private amountOptimizer?: AmountOptimizer,
    private logger?: winston.Logger,
    private formatter?: CycleFormatter
  ) {
    super(); // Call EventEmitter constructor
    this.currentAmountIn = options.amountIn;
    this.optimalAmountIn = options.amountIn;
  }

  /**
   * Start scanning cycle continuously
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger?.warn(`[${this.cycleId}] Scanner is already running`);
      return;
    }

    this.isRunning = true;
    const minAmountIn = this.cycle.minAmountIn;
    const maxAmountIn = this.cycle.maxAmountIn;

    // Initial optimization if enabled
    if (this.options.optimizeAmountIn && this.amountOptimizer && this.isRunning) {
      try {
      await this.performInitialOptimization(minAmountIn, maxAmountIn);
      } catch (error) {
        this.logger?.error(`[${this.cycleId}] Initial optimization failed:`, error);
      }
    }

    // Continuous scanning loop
    while (this.isRunning) {
      try {
        await this.performScan(minAmountIn, maxAmountIn);
        
        // Check if still running before sleeping
        if (this.isRunning) {
        await this.sleep(this.options.scanIntervalMs);
        }
      } catch (error) {
        this.logger?.error(`[${this.cycleId}] Scan error:`, error);
        
        // Only sleep if still running
        if (this.isRunning) {
        await this.sleep(5000);
      }
    }
    }

    this.logger?.info(`[${this.cycleId}] Scanner stopped`);
  }

  /**
   * Stop scanning gracefully
   */
  stop(): void {
    if (!this.isRunning) {
      this.logger?.warn(`[${this.cycleId}] Scanner is not running`);
      return;
    }

    this.logger?.info(`[${this.cycleId}] Stopping scanner...`);
    this.isRunning = false;
    this.emit('stopped', { cycleId: this.cycleId });
  }

  /**
   * Check if scanner is running
   */
  get running(): boolean {
    return this.isRunning;
  }

  /**
   * Perform initial optimization
   */
  private async performInitialOptimization(
    minAmountIn: bigint,
    maxAmountIn: bigint
  ): Promise<void> {
    if (!this.amountOptimizer || !this.logger) return;

    this.logger.info(
      `[${this.cycleId}] Finding optimal amountIn (range: ${ethers.formatEther(minAmountIn)} - ${ethers.formatEther(maxAmountIn)})...`
    );

    try {
      const optimal = await this.amountOptimizer.findOptimalAmountIn(
        this.cycleId,
        minAmountIn,
        maxAmountIn,
        this.options.optimizationPrecision
      );
      this.optimalAmountIn = optimal.amountIn;
      this.optimalArbBps = optimal.arbitrageBps;
      this.currentAmountIn = this.optimalAmountIn;

      // Emit optimization result event
      this.emit('optimization-result', {
        cycleId: this.cycleId,
        amountIn: this.optimalAmountIn,
        arbitrageBps: this.optimalArbBps,
      });

      this.logger.info(
        `[${this.cycleId}] Optimal: ${ethers.formatEther(this.optimalAmountIn)} tokens, ` +
        `arb: ${this.optimalArbBps.toFixed(2)} bps`
      );
    } catch (error) {
      this.logger.error(`[${this.cycleId}] Optimization failed:`, error);
      this.logger.info(
        `[${this.cycleId}] Using default amountIn: ${ethers.formatEther(this.options.amountIn)}`
      );
    }
  }

  /**
   * Perform a single scan iteration
   */
  private async performScan(
    minAmountIn: bigint,
    maxAmountIn: bigint
  ): Promise<void> {
    // Emit scan event
    this.emit('scan', { cycleId: this.cycleId });

    // Re-optimize periodically if enabled
    if (
      this.options.optimizeAmountIn &&
      this.amountOptimizer &&
      this.scanCount > 0 &&
      this.scanCount % this.options.optimizationInterval === 0
    ) {
      await this.performPeriodicOptimization(minAmountIn, maxAmountIn);
    }

    // Estimate amount out
    const amountOut = await this.estimateAmountOut(this.cycleId, this.currentAmountIn);

    // Calculate arbitrage in bps
    const arbitrageBps = Number(
      ((amountOut - this.currentAmountIn) * BigInt(1e4)) / this.currentAmountIn
    );

    this.scanCount++;

    // Emit arbitrage BPS event for historical chart (every 1000 scans)
    if (this.scanCount % 1000 === 0) {
      this.emit('arbitrage-bps', {
        cycleId: this.cycleId,
        arbitrageBps,
      });
    }

    // Check for opportunity
    if (arbitrageBps > this.options.minArbitrageBps) {
      const result: ScanResult = {
        arbitrageBps,
        amountIn: this.currentAmountIn,
        amountOut,
        optimalAmountIn: this.options.optimizeAmountIn ? this.optimalAmountIn : undefined,
        optimalArbBps: this.options.optimizeAmountIn ? this.optimalArbBps : undefined,
      };

      await this.handleOpportunity(result);
    } else if (this.scanCount % 1000 === 0) {
      this.logger?.info(
        `[${this.cycleId}] Scanning... ` +
        `(arb: ${arbitrageBps.toFixed(2)} bps, amount: ${ethers.formatEther(this.currentAmountIn)}, scans: ${this.scanCount})`
      );
    }
  }

  /**
   * Perform periodic re-optimization
   */
  private async performPeriodicOptimization(
    minAmountIn: bigint,
    maxAmountIn: bigint
  ): Promise<void> {
    if (!this.amountOptimizer || !this.logger) return;

    try {
      const optimal = await this.amountOptimizer.findOptimalAmountIn(
        this.cycleId,
        minAmountIn,
        maxAmountIn,
        this.options.optimizationPrecision
      );

      if (optimal.arbitrageBps > this.optimalArbBps) {
        this.optimalAmountIn = optimal.amountIn;
        this.optimalArbBps = optimal.arbitrageBps;
        this.currentAmountIn = this.optimalAmountIn;

        // Emit optimization result event
        this.emit('optimization-result', {
          cycleId: this.cycleId,
          amountIn: this.optimalAmountIn,
          arbitrageBps: this.optimalArbBps,
        });

        this.logger.info(
          `[${this.cycleId}] Re-optimized: ${ethers.formatEther(this.optimalAmountIn)} tokens, ` +
          `arb: ${this.optimalArbBps.toFixed(2)} bps`
        );
      }
    } catch (error) {
      this.logger.error(`[${this.cycleId}] Re-optimization failed:`, error);
    }
  }

  /**
   * Handle detected arbitrage opportunity
   */
  private async handleOpportunity(result: ScanResult): Promise<void> {
    if (!this.logger || !this.formatter) return;

    // Estimate optimalAmountOut nếu có optimalAmountIn
    let optimalAmountOut: bigint | undefined;
    if (result.optimalAmountIn) {
      optimalAmountOut = await this.estimateAmountOut(
        this.cycleId,
        result.optimalAmountIn
      );
    }

    // Emit opportunity event with full data
    this.emit('opportunity', {
      cycleId: this.cycleId,
      arbitrageBps: result.arbitrageBps,
      amountIn: result.amountIn,
      amountOut: result.amountOut,
      optimalAmountIn: result.optimalAmountIn,
      optimalAmountOut: optimalAmountOut,
      optimalArbBps: result.optimalArbBps,
    });

    const timestamp = new Date().toISOString();
    const cyclePath = this.formatter.formatCyclePath(this.cycle.tokens);

    this.logger.info('🎯 Arbitrage detected!', {
      cycle: cyclePath,
      cycleId: this.cycleId,
      arbitrageBps: result.arbitrageBps.toFixed(2),
      amountIn: ethers.formatEther(result.amountIn),
      amountOut: ethers.formatEther(result.amountOut),
      profit: ethers.formatEther(result.amountOut - result.amountIn),
      optimalAmount: result.optimalAmountIn
        ? ethers.formatEther(result.optimalAmountIn)
        : undefined,
      optimalArbBps: result.optimalArbBps?.toFixed(2),
      timestamp,
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

