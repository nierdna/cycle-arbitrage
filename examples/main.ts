/**
 * Example: Cycle Arbitrage MVP
 * 
 * Usage:
 *   1. Create tokens.config.json in project root (see tokens.config.json.example)
 *   2. Create .env file or export environment variables:
 *      BSC_RPC_URL=https://bsc-dataseed.binance.org/
 *      BSC_WSS_URL=wss://... (optional, for real-time updates)
 *      PRIVATE_KEY=0x... (optional, for execution)
 *      TOKENS_CONFIG_PATH=./tokens.config.json (optional, override config path)
 *   3. npm start
 */

import 'dotenv/config';
import { ethers } from 'ethers';
import { CycleArbitrage } from '../src/cycleArbitrage.js';
import { TokenRegistry, loadTokensFromConfig } from '../src/tokens/index.js';
import { BundleConfig } from '../src/services/index.js';
import { DEFAULT_RPC_URLS } from 'uniswap-v3-quoter';

async function main() {
  console.log('=== Cycle Arbitrage MVP ===\n');

  // Setup provider
  const rpcUrl = process.env.BSC_RPC_URL || DEFAULT_RPC_URLS.BSC_MAINNET;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  console.log(`RPC: ${rpcUrl}\n`);

  // Create token registry with tokens and their configs
  // Pass provider for decimal cache and liquidity checks
  const tokenRegistry = new TokenRegistry(provider);

  // Initialize decimal cache (load from file if exists)
  await tokenRegistry.initialize();

  // Load tokens from config file
  // Config path can be overridden via TOKENS_CONFIG_PATH env variable
  // Default: tokens.config.json in project root
  const configPath = process.env.TOKENS_CONFIG_PATH;
  if (configPath) {
    console.log(`Using tokens config: ${configPath}\n`);
  }
  try {
    const tokens = loadTokensFromConfig(configPath);
    tokenRegistry.addTokens(tokens);
    console.log(`Loaded ${tokens.length} tokens from config file\n`);
  } catch (error) {
    console.error('Failed to load tokens from config file:', error);
    throw error;
  }

  // Note: All tokens must have amountConfig. Cycles starting from tokens without config will be skipped.

  // Create arbitrage instance with auto-discovery mode
  const arbitrage = new CycleArbitrage(provider, tokenRegistry, {
    minArbitrageBps: 2, // Minimum 2 bps profit
    scanIntervalMs: 1, // Scan every 1ms
    wssUrl: process.env.BSC_WSS_URL, // Optional: for real-time updates
    amountIn: BigInt(1e18), // 1 USDT (18 decimals) - fallback if optimization disabled
    // Enable amountIn optimization using Ternary Search
    optimizeAmountIn: true,
    optimizationInterval: 100, // Re-optimize every 100 scans
    optimizationPrecision: BigInt(1e15), // 0.001 USDT - precision for ternary search
    dashboardPort: 8080, // Enable HTTP dashboard on port 8080
    // discoveryFees: [100, 500],
    discoveryFees: [100, 500, 2500, 10000],
    // Telegram notifications (optional)
    telegramConfig: process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID
      ? {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID,
        enabled: true,
      }
      : undefined,
  });

  // Optional: Set execution with arbitrage contract (bundle mode only)
  if (process.env.PRIVATE_KEY) {
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    // Bundle configuration
    const bundleConfig: BundleConfig = {
      rpcUrl: process.env.BUNDLE_RPC_URL || 'https://rpc.48.club',
      apiUrl: process.env.BUNDLE_API_URL || 'https://puissant-builder.48.club/',
      maxBlocks: parseInt(process.env.BUNDLE_MAX_BLOCKS || '50'),
      maxSeconds: parseInt(process.env.BUNDLE_MAX_SECONDS || '120'),
    };

    // Arbitrage contract address (deploy from triangle-arbitrage-contract)
    const arbitrageContractAddress = process.env.ARBITRAGE_CONTRACT_ADDRESS || '';

    if (!arbitrageContractAddress) {
      throw new Error(
        'ARBITRAGE_CONTRACT_ADDRESS not set in .env. ' +
        'Please deploy TriangleArbitrageBotBatch contract from triangle-arbitrage-contract and set the address.'
      );
    }

    arbitrage.setExecution(wallet, bundleConfig, arbitrageContractAddress);
    console.log(`Wallet: ${wallet.address}`);
    console.log(`Arbitrage Contract: ${arbitrageContractAddress}`);
    console.log('⚠ Bundle execution mode enabled - will submit bundles!\n');
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

