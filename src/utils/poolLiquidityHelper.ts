/**
 * Pool Liquidity Helper
 * Helper functions for checking pool liquidity and calculating token prices
 */

import { ethers } from 'ethers';
import { USDT_ADDRESS, ERC20_ABI, MIN_POOL_LIQUIDITY_USD } from '../constants.js';
import { computePoolAddress, sortTokens } from './poolHelper.js';
import { DecimalCache } from '../tokens/decimalCache.js';
import { RateLimiter } from './rateLimiter.js';

/**
 * Price cache for tokens (to avoid repeated price lookups)
 */
interface PriceCache {
  tokenAddress: string;
  price: number; // Price in USDT
  timestamp: number;
}

const PRICE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const priceCache: Map<string, PriceCache> = new Map();

// Rate limiter for RPC calls (max 100 requests/second: 50 concurrent with 10ms delay)
const rateLimiter = new RateLimiter(50, 10);

/**
 * Find USDT-Token pool address with fallback fees
 * Tries fees in order: [100, 500, 2500]
 * 
 * @param provider - Ethers provider
 * @param tokenAddress - Token address
 * @returns Pool address or null if not found
 */
async function findUSDTPricePool(
  provider: ethers.Provider,
  tokenAddress: string
): Promise<string | null> {
  const feesToTry = [100, 500, 2500];
  
  for (const fee of feesToTry) {
    const poolAddress = computePoolAddress(USDT_ADDRESS, tokenAddress, fee);
    
    // Check if pool exists (with rate limiting)
    try {
      const code = await rateLimiter.execute(() => provider.getCode(poolAddress));
      if (code !== '0x' && code.length > 2) {
        return poolAddress;
      }
    } catch (error) {
      // Continue to next fee
      continue;
    }
  }
  
  return null;
}

/**
 * Get token price in USDT from pool balances
 * Uses cached price if available
 * 
 * @param provider - Ethers provider
 * @param tokenAddress - Token address
 * @param decimalCache - Decimal cache for token decimals
 * @returns Token price in USDT (e.g., 600 for BNB if BNB = $600)
 */
export async function getTokenPriceInUSDT(
  provider: ethers.Provider,
  tokenAddress: string,
  decimalCache: DecimalCache
): Promise<number | null> {
  const tokenLower = tokenAddress.toLowerCase();
  const usdtLower = USDT_ADDRESS.toLowerCase();

  // If token is USDT itself, return 1.0
  if (tokenLower === usdtLower) {
    return 1.0;
  }

  // Check cache first
  const cached = priceCache.get(tokenLower);
  if (cached && Date.now() - cached.timestamp < PRICE_CACHE_TTL) {
    return cached.price;
  }

  // Find USDT-Token pool
  const poolAddress = await findUSDTPricePool(provider, tokenAddress);
  if (!poolAddress) {
    return null;
  }

  try {
    // Use sortTokens to determine token0 and token1 (off-chain, no RPC call)
    const [t0, t1] = sortTokens(USDT_ADDRESS, tokenAddress);
    
    // Determine which is USDT and which is the token
    const usdtLower = USDT_ADDRESS.toLowerCase();
    const usdtAddress = t0.toLowerCase() === usdtLower ? t0 : t1;
    const otherTokenAddress = t0.toLowerCase() === usdtLower ? t1 : t0;

    // Get balances (with rate limiting)
    const usdtContract = new ethers.Contract(usdtAddress, ERC20_ABI, provider);
    const tokenContract = new ethers.Contract(otherTokenAddress, ERC20_ABI, provider);
    
    const [usdtBalance, tokenBalance] = await Promise.all([
      rateLimiter.execute(() => usdtContract.balanceOf(poolAddress)),
      rateLimiter.execute(() => tokenContract.balanceOf(poolAddress)),
    ]);

    // Get decimals
    const [usdtDecimals, tokenDecimals] = await Promise.all([
      decimalCache.getDecimals(usdtAddress),
      decimalCache.getDecimals(otherTokenAddress),
    ]);

    // Normalize balances
    const usdtAmount = Number(ethers.formatUnits(usdtBalance, usdtDecimals));
    const tokenAmount = Number(ethers.formatUnits(tokenBalance, tokenDecimals));

    if (tokenAmount === 0) {
      return null;
    }

    // Calculate price: price = USDT balance / Token balance
    // This gives price in USDT per token
    const price = usdtAmount / tokenAmount;

    // Cache the price
    priceCache.set(tokenLower, {
      tokenAddress: tokenLower,
      price,
      timestamp: Date.now(),
    });

    return price;
  } catch (error: any) {
    console.warn(`Failed to get price for ${tokenAddress}: ${error.message}`);
    return null;
  }
}

/**
 * Result of liquidity check
 */
export interface LiquidityCheckResult {
  hasEnoughLiquidity: boolean;
  liquidityUSD?: number; // Only present if check succeeded
}

/**
 * Check if pool has enough liquidity (>= $1000)
 * 
 * @param provider - Ethers provider
 * @param poolAddress - Pool contract address
 * @param token0 - Token0 address (already sorted)
 * @param token1 - Token1 address (already sorted)
 * @param decimalCache - Decimal cache for token decimals
 * @returns LiquidityCheckResult with hasEnoughLiquidity and liquidityUSD
 */
export async function checkPoolLiquidity(
  provider: ethers.Provider,
  poolAddress: string,
  token0: string,
  token1: string,
  decimalCache: DecimalCache
): Promise<LiquidityCheckResult> {
  try {
    // Ensure tokens are sorted (defensive)
    const [t0, t1] = sortTokens(token0, token1);

    // Get balances (with rate limiting)
    const token0Contract = new ethers.Contract(t0, ERC20_ABI, provider);
    const token1Contract = new ethers.Contract(t1, ERC20_ABI, provider);
    
    const [balance0, balance1] = await Promise.all([
      rateLimiter.execute(() => token0Contract.balanceOf(poolAddress)),
      rateLimiter.execute(() => token1Contract.balanceOf(poolAddress)),
    ]);

    // Get decimals
    const [decimals0, decimals1] = await Promise.all([
      decimalCache.getDecimals(t0),
      decimalCache.getDecimals(t1),
    ]);

    // Normalize balances
    const amount0 = Number(ethers.formatUnits(balance0, decimals0));
    const amount1 = Number(ethers.formatUnits(balance1, decimals1));

    // Get prices for both tokens
    const [price0, price1] = await Promise.all([
      getTokenPriceInUSDT(provider, t0, decimalCache),
      getTokenPriceInUSDT(provider, t1, decimalCache),
    ]);

    // If we can't get prices, skip the check (assume OK)
    if (price0 === null || price1 === null) {
      return { hasEnoughLiquidity: true }; // Skip check if price unavailable
    }

    // Calculate total liquidity in USD
    const liquidityUSD = (amount0 * price0) + (amount1 * price1);

    // Check against threshold
    return {
      hasEnoughLiquidity: liquidityUSD >= MIN_POOL_LIQUIDITY_USD,
      liquidityUSD
    };
  } catch (error: any) {
    // If check fails, assume OK (skip filter)
    console.warn(`Failed to check liquidity for pool ${poolAddress}: ${error.message}`);
    return { hasEnoughLiquidity: true };
  }
}

