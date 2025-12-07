/**
 * Pool Helper Utilities
 * Helper functions for getting pool addresses from PancakeSwap V3 Factory
 */

import { ethers } from 'ethers';
import { PANCAKE_V3_FACTORY, PANCAKE_V3_POOL_DEPLOYER, V3_INIT_CODE_HASH, FACTORY_ABI } from '../constants.js';

/**
 * Sort two token addresses to ensure token0 < token1 (uint160 comparison)
 * This matches the sorting logic used in PancakeSwap V3 contracts
 * 
 * @param tokenA - First token address
 * @param tokenB - Second token address
 * @returns Sorted token addresses [token0, token1] where token0 < token1
 */
export function sortTokens(tokenA: string, tokenB: string): [string, string] {
  // Compare addresses as uint160 (BigInt) - same as Solidity address comparison
  const addrA = BigInt(tokenA);
  const addrB = BigInt(tokenB);
  return addrA < addrB ? [tokenA, tokenB] : [tokenB, tokenA];
}

/**
 * Compute pool address off-chain using CREATE2 (no on-chain call)
 * Based on PancakeSwap V3 PoolDeployer logic
 * 
 * @param token0 - First token address (will be sorted)
 * @param token1 - Second token address (will be sorted)
 * @param fee - Fee tier in bps (100, 500, 2500, 10000)
 * @returns Computed pool address (may not exist if pool hasn't been deployed)
 */
export function computePoolAddress(
  token0: string,
  token1: string,
  fee: number
): string {
  // Sort tokens (token0 < token1) - compare addresses as uint160 (BigInt)
  const [t0, t1] = sortTokens(token0, token1);

  // Compute salt: keccak256(abi.encode(token0, token1, fee))
  const salt = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'address', 'uint24'],
      [t0, t1, fee]
    )
  );

  // Compute CREATE2 address:
  // address = keccak256(0xff || deployer || salt || initCodeHash)[12:]
  const initCodeHash = V3_INIT_CODE_HASH;
  const deployer = PANCAKE_V3_POOL_DEPLOYER;

  const create2Input = ethers.concat([
    '0xff',
    deployer,
    salt,
    initCodeHash,
  ]);

  const hash = ethers.keccak256(create2Input);

  // Take last 20 bytes (40 hex chars) as address
  // Convert to checksum address
  const address = '0x' + hash.slice(-40);
  return ethers.getAddress(address);
}

/**
 * Get pool address from token0, token1, and fee (on-chain call)
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
 * Get pool address using off-chain computation (faster, no RPC call)
 * Falls back to on-chain call if pool might not exist
 * 
 * @param token0 - First token address
 * @param token1 - Second token address
 * @param fee - Fee tier in bps (100, 500, 2500, 10000)
 * @returns Computed pool address
 */
export function getPoolAddressOffChain(
  token0: string,
  token1: string,
  fee: number
): string {
  return computePoolAddress(token0, token1, fee);
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

