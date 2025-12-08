/**
 * Trade Executor Integration Test Suite
 * Tests with real transactions and bundle submission to 48.club
 * 
 * REQUIREMENTS:
 * - Set TEST_PRIVATE_KEY in .env file (or KEY_MAINNET or PRIVATE_KEY)
 * - Set TEST_CONTRACT_ADDRESS in .env file (deployed contract address)
 * - Wallet must have BNB for gas fees
 * - Contract must be deployed and wallet must be owner
 * 
 * Run with: npm test -- tradeExecutor.integration.test.ts
 * Skip in CI/CD by default (use .skip or environment check)
 */

import { describe, it, beforeAll } from 'vitest';
import { ethers } from 'ethers';
import winston from 'winston';
import { TradeExecutor, BundleConfig, ArbitrageContractConfig } from './tradeExecutor.js';
import { CycleWithState } from '../cycleArbitrage.js';
import { ARBITRAGE_CONTRACT_ABI } from '../constants.js';
import { getPoolAddressOrThrow } from '../utils/poolHelper.js';
import { NonceCachedWallet } from '../wallet/nonceCachedWallet.js';
import { WalletPool } from '../wallet/walletPool.js';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Skip tests if environment variables are not set
const TEST_PRIVATE_KEY = process.env.TEST_PRIVATE_KEY || process.env.KEY_MAINNET || process.env.PRIVATE_KEY;
const TEST_CONTRACT_ADDRESS = process.env.TEST_CONTRACT_ADDRESS || '';

const shouldSkipTests = !TEST_PRIVATE_KEY || !TEST_CONTRACT_ADDRESS;

