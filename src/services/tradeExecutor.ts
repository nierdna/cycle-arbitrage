/**
 * Trade Executor Service
 * Handles execution of arbitrage trades and result analysis
 */

import { ethers } from 'ethers';
import winston from 'winston';
import * as CONSTANTS from '../constants.js';
import { CycleWithState } from '../cycleArbitrage.js';
import { MetricsCollector } from '../monitoring/metrics.js';

export class TradeExecutor {
  constructor(
    private router: ethers.Contract,
    private wallet: ethers.Wallet,
    private logger: winston.Logger,
    private metrics?: MetricsCollector
  ) {}

  /**
   * Execute arbitrage trade for a specific cycle
   */
  async executeCycle(
    cycleId: string,
    cycle: CycleWithState,
    amountIn: bigint,
    estimatedOut: bigint
  ): Promise<void> {
    try {
      // Apply slippage (10 bps)
      const minAmountOut = (estimatedOut * BigInt(9990)) / BigInt(10000);

      // Encode swap path
      const path = this.encodeSwapPath(cycle.addresses, cycle.fees);

      this.logger.info(`[${cycleId}] Executing swap...`);

      // Execute swap
      const tx = await this.router.swapExactInput({
        path,
        recipient: this.wallet.address,
        deadline: Math.floor(Date.now() / 1000) + 60, // 60 seconds
        amountIn,
        amountOutMinimum: minAmountOut,
      });

      this.logger.info(`[${cycleId}] TX hash: ${tx.hash}`);
      const receipt = await tx.wait();
      this.logger.info(`[${cycleId}] ✓ Swap confirmed: ${receipt.hash}`);

      // Analyze result
      const profit = await this.analyze(receipt, amountIn);

      // Record execution
      if (profit !== null) {
        this.metrics?.recordExecution(cycleId, profit);
      }
    } catch (error: any) {
      this.logger.error(`[${cycleId}] ✗ Execution failed:`, error.message || error);
    }
  }

  /**
   * Analyze trade result
   * Returns profit amount (bigint) or null if parsing failed
   */
  private async analyze(receipt: any, amountIn: bigint): Promise<bigint | null> {
    try {
      // Parse Swap events from receipt
      const actualOut = await this.parseReceiptAmounts(receipt);
      const profit = actualOut - amountIn;
      const profitBps = Number((profit * BigInt(1e4)) / amountIn);

      this.logger.info('Trade Analysis:', {
        profitBps: profitBps.toFixed(2),
        actualOut: ethers.formatEther(actualOut),
        actualProfit: ethers.formatEther(profit),
      });

      return profit;
    } catch (error) {
      this.logger.error('⚠ Could not parse receipt:', error);
      return null;
    }
  }

  /**
   * Encode V3 swap path: token0 (20 bytes) + fee (3 bytes) + token1 (20 bytes) ...
   */
  private encodeSwapPath(addresses: string[], fees: number[]): string {
    if (addresses.length < 2 || fees.length !== addresses.length - 1) {
      throw new Error('Invalid path: addresses and fees mismatch');
    }

    let path = '0x';
    for (let i = 0; i < fees.length; i++) {
      // Address (20 bytes, remove 0x)
      path += addresses[i].slice(2).toLowerCase();
      // Fee (3 bytes, big-endian, hex)
      path += fees[i].toString(16).padStart(6, '0');
    }
    // Last address
    path += addresses[addresses.length - 1].slice(2).toLowerCase();

    return path;
  }

  /**
   * Parse receipt to get actual output amount
   * Simplified version - gets last swap event's amountOut
   */
  private async parseReceiptAmounts(receipt: any): Promise<bigint> {
    // Find Swap events
    const swapLogs = receipt.logs.filter(
      (log: any) => log.topics[0] === CONSTANTS.SWAP_EVENT_TOPIC
    );

    if (swapLogs.length === 0) {
      throw new Error('No Swap events found in receipt');
    }

    // Get the last swap (final output)
    const lastSwap = swapLogs[swapLogs.length - 1];

    // Decode the data field
    // Swap event data: amount0, amount1, sqrtPriceX96, liquidity, tick, fee0, fee1
    const poolInterface = new ethers.Interface(CONSTANTS.POOL_SWAP_ABI);
    const decoded = poolInterface.parseLog({
      topics: lastSwap.topics,
      data: lastSwap.data,
    });

    if (!decoded) {
      throw new Error('Could not decode swap event');
    }

    // Get the output amount (positive value)
    const amount0 = decoded.args[2] as bigint;
    const amount1 = decoded.args[3] as bigint;

    // Output is the positive amount
    const actualOut = amount0 > 0n ? amount0 : amount1;

    return actualOut > 0n ? actualOut : -actualOut; // Ensure positive
  }
}

