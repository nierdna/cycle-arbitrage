/**
 * Pool Liquidity Helper
 * Helper functions for checking pool liquidity and calculating token prices
 */

import { ethers } from 'ethers';
import { USDT_ADDRESS, ERC20_ABI, POOL_ABI, MIN_POOL_LIQUIDITY_USD } from '../constants.js';
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
 * Get token price in USDT from pool sqrtPriceX96 (Uniswap V3)
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
    const tokenLower = tokenAddress.toLowerCase();
    const token0Address = t0.toLowerCase();
    const token1Address = t1.toLowerCase();

    const isUSDTToken0 = token0Address === usdtLower;
    const isUSDTToken1 = token1Address === usdtLower;

    if (!isUSDTToken0 && !isUSDTToken1) {
      console.warn(`Pool ${poolAddress} does not contain USDT`);
      return null;
    }

    // Create pool contract to get slot0 (contains sqrtPriceX96)
    const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);

    // Get slot0 (contains sqrtPriceX96) - only on-chain call needed
    const slot0 = await rateLimiter.execute(() => poolContract.slot0());
    const sqrtPriceX96 = slot0.sqrtPriceX96;

    // Get decimals for both tokens
    const [decimals0, decimals1] = await Promise.all([
      decimalCache.getDecimals(t0),
      decimalCache.getDecimals(t1),
    ]);

    // Calculate price from sqrtPriceX96
    // In Uniswap V3: sqrtPriceX96 = sqrt(reserve1 / reserve0) * 2^96
    // where reserve0 and reserve1 are raw token amounts (with decimals)
    //
    // So: (sqrtPriceX96 / 2^96)^2 = reserve1 / reserve0
    //
    // To get price in USDT per token (human-readable):
    // price = (USDT_amount / 10^usdtDecimals) / (TOKEN_amount / 10^tokenDecimals)
    //       = (USDT_amount / TOKEN_amount) * (10^tokenDecimals / 10^usdtDecimals)
    //
    // - If token0 = USDT, token1 = TOKEN:
    //   reserve1/reserve0 = TOKEN_reserve/USDT_reserve
    //   price = (USDT_reserve/TOKEN_reserve) * (10^decimals1 / 10^decimals0)
    //         = (1 / reserveRatio) * (10^decimals1 / 10^decimals0)
    // - If token0 = TOKEN, token1 = USDT:
    //   reserve1/reserve0 = USDT_reserve/TOKEN_reserve
    //   price = (USDT_reserve/TOKEN_reserve) * (10^decimals1 / 10^decimals0)
    //         = reserveRatio * (10^decimals1 / 10^decimals0)

    const Q96 = BigInt(2) ** BigInt(96);
    const sqrtPriceX96BigInt = BigInt(sqrtPriceX96.toString());

    // Calculate sqrtPrice = sqrtPriceX96 / 2^96
    const sqrtPrice = Number(sqrtPriceX96BigInt) / Number(Q96);

    // Calculate reserve1/reserve0 = (sqrtPrice)^2
    const reserveRatio = sqrtPrice * sqrtPrice;

    // Calculate final price in USDT per token (human-readable)
    let price: number;
    if (isUSDTToken0) {
      // token0 = USDT, token1 = TOKEN
      // reserveRatio = reserve1/reserve0 = TOKEN_reserve/USDT_reserve
      // price = (USDT_reserve/TOKEN_reserve) * (10^decimals1 / 10^decimals0)
      price = (1 / reserveRatio) * (10 ** decimals1) / (10 ** decimals0);
    } else {
      // token0 = TOKEN, token1 = USDT
      // reserveRatio = reserve1/reserve0 = USDT_reserve/TOKEN_reserve
      // price = (USDT_reserve/TOKEN_reserve) * (10^decimals1 / 10^decimals0)
      price = reserveRatio * (10 ** decimals1) / (10 ** decimals0);
    }

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

// Test function - run if file is executed directly
async function testGetTokenPriceInUSDT() {
  console.log('=== Testing getTokenPriceInUSDT ===\n');

  // Setup provider
  const rpcUrl = process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org/';
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  console.log(`RPC: ${rpcUrl}\n`);

  // Initialize decimal cache (load from file if exists)
  const decimalCache = new DecimalCache(provider);
  await decimalCache.load();

  // Test tokens (BSC Mainnet)
  const testTokens = [
    { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', name: 'WBNB' },
    { address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', name: 'ETH' },
    { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', name: 'USDC' },
    { address: '0x55d398326f99059fF775485246999027B3197955', name: 'USDT' }, // Should return 1.0
  ];

  for (const token of testTokens) {
    try {
      console.log(`Testing ${token.name} (${token.address})...`);
      const price = await getTokenPriceInUSDT(provider, token.address, decimalCache);

      if (price !== null) {
        console.log(`  ✅ Price: $${price.toFixed(6)}`);
      } else {
        console.log(`  ❌ Failed to get price`);
      }
    } catch (error: any) {
      console.error(`  ❌ Error: ${error.message}`);
    }
    console.log('');
  }

  console.log('=== Test completed ===');
}

// Run test if file is executed directly
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.includes('poolLiquidityHelper')
) {
  testGetTokenPriceInUSDT().catch(console.error);
}

