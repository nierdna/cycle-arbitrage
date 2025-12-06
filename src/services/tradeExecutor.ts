/**
 * Trade Executor Service
 * Handles execution of arbitrage trades via arbitrage contract (bundle mode only)
 * 
 * Supports:
 * - 2 pools: Simple arbitrage (A -> B -> A)
 * - 3 pools: Triangle arbitrage (A -> B -> C -> A)
 * 
 * Execution via bundle submission to 48.club builder
 * 
 * IMPORTANT: Contract uses flash loan logic (reverse order from cycle discovery)
 * - Cycle discovery: A -> B -> C -> A (forward)
 * - Contract flash loan: C -> B -> A (reverse)
 */

import { ethers } from 'ethers';
import winston from 'winston';
import axios from 'axios';
import { CycleWithState } from '../cycleArbitrage.js';
import { MetricsCollector } from '../monitoring/metrics.js';
import { MIN_SQRT_RATIO, MAX_SQRT_RATIO } from '../constants.js';

export interface BundleConfig {
  rpcUrl: string;
  apiUrl: string;
  maxBlocks: number;
  maxSeconds: number;
}

export interface ArbitrageContractConfig {
  contractAddress: string;
  contractABI: any[];
}

export class TradeExecutor {
  private arbitrageContract: ethers.Contract;
  private contractAddress: string;

  constructor(
    private wallet: ethers.Wallet,
    private logger: winston.Logger,
    private bundleConfig: BundleConfig,
    contractConfig: ArbitrageContractConfig,
    private metrics?: MetricsCollector
  ) {
    // Save contract address
    this.contractAddress = contractConfig.contractAddress;

    // Create contract instance
    this.arbitrageContract = new ethers.Contract(
      contractConfig.contractAddress,
      contractConfig.contractABI,
      wallet
    );
  }

