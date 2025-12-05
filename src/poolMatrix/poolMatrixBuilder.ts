/**
 * Pool Matrix Builder
 * Builds a matrix of all available pools for given tokens
 */

import { ethers } from 'ethers';
import { PoolInfo, PoolMatrix } from './types.js';
import * as CONSTANTS from '../constants.js';

export class PoolMatrixBuilder {
  private factory: ethers.Contract;

  constructor(provider: ethers.Provider) {
    this.factory = new ethers.Contract(
      CONSTANTS.PANCAKE_V3_FACTORY,
      CONSTANTS.FACTORY_ABI,
      provider
    );
  }

  /**
   * Get pool key for a token pair with fee (sorted, lowercase)
   */
  private getPoolKey(token0: string, token1: string, fee: number): string {
    const [t0, t1] = [token0, token1].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );
    return `${t0.toLowerCase()}-${t1.toLowerCase()}-${fee}`;
  }

  /**
   * Find pool address for a token pair with specific fee
   */
  async findPool(
    token0: string,
    token1: string,
    fee: number
  ): Promise<PoolInfo> {
    // Sort tokens (Uniswap V3 requirement)
    const [t0, t1] = [token0, token1].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );

    const poolAddress = await this.factory.getPool(t0, t1, fee);

    return {
      token0: t0,
      token1: t1,
      fee,
      poolAddress,
      exists: poolAddress !== ethers.ZeroAddress,
    };
  }

  /**
   * Build pool matrix for all token pairs
   * Tries all common fees for each pair
   */
  async buildPoolMatrix(
    tokens: string[],
    fees: number[] = [100, 500, 2500, 10000]
  ): Promise<PoolMatrix> {
    const pools = new Map<string, PoolInfo>();
    const tokenSet = new Set<string>(tokens);

    // Generate all token pairs
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < tokens.length; i++) {
      for (let j = i + 1; j < tokens.length; j++) {
        pairs.push([tokens[i], tokens[j]]);
      }
    }

    // Try all fees for each pair (parallel)
    const poolPromises: Promise<PoolInfo>[] = [];
    for (const [token0, token1] of pairs) {
      for (const fee of fees) {
        poolPromises.push(this.findPool(token0, token1, fee));
      }
    }

    const poolResults = await Promise.all(poolPromises);

    // Store pools with key: token0-token1-fee
    for (const poolInfo of poolResults) {
      if (poolInfo.exists) {
        const key = this.getPoolKey(poolInfo.token0, poolInfo.token1, poolInfo.fee);
        pools.set(key, poolInfo);
      }
    }

    return {
      pools,
      tokens: tokenSet,
    };
  }
}

