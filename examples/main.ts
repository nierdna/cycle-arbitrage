/**
 * Example: Cycle Arbitrage MVP
 * 
 * Usage:
 *   Create .env file or export environment variables:
 *   BSC_RPC_URL=https://bsc-dataseed.binance.org/
 *   BSC_WSS_URL=wss://... (optional, for real-time updates)
 *   PRIVATE_KEY=0x... (optional, for execution)
 *   npm start
 */

import 'dotenv/config';
import { ethers } from 'ethers';
import { CycleArbitrage, TokenAmountConfig } from '../src/cycleArbitrage.js';
import { DEFAULT_RPC_URLS } from 'uniswap-v3-quoter';

// Token addresses on BSC (from execution/web3pro/const.py)
const TOKENS = {
  USDT: '0x55d398326f99059fF775485246999027B3197955',
  WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  ASTER: '0x000Ae314E2A2172a039B26378814C252734f556A',
  ETH: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8",
  KOGE: "0xe6DF05CE8C8301223373CF5B969AFCb1498c5528"
};

async function main() {
  console.log('=== Cycle Arbitrage MVP ===\n');

  // Setup provider
  const rpcUrl = process.env.BSC_RPC_URL || DEFAULT_RPC_URLS.BSC_MAINNET;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  console.log(`RPC: ${rpcUrl}\n`);

  // Define token list for auto-discovery
  // System will automatically find all cycles between these tokens
  const tokenList = [
    TOKENS.USDT,
    TOKENS.WBNB,
  // TOKENS.ASTER,
  // TOKENS.ETH,
  // TOKENS.KOGE,
  ];

  // Create token name mapping for readable logs
  const tokenNames = new Map<string, string>();
  Object.entries(TOKENS).forEach(([name, address]) => {
    tokenNames.set(address.toLowerCase(), name);
  });

  // Create token amount config (minAmountIn/maxAmountIn per start token)
  const tokenAmountConfig = new Map<string, TokenAmountConfig>();
  tokenAmountConfig.set(TOKENS.USDT.toLowerCase(), {
    minAmountIn: BigInt(1e10), // 0.0001 USDT
    maxAmountIn: BigInt(1e19), // 10 USDT
  });
  tokenAmountConfig.set(TOKENS.WBNB.toLowerCase(), {
    minAmountIn: BigInt(1e15), // 0.001 WBNB
    maxAmountIn: BigInt(1e20), // 100 WBNB
  });

  // Create arbitrage instance with auto-discovery mode
  const arbitrage = new CycleArbitrage(provider, tokenList, {
    minArbitrageBps: 2, // Minimum 2 bps profit
    scanIntervalMs: 1, // Scan every 1ms
    wssUrl: process.env.BSC_WSS_URL, // Optional: for real-time updates
    amountIn: BigInt(1e18), // 1 USDT (18 decimals) - fallback if optimization disabled
    // Enable amountIn optimization using Ternary Search
    optimizeAmountIn: true,
    // Global defaults (used for cycles that don't specify minAmountIn/maxAmountIn)
    minAmountIn: BigInt(1e10), // 0.0001 USDT - minimum search range
    maxAmountIn: BigInt(1e21), // 10 USDT - maximum search range
    optimizationInterval: 100, // Re-optimize every 100 scans
    optimizationPrecision: BigInt(1e15), // 0.001 USDT - precision for ternary search
    dashboardPort: 8080, // Enable HTTP dashboard on port 8080
    discoveryFees: [100, 500, 2500, 10000],
    tokenNames, // Token name mapping for readable logs
    tokenAmountConfig, // Amount config per start token
  });

  // Optional: Set execution (if you want to auto-execute)
  if (process.env.PRIVATE_KEY) {
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    arbitrage.setExecution(wallet);
    console.log(`Wallet: ${wallet.address}`);
    console.log('⚠ Execution mode enabled - will auto-execute trades!\n');
  } else {
    console.log('ℹ Execution mode disabled - only scanning (set PRIVATE_KEY to enable)\n');
  }

  // Initialize and start scanning
  await arbitrage.initialize();
  await arbitrage.scan(); // Runs forever
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

