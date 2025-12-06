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
import { EventEmitter } from 'events';
import { CycleWithState } from '../cycleArbitrage.js';
import { MIN_SQRT_RATIO, MAX_SQRT_RATIO } from '../constants.js';
import { NonceCachedWallet } from '../wallet/nonceCachedWallet.js';

export interface BundleConfig {
  rpcUrl: string;
  apiUrl: string;
  maxBlocks: number;
  maxSeconds: number;
  nonceSyncIntervalMs?: number; // Optional: interval để sync nonce (default: 30000ms = 30s)
}

export interface ArbitrageContractConfig {
  contractAddress: string;
  contractABI: any[];
}

export class TradeExecutor extends EventEmitter {
  private arbitrageContract: ethers.Contract;
  private contractAddress: string;
  private executingCycles: Set<string> = new Set(); // Track cycles đang execute
  private wallet: NonceCachedWallet; // Use NonceCachedWallet instead of ethers.Wallet

  constructor(
    wallet: ethers.Wallet | NonceCachedWallet,
    private logger: winston.Logger,
    private bundleConfig: BundleConfig,
    contractConfig: ArbitrageContractConfig
  ) {
    super(); // Call EventEmitter constructor
    // Save contract address
    this.contractAddress = contractConfig.contractAddress;

    // Convert to NonceCachedWallet nếu chưa phải
    if (wallet instanceof NonceCachedWallet) {
      this.wallet = wallet;
    } else {
      // Create NonceCachedWallet từ ethers.Wallet
      const provider = wallet.provider || new ethers.JsonRpcProvider(this.bundleConfig.rpcUrl);
      this.wallet = new NonceCachedWallet(wallet.privateKey, provider, {
        syncIntervalMs: this.bundleConfig.nonceSyncIntervalMs,
        logger: this.logger,
      });
    }

    // Create contract instance
    this.arbitrageContract = new ethers.Contract(
      contractConfig.contractAddress,
      contractConfig.contractABI,
      this.wallet
    );
  }

  /**
   * Execute arbitrage trade for a specific cycle via arbitrage contract
   * Only supports 2 pools (simple) or 3 pools (triangle)
   * 
   * IMPORTANT: Reverse pools and fees order for flash loan logic
   * 
   * @returns Transaction hash of the first transaction in the bundle, or undefined if not available
   */
  async executeCycle(
    cycleId: string,
    cycle: CycleWithState,
    amountIn: bigint,
    estimatedOut: bigint
  ): Promise<string | undefined> {
    // Check if cycle is already executing
    if (this.executingCycles.has(cycleId)) {
      this.logger.warn(
        `[${cycleId}] Cycle is already executing. Skipping duplicate execution.`
      );
      return undefined;
    }

    // Set lock
    this.executingCycles.add(cycleId);

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
      const minProfit = 1n;

      // Tip amount (optional)
      const tipAmount = ethers.parseEther('0.00001');

      // Get nonce từ cache
      const nonce = await this.wallet.getCachedNonce();

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
      const maxPriorityFeePerGas = ethers.parseUnits("2", "gwei");
      const maxFeePerGas = ethers.parseUnits("3", "gwei");

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
      const bundle: any = {
        txs: [signedTx],
        maxTimestamp: Math.floor(Date.now() / 1000) + this.bundleConfig.maxSeconds,
        revertingTxHashes: [],
        noMerge: false,
        noTail: false,
      };

      // Sign bundle with 48spSign
      this.logger.info(`[${cycleId}] Signing bundle with 48spSign...`);
      const bundleSign = this.signBundle48sp([signedTx]);
      bundle['48spSign'] = bundleSign;

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
        const errorMsg = res.data.error.message || '';

        // Check nếu error là nonce mismatch
        if (errorMsg.includes('nonce') || errorMsg.includes('replacement') || errorMsg.includes('already known')) {
          this.logger.warn(`[${cycleId}] Nonce error detected, syncing nonce...`);
          await this.wallet.syncNonce();
          // Không retry tự động, để caller quyết định
        }

        throw new Error(`Bundle submission failed: ${errorMsg}`);
      }

      this.logger.info(`[${cycleId}] ✓ Bundle submitted successfully`);

      // Increment nonce sau khi submit thành công
      this.wallet.incrementNonce();

      let txHash: string | undefined;

