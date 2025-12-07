/**
 * Pool Matrix Builder
 * Builds a matrix of all available pools for given tokens
 */

import { ethers } from 'ethers';
import { PoolInfo, PoolMatrix } from './types.js';
import { computePoolAddress, sortTokens } from '../utils/poolHelper.js';
import { checkPoolLiquidity } from '../utils/poolLiquidityHelper.js';
import { TokenRegistry } from '../tokens/tokenRegistry.js';
import { MIN_POOL_LIQUIDITY_USD } from '../constants.js';
import { PoolExistenceCache } from './poolExistenceCache.js';

export class PoolMatrixBuilder {
  private provider?: ethers.Provider;
  private tokenRegistry?: TokenRegistry;
  private existenceCache: PoolExistenceCache;

  constructor(provider?: ethers.Provider, tokenRegistry?: TokenRegistry) {
    // Provider is optional - only needed if we want to check pool existence/liquidity
    this.provider = provider;
    // TokenRegistry is optional - needed for liquidity checks (decimal cache)
    this.tokenRegistry = tokenRegistry;
    // Initialize pool existence cache
    this.existenceCache = new PoolExistenceCache();
  }

  /**
   * Initialize cache (load from file)
   */
  async initialize(): Promise<void> {
    await this.existenceCache.load();
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
    // Use cache first to avoid repeated RPC calls
    let exists = true;
    if (this.provider) {
      // Check cache first
      const cachedExists = this.existenceCache.get(poolAddress);

      if (cachedExists !== undefined) {
        // Use cached value
        exists = cachedExists;
      } else {
      // Not in cache, fetch from chain
        try {
          const code = await this.provider.getCode(poolAddress);
          exists = code !== '0x' && code.length > 2; // Non-empty code means contract exists

          // Save to cache (async, don't wait)
          await this.existenceCache.set(poolAddress, exists);
        } catch (error) {
          // If check fails, assume pool exists (will be validated later)
          exists = true;
        }
      }
    }

    // Check liquidity if provider and tokenRegistry are available
    // Skip pools with liquidity < $1000
    if (exists && this.provider && this.tokenRegistry) {
      try {
        const decimalCache = this.tokenRegistry.getDecimalCache();
        const liquidityResult = await checkPoolLiquidity(
          this.provider,
          poolAddress,
          t0,  // Pass token0 (already sorted)
          t1,  // Pass token1 (already sorted)
          decimalCache
        );

        // If pool doesn't have enough liquidity, mark as not existing
        if (!liquidityResult.hasEnoughLiquidity) {
          exists = false;
          // Log pool filtered due to insufficient liquidity
          const liquidityMsg = liquidityResult.liquidityUSD !== undefined
            ? ` (liquidity: $${liquidityResult.liquidityUSD.toFixed(2)})`
            : '';
          console.warn(
            `Pool filtered: ${t0.slice(0, 6)}...${t0.slice(-4)}-${t1.slice(0, 6)}...${t1.slice(-4)}, ` +
            `fee: ${fee} bps, address: ${poolAddress}${liquidityMsg} < $${MIN_POOL_LIQUIDITY_USD}`
          );
        }
      } catch (error) {
        // If liquidity check fails, assume pool is OK (skip filter)
        // Error is already logged in checkPoolLiquidity
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

    // Store pools with key: token0-token1-fee and count filtered pools
    let filteredCount = 0;
    for (const poolInfo of poolResults) {
      if (poolInfo.exists) {
        const key = this.getPoolKey(poolInfo.token0, poolInfo.token1, poolInfo.fee);
        pools.set(key, poolInfo);
      } else {
        filteredCount++;
      }
    }

    // Log summary of filtered pools
    if (filteredCount > 0) {
      console.info(`Pool matrix summary: ${pools.size} pools found, ${filteredCount} pools filtered (liquidity < $${MIN_POOL_LIQUIDITY_USD})`);
    }

    return {
      pools,
      tokens: tokenSet,
    };
  }
}

