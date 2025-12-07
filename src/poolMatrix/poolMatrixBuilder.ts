/**
 * Pool Matrix Builder
 * Builds a matrix of all available pools for given tokens
 */

import { ethers } from 'ethers';
import { PoolInfo, PoolMatrix } from './types.js';
import { computePoolAddress, sortTokens } from '../utils/poolHelper.js';

export class PoolMatrixBuilder {
  private provider?: ethers.Provider;

  constructor(provider?: ethers.Provider) {
    // Provider is optional - only needed if we want to check pool existence
    this.provider = provider;
  }

  /**
   * Get pool key for a token pair with fee (sorted using BigInt comparison)
   */
  private getPoolKey(token0: string, token1: string, fee: number): string {
    const [t0, t1] = sortTokens(token0, token1);
    return `${t0.toLowerCase()}-${t1.toLowerCase()}-${fee}`;
  }

  /**
   * Find pool address for a token pair with specific fee (off-chain computation)
   * Uses CREATE2 to compute pool address without on-chain call
   * 
   * Note: This computes the address but doesn't verify pool exists.
   * Pool existence will be validated when actually used (fetching state, swapping, etc.)
   */
  async findPool(
    token0: string,
    token1: string,
    fee: number
  ): Promise<PoolInfo> {
    // Sort tokens (token0 < token1) using BigInt comparison (same as computePoolAddress)
    const [t0, t1] = sortTokens(token0, token1);

    // Compute pool address off-chain using CREATE2
    const poolAddress = computePoolAddress(t0, t1, fee);

    // Check if pool exists by verifying code size (optional)
    let exists = true;
    if (this.provider) {
      try {
        const code = await this.provider.getCode(poolAddress);
        exists = code !== '0x' && code.length > 2; // Non-empty code means contract exists
      } catch (error) {
        // If check fails, assume pool exists (will be validated later)
        exists = true;
      }
    }

    return {
      token0: t0,
      token1: t1,
      fee,
      poolAddress,
      exists,
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

