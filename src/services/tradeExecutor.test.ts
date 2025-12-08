/**
 * Trade Executor Test Suite
 * Tests for getToken0Token1 and calculateZeroForOneFlagsForFlashLoan methods
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';
import winston from 'winston';
import { TradeExecutor, BundleConfig, ArbitrageContractConfig } from './tradeExecutor.js';
import { CycleWithState } from '../cycleArbitrage.js';
import { ARBITRAGE_CONTRACT_ABI } from '../constants.js';

// Mock dependencies
vi.mock('axios');

describe('TradeExecutor', () => {
  let executor: TradeExecutor;
  let wallet: ethers.Wallet;
  let mockLogger: winston.Logger;
  let provider: ethers.JsonRpcProvider;
  let bundleConfig: BundleConfig;
  let contractConfig: ArbitrageContractConfig;

  // Test data - Token addresses
  const USDT = '0x55d398326f99059fF775485246999027B3197955';
  const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
  const ASTER = '0x000Ae314E2A2172a039B26378814C252734f556A';

  beforeEach(() => {
    // Mock logger
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as winston.Logger;

    // Create provider (mocked to avoid network calls)
    provider = new ethers.JsonRpcProvider('https://bsc-dataseed.binance.org/');
    vi.spyOn(provider, 'call' as any).mockResolvedValue('0x');
    vi.spyOn(provider, 'getNetwork' as any).mockResolvedValue({
      chainId: 56n,
      name: 'bsc',
    });
    vi.spyOn(provider, 'resolveName' as any).mockImplementation((name: unknown) => {
      if (typeof name === 'string' && name.startsWith('0x')) {
        return Promise.resolve(name);
      }
      return Promise.resolve(null);
    });

    // Create wallet
    wallet = new ethers.Wallet('0x' + '1'.repeat(64), provider);

    // Bundle config
    bundleConfig = {
      rpcUrl: 'https://cosmopolitan-sparkling-arrow.bsc.quiknode.pro/833002b5d68ae8582e9d5bb74ac381a52ec5add5/',
      apiUrl: 'https://puissant-builder.48.club/',
      maxBlocks: 50,
      maxSeconds: 120,
    };

    // Contract config
    contractConfig = {
      contractAddress: '0xContractAddress',
      contractABI: ARBITRAGE_CONTRACT_ABI,
    };

    // Create executor
    executor = new TradeExecutor(
      wallet,
      mockLogger,
      bundleConfig,
      contractConfig
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getToken0Token1', () => {
    it('should return token0 as the address with lower alphabetical order', () => {
      // USDT < WBNB alphabetically (0x55... < 0xbb...)
      const result = (executor as any).getToken0Token1(USDT, WBNB);
      
      expect(result.token0.toLowerCase()).toBe(USDT.toLowerCase());
      expect(result.token1.toLowerCase()).toBe(WBNB.toLowerCase());
    });

    it('should return token0 correctly when addresses are reversed', () => {
      // Same tokens, reversed order
      const result = (executor as any).getToken0Token1(WBNB, USDT);
      
      expect(result.token0.toLowerCase()).toBe(USDT.toLowerCase());
      expect(result.token1.toLowerCase()).toBe(WBNB.toLowerCase());
    });

    it('should handle case-insensitive comparison', () => {
      const usdtUpper = USDT.toUpperCase();
      const wbnbLower = WBNB.toLowerCase();
      
      const result = (executor as any).getToken0Token1(usdtUpper, wbnbLower);
      
      expect(result.token0.toLowerCase()).toBe(USDT.toLowerCase());
      expect(result.token1.toLowerCase()).toBe(WBNB.toLowerCase());
    });

    it('should handle ASTER < USDT < WBNB ordering', () => {
      // ASTER (0x000...) < USDT (0x55...) < WBNB (0xbb...)
      const result1 = (executor as any).getToken0Token1(ASTER, USDT);
      expect(result1.token0.toLowerCase()).toBe(ASTER.toLowerCase());
      expect(result1.token1.toLowerCase()).toBe(USDT.toLowerCase());

      const result2 = (executor as any).getToken0Token1(USDT, WBNB);
      expect(result2.token0.toLowerCase()).toBe(USDT.toLowerCase());
      expect(result2.token1.toLowerCase()).toBe(WBNB.toLowerCase());

      const result3 = (executor as any).getToken0Token1(ASTER, WBNB);
      expect(result3.token0.toLowerCase()).toBe(ASTER.toLowerCase());
      expect(result3.token1.toLowerCase()).toBe(WBNB.toLowerCase());
    });
  });

  describe('calculateZeroForOneFlagsForFlashLoan', () => {
    it('should calculate zeroForOne flags correctly for 2 pools: USDT -> WBNB -> USDT', () => {
      const cycle: CycleWithState = {
        cycleId: 'test-2pools',
        tokens: ['USDT', 'WBNB', 'USDT'],
        addresses: [USDT, WBNB, USDT],
        fees: [500, 100],
        poolAddresses: ['0xPool1', '0xPool2'],
        minAmountIn: 1000n,
        maxAmountIn: 1000000n,
      };

      // Reversed pools: [Pool2, Pool1]
      const reversedPools = ['0xPool2', '0xPool1'];

      const flags = (executor as any).calculateZeroForOneFlagsForFlashLoan(cycle, reversedPools);

      expect(flags).toHaveLength(2);
      expect(typeof flags[0]).toBe('boolean');
      expect(typeof flags[1]).toBe('boolean');

      // Contract Pool1 = Cycle Pool[1] (WBNB -> USDT)
      // WBNB (0xbb...) > USDT (0x55...) alphabetically
      // So WBNB is token1, USDT is token0
      // Swap WBNB -> USDT means token1 -> token0, so zeroForOne = false
      expect(flags[0]).toBe(false);

      // Contract Pool2 = Cycle Pool[0] (USDT -> WBNB)
      // USDT (0x55...) < WBNB (0xbb...) alphabetically
      // So USDT is token0, WBNB is token1
      // Swap USDT -> WBNB means token0 -> token1, so zeroForOne = true
      expect(flags[1]).toBe(true);
    });

    it('should calculate zeroForOne flags correctly for 2 pools: WBNB -> USDT -> WBNB', () => {
      const cycle: CycleWithState = {
        cycleId: 'test-2pools-reverse',
        tokens: ['WBNB', 'USDT', 'WBNB'],
        addresses: [WBNB, USDT, WBNB],
        fees: [100, 500],
        poolAddresses: ['0xPool1', '0xPool2'],
        minAmountIn: 1000n,
        maxAmountIn: 1000000n,
      };

      const reversedPools = ['0xPool2', '0xPool1'];

      const flags = (executor as any).calculateZeroForOneFlagsForFlashLoan(cycle, reversedPools);

      expect(flags).toHaveLength(2);

      // Contract Pool1 = Cycle Pool[1] (USDT -> WBNB)
      // USDT is token0, WBNB is token1
      // Swap USDT -> WBNB means token0 -> token1, so zeroForOne = true
      expect(flags[0]).toBe(true);

      // Contract Pool2 = Cycle Pool[0] (WBNB -> USDT)
      // WBNB is token1, USDT is token0
      // Swap WBNB -> USDT means token1 -> token0, so zeroForOne = false
      expect(flags[1]).toBe(false);
    });

    it('should calculate zeroForOne flags correctly for 3 pools: USDT -> WBNB -> ASTER -> USDT', () => {
      const cycle: CycleWithState = {
        cycleId: 'test-3pools',
        tokens: ['USDT', 'WBNB', 'ASTER', 'USDT'],
        addresses: [USDT, WBNB, ASTER, USDT],
        fees: [500, 100, 2500],
        poolAddresses: ['0xPool1', '0xPool2', '0xPool3'],
        minAmountIn: 1000n,
        maxAmountIn: 1000000n,
      };

      // Reversed pools: [Pool3, Pool2, Pool1]
      const reversedPools = ['0xPool3', '0xPool2', '0xPool1'];

      const flags = (executor as any).calculateZeroForOneFlagsForFlashLoan(cycle, reversedPools);

      expect(flags).toHaveLength(3);
      expect(typeof flags[0]).toBe('boolean');
      expect(typeof flags[1]).toBe('boolean');
      expect(typeof flags[2]).toBe('boolean');

      // Contract Pool1 = Cycle Pool[2] (ASTER -> USDT)
      // ASTER (0x000...) < USDT (0x55...) alphabetically
      // So ASTER is token0, USDT is token1
      // Swap ASTER -> USDT means token0 -> token1, so zeroForOne = true
      expect(flags[0]).toBe(true);

      // Contract Pool2 = Cycle Pool[1] (WBNB -> ASTER)
      // WBNB (0xbb...) > ASTER (0x000...) alphabetically
      // So ASTER is token0, WBNB is token1
      // Swap WBNB -> ASTER means token1 -> token0, so zeroForOne = false
      expect(flags[1]).toBe(false);

      // Contract Pool3 = Cycle Pool[0] (USDT -> WBNB)
      // USDT (0x55...) < WBNB (0xbb...) alphabetically
      // So USDT is token0, WBNB is token1
      // Swap USDT -> WBNB means token0 -> token1, so zeroForOne = true
      expect(flags[2]).toBe(true);
    });

    it('should handle wrap-around for last pool in cycle', () => {
      const cycle: CycleWithState = {
        cycleId: 'test-wrap-around',
        tokens: ['USDT', 'WBNB', 'USDT'],
        addresses: [USDT, WBNB, USDT], // Last address wraps to first
        fees: [500, 100],
        poolAddresses: ['0xPool1', '0xPool2'],
        minAmountIn: 1000n,
        maxAmountIn: 1000000n,
      };

      const reversedPools = ['0xPool2', '0xPool1'];

      const flags = (executor as any).calculateZeroForOneFlagsForFlashLoan(cycle, reversedPools);

      // Contract Pool1 uses Cycle Pool[1] -> Pool[2] (WBNB -> USDT, wraps around)
      // Should correctly handle the wrap-around to first token
      expect(flags).toHaveLength(2);
      expect(typeof flags[0]).toBe('boolean');
      expect(typeof flags[1]).toBe('boolean');
    });
  });
});