  /**
   * Execute arbitrage trade for a specific cycle via arbitrage contract
   * Only supports 2 pools (simple) or 3 pools (triangle)
   * 
   * IMPORTANT: Reverse pools and fees order for flash loan logic
   */
  async executeCycle(
    cycleId: string,
    cycle: CycleWithState,
    amountIn: bigint,
    estimatedOut: bigint
  ): Promise<void> {
    try {
      const poolCount = cycle.poolAddresses.length;

      // Only support 2 or 3 pools
      if (poolCount < 2 || poolCount > 3) {
        this.logger.warn(
          `[${cycleId}] Cycle has ${poolCount} pools. Only 2-3 pools are supported. Skipping execution.`
        );
        return;
      }

      this.logger.info(`[${cycleId}] Preparing ${poolCount}-pool arbitrage via bundle...`);

      // Reverse pools for flash loan logic
      // Contract uses reverse order: Pool1 = Cycle Pool[last], Pool2 = Cycle Pool[last-1], ...
      const reversedPools = this.reverseArray(cycle.poolAddresses);

      // Calculate zeroForOne flags for reversed pools (flash loan token flow)
      const zeroForOneFlags = this.calculateZeroForOneFlagsForFlashLoan(cycle, reversedPools);

      // Calculate sqrt price limits
      const sqrtPriceLimits = zeroForOneFlags.map(zeroForOne =>
        zeroForOne ? MIN_SQRT_RATIO : MAX_SQRT_RATIO
      );

      // Use estimatedOut as exactOutputAmount (uint256, số dương)
      // Contract expects exact output amount from Pool1 (ví dụ: 101 USDT)
      const exactOutputAmount = estimatedOut;

      // Calculate min profit (optional, set to 0 to disable check)
      const minProfit = 0n;

      // Tip amount (optional)
      const tipAmount = 0n;

      // Create bundle provider
      const bundleProvider = new ethers.JsonRpcProvider(this.bundleConfig.rpcUrl);

      // Get nonce and current block
      const [nonce, block] = await Promise.all([
        bundleProvider.getTransactionCount(this.wallet.address, "pending"),
        bundleProvider.getBlockNumber(),
      ]);

      // Encode function call based on pool count
      const iface = this.arbitrageContract.interface;
      let data: string;

      if (poolCount === 2) {
        // Simple arbitrage: executeSimpleArbitrage
        // Contract Pool1 = Cycle Pool[1], Contract Pool2 = Cycle Pool[0]
        data = iface.encodeFunctionData("executeSimpleArbitrage", [
          reversedPools[0],  // Contract Pool1 (Cycle Pool[1])
          reversedPools[1],  // Contract Pool2 (Cycle Pool[0])
          zeroForOneFlags[0],
          zeroForOneFlags[1],
          exactOutputAmount,  // Exact output amount from Pool1 (uint256, số dương)
          sqrtPriceLimits[0],
          sqrtPriceLimits[1],
          minProfit,
          tipAmount,
        ]);
      } else {
        // Triangle arbitrage: executeTriangleArbitrage
        // Contract Pool1 = Cycle Pool[2], Contract Pool2 = Cycle Pool[1], Contract Pool3 = Cycle Pool[0]
        data = iface.encodeFunctionData("executeTriangleArbitrage", [
          reversedPools[0],  // Contract Pool1 (Cycle Pool[2])
          reversedPools[1],  // Contract Pool2 (Cycle Pool[1])
          reversedPools[2],  // Contract Pool3 (Cycle Pool[0])
          zeroForOneFlags[0],
          zeroForOneFlags[1],
          zeroForOneFlags[2],
          exactOutputAmount,  // Exact output amount from Pool1 (uint256, số dương)
          sqrtPriceLimits[0],
          sqrtPriceLimits[1],
          sqrtPriceLimits[2],
          minProfit,
          tipAmount,
        ]);
      }

      // Get gas price
      const feeData = await bundleProvider.getFeeData();
      const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.parseUnits("2", "gwei");
      const maxFeePerGas = feeData.maxFeePerGas || ethers.parseUnits("3", "gwei");

      // Estimate gas limit based on pool count
      const gasLimit = poolCount === 2 ? 500000n : 1000000n;

      // Create transaction
      const tx = {
        to: this.contractAddress,
        value: "0",
        data: data,
        gasLimit: gasLimit,
        maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
        maxFeePerGas: maxFeePerGas.toString(),
        nonce: nonce,
        type: 2, // EIP-1559
        chainId: 56, // BSC Mainnet
      };

      this.logger.info(`[${cycleId}] Signing transaction...`);

      // Sign transaction
      const signedTx = await this.wallet.signTransaction(tx);

      // Create bundle
      const bundle = {
        txs: [signedTx],
        maxBlockNumber: block + this.bundleConfig.maxBlocks,
        maxTimestamp: Math.floor(Date.now() / 1000) + this.bundleConfig.maxSeconds,
        revertingTxHashes: [],
        noMerge: false,
        noTail: false,
      };

      // Submit bundle
      this.logger.info(`[${cycleId}] Submitting bundle to ${this.bundleConfig.apiUrl}...`);

      const res = await axios.post(
        this.bundleConfig.apiUrl,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "eth_sendBundle",
          params: [bundle],
        },
        {
          headers: { "Content-Type": "application/json" },
          timeout: 30000,
        }
      );

      if (res.data.error) {
        throw new Error(`Bundle submission failed: ${res.data.error.message}`);
      }

      this.logger.info(`[${cycleId}] ✓ Bundle submitted successfully`);

      if (res.data.result) {
        this.logger.info(`[${cycleId}] Bundle result: ${res.data.result}`);
      }

      // Log estimated profit
      const estimatedProfit = estimatedOut - amountIn;
      const estimatedProfitBps = Number((estimatedProfit * BigInt(1e4)) / amountIn);

      this.logger.info(
        `[${cycleId}] Estimated profit: ${ethers.formatEther(estimatedProfit)} tokens (${estimatedProfitBps.toFixed(2)} bps)`
      );

      // Record opportunity
      this.metrics?.recordOpportunity(cycleId, estimatedProfitBps, amountIn);

    } catch (error: any) {
      this.logger.error(`[${cycleId}] ✗ Bundle submission failed:`, error.message || error);
      throw error;
    }
  }

  /**
   * Reverse array (helper for reversing pools and fees)
   */
  private reverseArray<T>(arr: T[]): T[] {
    return [...arr].reverse();
  }

  /**
   * Calculate zeroForOne flags for flash loan logic (reversed pools)
   * 
   * Flash loan logic uses reverse order:
   * - 2 pools: Contract Pool1 = Cycle Pool[1], Contract Pool2 = Cycle Pool[0]
   * - 3 pools: Contract Pool1 = Cycle Pool[2], Contract Pool2 = Cycle Pool[1], Contract Pool3 = Cycle Pool[0]
   * 
   * Token flow for flash loan (same direction as cycle, but pools are reversed):
   * - Contract Pool1 (Cycle Pool[poolCount-1]): tokenIn → tokenOut (same as cycle direction)
   * - Contract Pool2 (Cycle Pool[poolCount-2]): tokenIn → tokenOut (same as cycle direction)
   * - Contract Pool3 (Cycle Pool[0]): tokenIn → tokenOut (same as cycle direction)
   * 
   * Example for 2 pools [USDT-WBNB-USDT]:
   * - Cycle Pool[1]: WBNB → USDT becomes Contract Pool1: WBNB → USDT
   * - Cycle Pool[0]: USDT → WBNB becomes Contract Pool2: USDT → WBNB
   */
  private calculateZeroForOneFlagsForFlashLoan(
    cycle: CycleWithState,
    reversedPools: string[]
  ): boolean[] {
    const flags: boolean[] = [];
    const poolCount = reversedPools.length;

    for (let i = 0; i < poolCount; i++) {
      // Map reversed pool index back to original cycle index
      const originalIndex = poolCount - 1 - i;

      // Token flow is the same as cycle (tokenIn → tokenOut)
      // Contract Pool1 uses Cycle Pool[poolCount-1]: same token flow direction
      const tokenIn = cycle.addresses[originalIndex];      // Token input
      const tokenOut = cycle.addresses[originalIndex + 1]; // Token output (wrap around for last pool)

      // Calculate token0/token1 directly (Uniswap V3 convention: token0 < token1 alphabetically)
      const { token0 } = this.getToken0Token1(tokenIn, tokenOut);

      // zeroForOne = true if tokenIn is token0
      const zeroForOne = token0.toLowerCase() === tokenIn.toLowerCase();
      flags.push(zeroForOne);
    }

    return flags;
  }

  /**
   * Get token0 and token1 from two token addresses
   * token0 is the address with lower alphabetical order (Uniswap V3 convention)
   */
  private getToken0Token1(tokenA: string, tokenB: string): { token0: string; token1: string } {
    const tokenALower = tokenA.toLowerCase();
    const tokenBLower = tokenB.toLowerCase();

    if (tokenALower < tokenBLower) {
      return { token0: tokenA, token1: tokenB };
    } else {
      return { token0: tokenB, token1: tokenA };
    }
  }
}