      if (res.data.result) {
        this.logger.info(`[${cycleId}] Bundle result: ${res.data.result}`);

        // Fetch transaction hash from bundle
        try {
          txHash = await this.getTxHashFromBundle(res.data.result);
          if (txHash) {
            this.logger.info(`[${cycleId}] Transaction hash: ${txHash}`);
          }
        } catch (error: any) {
          this.logger.warn(`[${cycleId}] Failed to fetch tx hash from bundle: ${error.message || error}`);
        }
      }

      // Log estimated profit
      const estimatedProfit = estimatedOut - amountIn;
      const estimatedProfitBps = Number((estimatedProfit * BigInt(1e4)) / amountIn);

      this.logger.info(
        `[${cycleId}] Estimated profit: ${ethers.formatEther(estimatedProfit)} tokens (${estimatedProfitBps.toFixed(2)} bps)`
      );

      // Emit opportunity event
      this.emit('opportunity', {
        cycleId,
        arbitrageBps: estimatedProfitBps,
        amountIn,
      });

      // Emit execution event (bundle submitted successfully)
      this.emit('execution', {
        cycleId,
        profit: estimatedProfit,
        txHash,
      });

      return txHash;

    } catch (error: any) {
      this.logger.error(`[${cycleId}] ✗ Bundle submission failed:`, error.message || error);
      throw error;
    } finally {
      // Always release lock
      this.executingCycles.delete(cycleId);
    }
  }

  /**
   * Get transaction hash from bundle hash by calling 48.club explore API
   * 
   * @param bundleHash Bundle hash from bundle submission result
   * @returns First transaction hash from the bundle, or undefined if not available
   */
  private async getTxHashFromBundle(bundleHash: string): Promise<string | undefined> {
    try {
      const response = await axios.get(
        `https://explore.48.club/v2/bundle?hash=${bundleHash}`,
        {
          timeout: 10000,
        }
      );

      if (response.data?.txs && Array.isArray(response.data.txs) && response.data.txs.length > 0) {
        return response.data.txs[0].tx_hash;
      }

      return undefined;
    } catch (error: any) {
      throw new Error(`Failed to fetch tx hash from bundle: ${error.message || error}`);
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

  /**
   * Sign bundle with 48spSign according to 48.club docs
   * Based on working JavaScript example
   * 
   * Process:
   * 1. Hash each raw transaction (keccak256)
   * 2. Concatenate all hashes
   * 3. Hash the concatenated hashes
   * 4. Sign the final hash with private key
   * 5. Format signature: r (32 bytes) + s (32 bytes) + v (1 byte, recovery id 0 or 1)
   * 
   * @param rawTxs Array of raw signed transactions (RLP-encoded hex strings)
   * @returns Hex string signature (0x...)
   */
  private signBundle48sp(rawTxs: string[]): string {
    // 1. Hash từng tx và concat
    let concatenatedHashes = new Uint8Array(0);

    for (const rawTx of rawTxs) {
      // Ensure rawTx has 0x prefix
      const txHex = rawTx.startsWith('0x') ? rawTx : '0x' + rawTx;
      // Hash the raw transaction (RLP-encoded)
      const txHash = ethers.keccak256(txHex);
      const txHashBytes = ethers.getBytes(txHash);

      // Concatenate
      const newArray = new Uint8Array(concatenatedHashes.length + txHashBytes.length);
      newArray.set(concatenatedHashes, 0);
      newArray.set(txHashBytes, concatenatedHashes.length);
      concatenatedHashes = newArray;
    }

    // 2. Hash chuỗi concat
    const concatenatedHex = ethers.hexlify(concatenatedHashes);
    const finalHash = ethers.keccak256(concatenatedHex);
    const finalHashBytes = ethers.getBytes(finalHash);

    // 3. Sign với private key (sign bytes trực tiếp)
    const signature = this.wallet.signingKey.sign(finalHashBytes);

    // 4. Format signature: r (32 bytes) + s (32 bytes) + v (1 byte)
    // QUAN TRỌNG: recovery id phải là 0 hoặc 1, không phải 27 hoặc 28
    const r = signature.r.slice(2); // Remove 0x prefix
    const s = signature.s.slice(2); // Remove 0x prefix
    const recoveryId = signature.v >= 27 ? signature.v - 27 : signature.v; // 27->0, 28->1
    const vHex = recoveryId.toString(16).padStart(2, '0');

    return '0x' + r + s + vHex;
  }
}
