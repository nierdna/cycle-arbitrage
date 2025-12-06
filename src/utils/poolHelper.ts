/**
 * Pool Helper Utilities
 * Helper functions for getting pool addresses from PancakeSwap V3 Factory
 */

import { ethers } from 'ethers';
import { PANCAKE_V3_FACTORY, FACTORY_ABI } from '../constants.js';

/**
 * Get pool address from token0, token1, and fee
 * 
 * @param provider - Ethers provider (JsonRpcProvider, etc.)
 * @param token0 - First token address
 * @param token1 - Second token address
 * @param fee - Fee tier in bps (100, 500, 2500, 10000)
 * @returns Pool address (or ZeroAddress if pool doesn't exist)
 */
export async function getPoolAddress(
  provider: ethers.Provider,
  token0: string,
  token1: string,
  fee: number
): Promise<string> {
  // Sort tokens (Uniswap V3 requirement: token0 < token1 alphabetically)
  const [t0, t1] = [token0, token1].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );

  // Create factory contract
  const factory = new ethers.Contract(
    PANCAKE_V3_FACTORY,
    FACTORY_ABI,
    provider
  );

  // Get pool address
  const poolAddress = await factory.getPool(t0, t1, fee);
  return poolAddress;
}

/**
 * Get pool address and throw error if pool doesn't exist
 * 
 * @param provider - Ethers provider
 * @param token0 - First token address
 * @param token1 - Second token address
 * @param fee - Fee tier in bps
 * @returns Pool address (throws if pool doesn't exist)
 * @throws Error if pool not found
 */
export async function getPoolAddressOrThrow(
  provider: ethers.Provider,
  token0: string,
  token1: string,
  fee: number
): Promise<string> {
  const poolAddress = await getPoolAddress(provider, token0, token1, fee);

  if (poolAddress === ethers.ZeroAddress) {
    throw new Error(
      `Pool not found for ${token0}/${token1} with fee ${fee} bps`
    );
  }

  return poolAddress;
}

/**
 * Check if pool exists
 * 
 * @param provider - Ethers provider
 * @param token0 - First token address
 * @param token1 - Second token address
 * @param fee - Fee tier in bps
 * @returns true if pool exists, false otherwise
 */
export async function poolExists(
  provider: ethers.Provider,
  token0: string,
  token1: string,
  fee: number
): Promise<boolean> {
  const poolAddress = await getPoolAddress(provider, token0, token1, fee);
  return poolAddress !== ethers.ZeroAddress;
}

