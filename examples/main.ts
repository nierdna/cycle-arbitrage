/**
 * Example: Cycle Arbitrage MVP
 * 
 * Usage:
 *   export BSC_RPC_URL=https://bsc-dataseed.binance.org/
 *   export BSC_WSS_URL=wss://... (optional, for real-time updates)
 *   export PRIVATE_KEY=0x... (optional, for execution)
 *   npm start
 */

import { ethers } from 'ethers';
import { CycleArbitrage } from '../src/cycleArbitrage';
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

  // Define cycle clusters
  const clusters = [
    {
      cycles: [
        {
          tokens: ['USDT', 'WBNB', 'USDT'],
          addresses: [TOKENS.USDT, TOKENS.WBNB, TOKENS.USDT],
          fees: [500, 100], // 0.05%, 0.01%
          // Per-cycle optimization range (overrides global defaults)
          minAmountIn: BigInt(1e10), // 0.0001 USDT
          maxAmountIn: BigInt(1e19), // 10 USDT
        },
        // {
        //   tokens: ['USDT', 'WBNB', 'USDT'],
        //   addresses: [TOKENS.USDT, TOKENS.WBNB, TOKENS.USDT],
        //   fees: [100, 500], // 0.01%, 0.05%
        //   // This cycle will use global defaults if not specified
        // },
      ],
      name: 'USDT-WBNB cluster',
    },
    // {
    //   cycles: [
    //     {
    //       tokens: ['USDT', 'ASTER', 'USDT'],
    //       addresses: [TOKENS.USDT, TOKENS.ASTER, TOKENS.USDT],
    //       fees: [500, 2500], // 0.05%, 0.25%
    //     },
    //     {
    //       tokens: ['USDT', 'ASTER', 'USDT'],
    //       addresses: [TOKENS.USDT, TOKENS.ASTER, TOKENS.USDT],
    //       fees: [2500, 500], // 0.25%, 0.05%
    //     },
    //   ],
    //   name: 'USDT-ASTER cluster',
    // },
    // {
    //   cycles: [
    //     {
    //       tokens: ['USDT', 'KOGE', 'ETH', 'USDT'],
    //       addresses: [TOKENS.USDT, TOKENS.KOGE, TOKENS.ETH, TOKENS.USDT],
    //       fees: [100, 10000, 500], // 0.01%, 1%, 0.05%,
    //       minAmountIn: BigInt(1e16),
    //       maxAmountIn: BigInt(1e20),
    //     },
    //     {
    //       tokens: ['USDT', 'ETH', 'KOGE', 'USDT'],
    //       addresses: [TOKENS.USDT, TOKENS.ETH, TOKENS.KOGE, TOKENS.USDT],
    //       fees: [500, 10000, 100], // 0.01%, 1%, 0.05%,
    //       minAmountIn: BigInt(1e16),
    //       maxAmountIn: BigInt(1e20),
    //     },
    //   ],
    //   name: 'KOGE-ETH-USDT-KOGE cluster',
    // },
  ];

  // Create arbitrage instance
  const arbitrage = new CycleArbitrage(provider, clusters, {
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