describe.skipIf(shouldSkipTests)('TradeExecutor Integration Tests', () => {
  let executor: TradeExecutor;
  let walletPool: WalletPool;
  let logger: winston.Logger;
  let bundleConfig: BundleConfig;
  let contractConfig: ArbitrageContractConfig;
  let provider: ethers.JsonRpcProvider;

  // Test data - Real token addresses on BSC
  const USDT = '0x55d398326f99059fF775485246999027B3197955';
  const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
  const BLESS = '0x7C8217517ed4711fe2DECCdFefFE8d906b9Ae11F';

  beforeAll(() => {
    // Create real logger
    logger = winston.createLogger({
      level: 'info',
      format: winston.format.simple(),
      transports: [new winston.transports.Console()],
    });

    // Create real provider for bundle and pool lookup
    provider = new ethers.JsonRpcProvider('https://rpc.48.club');

    // Bundle config (same as script)
    bundleConfig = {
      rpcUrl: 'https://cosmopolitan-sparkling-arrow.bsc.quiknode.pro/833002b5d68ae8582e9d5bb74ac381a52ec5add5/',
      apiUrl: 'https://puissant-builder.48.club/',
      maxBlocks: 50,
      maxSeconds: 120,
      nonceSyncIntervalMs: 30000, // Sync nonce every 30 seconds
    };

    // Create NonceCachedWallet với nonce caching
    const wallet = new NonceCachedWallet(TEST_PRIVATE_KEY!, provider, {
      syncIntervalMs: bundleConfig.nonceSyncIntervalMs,
      logger: logger,
    });

    // Create WalletPool với single wallet
    walletPool = new WalletPool([wallet], provider, {
      syncIntervalMs: bundleConfig.nonceSyncIntervalMs,
      logger: logger,
    });

    // Contract config with real deployed address
    contractConfig = {
      contractAddress: TEST_CONTRACT_ADDRESS,
      contractABI: ARBITRAGE_CONTRACT_ABI,
    };

    // Create executor with real dependencies
    executor = new TradeExecutor(
      walletPool,
      logger,
      bundleConfig,
      contractConfig
    );

    // Subscribe to events for logging
    executor.on('opportunity', (data) => {
      console.log(`[Metrics] Cycle: ${data.cycleId}, Profit: ${data.arbitrageBps} bps, Amount: ${ethers.formatEther(data.amountIn || 0n)}`);
    });

    executor.on('execution', (data) => {
      console.log(`[Execution] Cycle: ${data.cycleId}, Profit: ${ethers.formatEther(data.profit)}, TX: ${data.txHash || 'N/A'}`);
    });

    console.log('\n🔧 Integration Test Setup:');
    console.log('  Wallet address:', wallet.address);
    console.log('  Contract address:', TEST_CONTRACT_ADDRESS);
    console.log('  Bundle RPC:', bundleConfig.rpcUrl);
    console.log('  Bundle API:', bundleConfig.apiUrl);
  });

  it('should successfully execute 2-pool arbitrage and submit real bundle', async () => {
    // Get real pool addresses using helper
    console.log('\n🔍 Looking up pool addresses...');
    const pool1 = await getPoolAddressOrThrow(provider, USDT, WBNB, 500);
    const pool2 = await getPoolAddressOrThrow(provider, USDT, WBNB, 2500);
    console.log('  Pool1 (USDT-WBNB-500):', pool1);
    console.log('  Pool2 (USDT-WBNB-2500):', pool2);

    const cycle: CycleWithState = {
      cycleId: 'integration-test-2pools',
      tokens: ['USDT', 'WBNB', 'USDT'],
      addresses: [USDT, WBNB, USDT],
      fees: [500, 2500],
      poolAddresses: [pool1, pool2],
      minAmountIn: ethers.parseEther('0.1'),
      maxAmountIn: ethers.parseEther('10'),
    };

    const amountIn = ethers.parseEther('0.0000001'); // 0.0000001 USDT
    const estimatedOut = ethers.parseEther('0.0000001'); // 0.0000001 USDT (1% profit)
    const minProfit = estimatedOut > amountIn ? estimatedOut - amountIn : 1n; // Minimum profit required

    console.log('\n📊 Test Parameters:');
    console.log('  Cycle ID:', cycle.cycleId);
    console.log('  Amount In:', ethers.formatEther(amountIn), 'USDT');
    console.log('  Estimated Out:', ethers.formatEther(estimatedOut), 'USDT');
    console.log('  Expected Profit:', ethers.formatEther(estimatedOut - amountIn), 'USDT');
    console.log('  Min Profit:', ethers.formatEther(minProfit), 'USDT');

    // Execute cycle (this will make real network calls)
    await executor.executeCycle(cycle.cycleId, cycle, amountIn, estimatedOut, minProfit);

    // If we reach here without error, the bundle was submitted successfully
    // Note: We can't verify bundle inclusion immediately, that happens on-chain
    console.log('\n✅ Bundle submitted successfully!');
    console.log('  Check transaction status on BscScan after bundle is included in block');
  }, 60000); // 60 second timeout for network calls

  it('should successfully execute 3-pool triangle arbitrage and submit real bundle', async () => {
    // Get real pool addresses using helper
    console.log('\n🔍 Looking up pool addresses...');
    const pool1 = await getPoolAddressOrThrow(provider, USDT, WBNB, 2500);
    const pool2 = await getPoolAddressOrThrow(provider, WBNB, BLESS, 100);
    const pool3 = await getPoolAddressOrThrow(provider, BLESS, USDT, 10000);
    console.log('  Pool1 (USDT-WBNB-2500):', pool1);
    console.log('  Pool2 (WBNB-BLESS-100):', pool2);
    console.log('  Pool3 (BLESS-USDT-10000):', pool3);

    const cycle: CycleWithState = {
      cycleId: 'integration-test-3pools',
      tokens: ['USDT', 'WBNB', 'BLESS', 'USDT'],
      addresses: [USDT, WBNB, BLESS, USDT],
      fees: [2500, 100, 10000],
      poolAddresses: [pool1, pool2, pool3],
      minAmountIn: ethers.parseEther('0.1'),
      maxAmountIn: ethers.parseEther('10'),
    };

    const amountIn = ethers.parseEther('0.0001');
    const estimatedOut = ethers.parseEther('0.0001');
    const minProfit = estimatedOut > amountIn ? estimatedOut - amountIn : 1n; // Minimum profit required

    console.log('\n📊 Test Parameters:');
    console.log('  Cycle ID:', cycle.cycleId);
    console.log('  Amount In:', ethers.formatEther(amountIn), 'USDT');
    console.log('  Estimated Out:', ethers.formatEther(estimatedOut), 'USDT');
    console.log('  Expected Profit:', ethers.formatEther(estimatedOut - amountIn), 'USDT');
    console.log('  Min Profit:', ethers.formatEther(minProfit), 'USDT');

    await executor.executeCycle(cycle.cycleId, cycle, amountIn, estimatedOut, minProfit);

    console.log('\n✅ Bundle submitted successfully!');
  }, 60000);
});

