/**
 * Cycle Discovery Service
 * Handles automatic discovery of arbitrage cycles from token registry
 */

import winston from 'winston';
import { PoolMatrixBuilder } from '../poolMatrix/poolMatrixBuilder.js';
import { PathFinder } from '../poolMatrix/pathFinder.js';
import { TokenRegistry } from '../tokens/tokenRegistry.js';
import { CycleConfig } from '../cycleArbitrage.js';

export interface CycleWithAmounts extends CycleConfig {
  cycleId: string;
  minAmountIn: bigint;
  maxAmountIn: bigint;
}

export class CycleDiscoveryService {
  constructor(
    private poolMatrixBuilder: PoolMatrixBuilder,
    private pathFinder: PathFinder,
    private tokenRegistry: TokenRegistry,
    private logger: winston.Logger
  ) {}

  /**
   * Discover all valid cycles from token registry
   */
  async discoverCycles(
    maxHops: number,
    discoveryFees: number[]
  ): Promise<CycleWithAmounts[]> {
    this.logger.info('=== Auto-Discovery Mode ===');
    const tokenAddresses = this.tokenRegistry.getAllAddresses();
    this.logger.info(`Token list: ${this.tokenRegistry.size} tokens`);
    this.logger.info(`Max hops: ${maxHops}`);
    this.logger.info(`Discovery fees: ${discoveryFees.join(', ')} bps`);

    // Build pool matrix
    this.logger.info('Building pool matrix...');
    const matrix = await this.poolMatrixBuilder.buildPoolMatrix(
      tokenAddresses,
      discoveryFees
    );
    this.logger.info(`Found ${matrix.pools.size} token pairs with pools`);

    // Find all cycles for each token
    this.logger.info('Discovering cycles...');
    const allCycles: CycleConfig[] = [];
    const seenCycles = new Set<string>();

    for (const tokenAddress of tokenAddresses) {
      const cycles = this.pathFinder.findAllCycles(matrix, tokenAddress, maxHops);

      for (const candidate of cycles) {
        // Validate cycle
        if (!this.pathFinder.validateCycle(candidate, matrix)) {
          continue;
        }

        // Deduplicate
        const cycleKey = this.getCycleKey(candidate);
        if (seenCycles.has(cycleKey)) {
          continue;
        }
        seenCycles.add(cycleKey);

        // Convert to CycleConfig
        allCycles.push({
          tokens: candidate.tokens,
          addresses: candidate.addresses,
          fees: candidate.fees,
        });
      }
    }

    this.logger.info(`Discovered ${allCycles.length} valid cycles`);

    // Register cycles with amount configs
    const cyclesWithAmounts: CycleWithAmounts[] = [];

    for (const cycle of allCycles) {
      const cycleId = this.getCycleId(cycle);
      const startTokenAddress = cycle.addresses[0].toLowerCase();

      // Get amount config from token registry (required)
      const token = this.tokenRegistry.getToken(startTokenAddress);
      if (!token?.amountConfig) {
        this.logger.warn(
          `Token ${startTokenAddress} does not have amountConfig. ` +
          `Cycle ${cycleId} will be skipped. Please add amountConfig to token in TokenRegistry.`
        );
        continue; // Skip cycles without amount config
      }

      // Priority: cycle.minAmountIn > tokenRegistry.getTokenAmountConfig(startToken)
      const minAmountIn = cycle.minAmountIn ?? token.amountConfig.minAmountIn;
      const maxAmountIn = cycle.maxAmountIn ?? token.amountConfig.maxAmountIn;

      cyclesWithAmounts.push({
        ...cycle,
        cycleId,
        minAmountIn,
        maxAmountIn,
      });
    }

    return cyclesWithAmounts;
  }

  /**
   * Generate unique ID for cycle using token names
   */
  getCycleId(cycle: CycleConfig): string {
    // Convert token addresses to names
    const tokenNames = cycle.addresses.map((address) => {
      const token = this.tokenRegistry.getToken(address.toLowerCase());
      if (!token?.name) {
        throw new Error(`Token ${address} does not have a name in TokenRegistry`);
      }
      return token.name;
    });
    return `${tokenNames.join('-')}-${cycle.fees.join('-')}`;
  }

  /**
   * Generate unique key for deduplication
   */
  private getCycleKey(candidate: { tokens: string[]; fees: number[] }): string {
    return `${candidate.tokens.join('-')}-${candidate.fees.join('-')}`;
  }
}

