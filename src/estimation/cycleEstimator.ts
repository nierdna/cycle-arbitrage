/**
 * Cycle Estimator
 * Responsible for estimating arbitrage amounts and calculating BPS
 * Single Responsibility: Estimation logic only
 */

import { QuoterV3, StateFetcher } from 'uniswap-v3-quoter';
import winston from 'winston';
import { CycleWithState } from '../cycleArbitrage.js';

export class CycleEstimator {
  constructor(
    private stateFetcher: StateFetcher,
    private quoter: QuoterV3,
    private cycles: Map<string, CycleWithState>,
    private logger: winston.Logger
  ) {}

  /**
   * Estimate amount out for a specific cycle (multi-hop)
   * Fee is already handled by QuoterV3 internally
   */
  async estimateAmountOutForCycle(cycleId: string, amountIn: bigint): Promise<bigint> {
    // Validate inputs
    if (amountIn <= 0n) {
      throw new Error(`Invalid amountIn: ${amountIn}. Must be greater than 0.`);
    }

    const cycle = this.cycles.get(cycleId);
    if (!cycle) {
      throw new Error(`Cycle not found: ${cycleId}`);
    }

    // Validate cycle configuration
    if (cycle.poolAddresses.length !== cycle.tokens.length - 1) {
      throw new Error(
        `Cycle ${cycleId} has invalid configuration: ` +
        `${cycle.poolAddresses.length} pool addresses but ${cycle.tokens.length - 1} hops expected.`
      );
    }

    if (cycle.addresses.length !== cycle.tokens.length) {
      throw new Error(
        `Cycle ${cycleId} has invalid configuration: ` +
        `${cycle.addresses.length} addresses but ${cycle.tokens.length} tokens expected.`
      );
    }

    let amountOut = amountIn;

    try {
      // Iterate through each hop
      for (let i = 0; i < cycle.tokens.length - 1; i++) {
        const poolAddress = cycle.poolAddresses[i];
        const tokenIn = cycle.addresses[i];
        const tokenOut = cycle.addresses[i + 1];

        // Validate pool address
        if (!poolAddress || poolAddress.length !== 42 || !poolAddress.startsWith('0x')) {
          throw new Error(
            `Invalid pool address at hop ${i + 1} for cycle ${cycleId}: ${poolAddress}`
          );
        }

        // Get pool state from cache (sync - already fetched in initialize)
        const poolState = this.stateFetcher.getPoolState(poolAddress);
        if (!poolState) {
          throw new Error(
            `Pool state not found in cache: ${poolAddress}. ` +
            `Cycle: ${cycleId}, Hop: ${i + 1}. ` +
            `Make sure initialize() was called and pool state is available.`
          );
        }

        const zeroForOne = poolState.token0.toLowerCase() === tokenIn.toLowerCase();

        // Quote single hop (fee handled internally by QuoterV3)
        // This may throw if pool state is stale or invalid
        try {
          amountOut = await this.quoter.quoteExactInputSingle(
            poolAddress,
            zeroForOne,
            amountOut
          );

          // Validate quote result
          if (amountOut <= 0n) {
            throw new Error(
              `Invalid quote result at hop ${i + 1} for cycle ${cycleId}: ` +
              `amountOut is ${amountOut} (non-positive)`
            );
          }
        } catch (error: any) {
          const errorMessage = error?.message || String(error);
          throw new Error(
            `Failed to quote hop ${i + 1} for cycle ${cycleId}: ${errorMessage}. ` +
            `Pool: ${poolAddress}, TokenIn: ${tokenIn}, TokenOut: ${tokenOut}, AmountIn: ${amountOut}`
          );
        }
      }
    } catch (error: any) {
      // Log error with context
      this.logger.error(
        `Failed to estimate amount out for cycle ${cycleId}:`,
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }

    return amountOut;
  }

  /**
   * Calculate arbitrage BPS for a given amountIn
   * Used by AmountOptimizer
   */
  async calculateArbitrageBps(cycleId: string, amountIn: bigint): Promise<number> {
    const amountOut = await this.estimateAmountOutForCycle(cycleId, amountIn);
    return Number(
      ((amountOut - amountIn) * BigInt(1e4)) / amountIn
    );
  }
}

