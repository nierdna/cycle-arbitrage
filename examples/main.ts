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
import { CycleArbitrageMVP } from '../src/cycleArbitrage';
import { DEFAULT_RPC_URLS } from 'uniswap-v3-quoter';

// Token addresses on BSC (from execution/web3pro/const.py)
const TOKENS = {
  USDT: '0x55d398326f99059fF775485246999027B3197955',
  WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  ASTER: '0x000Ae314E2A2172a039B26378814C252734f556A',
};

async function main() {
  console.log('=== Cycle Arbitrage MVP ===\n');

  // Setup provider
  const rpcUrl = process.env.BSC_RPC_URL || DEFAULT_RPC_URLS.BSC_MAINNET;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  console.log(`RPC: ${rpcUrl}\n`);

  // Define single cycle
  // Example: USDT -> WBNB -> USDT with fees [500, 100] (0.05%, 0.01%)
  const cycle = {
    tokens: ['USDT', 'WBNB', 'USDT'],
    addresses: [TOKENS.USDT, TOKENS.WBNB, TOKENS.USDT],
    fees: [500, 100], // 0.05%, 0.01%
  };

  // Create arbitrage instance
  const arbitrage = new CycleArbitrageMVP(provider, cycle, {
    minArbitrageBps: 2, // Minimum 2 bps profit
    scanIntervalMs: 1, // Scan every 1ms
    wssUrl: process.env.BSC_WSS_URL, // Optional: for real-time updates
    amountIn: BigInt(1e18), // 1 USDT (18 decimals)
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

