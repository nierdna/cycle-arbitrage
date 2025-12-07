/**
 * Pool Address Resolver
 * Responsible for resolving pool addresses for cycles
 * Single Responsibility: Pool address resolution only
 */

import winston from 'winston';
import { computePoolAddress } from '../utils/poolHelper.js';
import { CycleWithState } from '../cycleArbitrage.js';
import { CycleFormatter } from '../services/cycleFormatter.js';

export class PoolAddressResolver {
  constructor(
    private logger: winston.Logger,
    private formatter: CycleFormatter
  ) {}

  /**
   * Resolve pool addresses for a single cycle
   */
  resolvePoolAddresses(cycle: CycleWithState): string[] {
    const poolAddresses: string[] = [];

    for (let i = 0; i < cycle.tokens.length - 1; i++) {
      const poolAddress = this.getPoolAddress(
        cycle.addresses[i],
        cycle.addresses[i + 1],
        cycle.fees[i]
      );
      poolAddresses.push(poolAddress);
    }

    return poolAddresses;
  }

  /**
   * Resolve pool addresses for all cycles and update them
   */
  resolveAllPoolAddresses(cycles: Map<string, CycleWithState>): void {
    this.logger.info('Fetching pool addresses...');
    
    for (const [cycleId, cycle] of cycles.entries()) {
      const tokensPath = this.formatter.formatCyclePath(cycle.tokens);
      this.logger.info(`Cycle: ${tokensPath} (${cycleId})`);
      
      cycle.poolAddresses = this.resolvePoolAddresses(cycle);
      
      // Log pool addresses
      for (let i = 0; i < cycle.poolAddresses.length; i++) {
        this.logger.info(`  Pool ${i + 1}: ${cycle.poolAddresses[i]}`);
      }
    }
  }

  /**
   * Get pool address using off-chain CREATE2 computation (no on-chain call)
   * This is much faster than calling factory.getPool() on-chain
   * 
   * Note: This computes the address but doesn't verify the pool exists.
   * The address will be valid if the pool has been deployed.
   */
  private getPoolAddress(
    token0: string,
    token1: string,
    fee: number
  ): string {
    return computePoolAddress(token0, token1, fee);
  }
}

