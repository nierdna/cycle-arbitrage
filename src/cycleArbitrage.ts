/**
 * Cycle Arbitrage - Support Cycle Clusters
 * Minimal implementation for cycle arbitrage on PancakeSwap V3
 */

import { ethers } from 'ethers';
import { QuoterV3, StateFetcher } from 'uniswap-v3-quoter';

// BSC Contract Addresses
const PANCAKE_V3_FACTORY = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865';
const BITSWAP_V3_ROUTER = '0xb5DFcaC19B4f4f64e9e641D2096d0a80341C655d';

// Factory ABI (minimal)
const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
];

// Router ABI (minimal - only swapExactInput)
const ROUTER_ABI = [
  {
    name: 'swapExactInput',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'path', type: 'bytes' },
          { name: 'recipient', type: 'address' },
          { name: 'deadline', type: 'uint256' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
];

// Swap event signature
const SWAP_EVENT_TOPIC = '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83';

export interface CycleConfig {
  tokens: string[]; // ["USDT", "WBNB", "USDT"]
  addresses: string[]; // BSC addresses
  fees: number[]; // [500, 100] in bps
  // Optional: per-cycle optimization settings (override global defaults)
  minAmountIn?: bigint; // Minimum amount to search for this cycle
  maxAmountIn?: bigint; // Maximum amount to search for this cycle
}

export interface CycleCluster {
  cycles: CycleConfig[];
  name?: string;
}

interface CycleWithState extends CycleConfig {
  poolAddresses: string[];
  cycleId: string;
  // These will be set from cycle config or global defaults
  minAmountIn: bigint;
  maxAmountIn: bigint;
}

export interface ArbitrageOptions {
  minArbitrageBps?: number;
  scanIntervalMs?: number;
  wssUrl?: string;
  amountIn?: bigint; // Default amount to test with
  optimizeAmountIn?: boolean; // Enable amountIn optimization
  minAmountIn?: bigint; // Minimum amount to search (default: 0.1 tokens)
  maxAmountIn?: bigint; // Maximum amount to search (default: 100 tokens)
  optimizationInterval?: number; // Re-optimize every N scans (default: 100)
  optimizationPrecision?: bigint; // Precision for ternary search (default: 0.001 tokens)
}

/**
 * Cycle Arbitrage - Support Cycle Clusters
 */
export class CycleArbitrage {
  private provider: ethers.Provider;
  private stateFetcher: StateFetcher;
  private quoter: QuoterV3;
  private factory: ethers.Contract;
  private wallet?: ethers.Wallet;
  private router?: ethers.Contract;

  private cycles: Map<string, CycleWithState> = new Map();
  private options: Required<Omit<ArbitrageOptions, 'wssUrl' | 'optimizeAmountIn' | 'minAmountIn' | 'maxAmountIn' | 'optimizationInterval' | 'optimizationPrecision'>> & {
    wssUrl?: string;
    optimizeAmountIn: boolean;
    minAmountIn: bigint;
    maxAmountIn: bigint;
    optimizationInterval: number;
    optimizationPrecision: bigint;
  };

  constructor(
    provider: ethers.Provider,
    clusters: CycleCluster[],
    options: ArbitrageOptions = {}
  ) {
    this.provider = provider;
    this.options = {
      minArbitrageBps: options.minArbitrageBps ?? 2,
      scanIntervalMs: options.scanIntervalMs ?? 10,
      amountIn: options.amountIn ?? BigInt(1e18), // 1 token (18 decimals)
      wssUrl: options.wssUrl,
      optimizeAmountIn: options.optimizeAmountIn ?? false,
      minAmountIn: options.minAmountIn ?? BigInt(1e17), // 0.1 tokens
      maxAmountIn: options.maxAmountIn ?? BigInt(1e20), // 100 tokens
      optimizationInterval: options.optimizationInterval ?? 100,
      optimizationPrecision: options.optimizationPrecision ?? BigInt(1e15), // 0.001 tokens
    };

    // Initialize cycles from clusters
    // Use global defaults from options (already set above)
    const globalMinAmountIn = this.options.minAmountIn;
    const globalMaxAmountIn = this.options.maxAmountIn;

    for (const cluster of clusters) {
      for (const cycle of cluster.cycles) {
        const cycleId = this.getCycleId(cycle);
        this.cycles.set(cycleId, {
          ...cycle,
          poolAddresses: [],
          cycleId,
          // Use cycle-specific config if provided, otherwise use global defaults
          minAmountIn: cycle.minAmountIn ?? globalMinAmountIn,
          maxAmountIn: cycle.maxAmountIn ?? globalMaxAmountIn,
        });
      }
    }

    // Initialize StateFetcher with WebSocket
    this.stateFetcher = new StateFetcher(
      provider,
      undefined,
      this.options.wssUrl
        ? {
            wssUrl: this.options.wssUrl,
            reconnectMaxRetries: 0, // infinite retries
          }
        : undefined
    );

    this.quoter = new QuoterV3(this.stateFetcher);
    this.factory = new ethers.Contract(PANCAKE_V3_FACTORY, FACTORY_ABI, this.provider);
  }

  /**
   * Generate unique ID for cycle
   */
  private getCycleId(cycle: CycleConfig): string {
    return `${cycle.tokens.join('-')}-${cycle.fees.join('-')}`;
  }

  /**
   * Set wallet and router for execution (optional - for execution mode)
   */
  setExecution(wallet: ethers.Wallet): void {
    this.wallet = wallet;
    this.router = new ethers.Contract(BITSWAP_V3_ROUTER, ROUTER_ABI, wallet);
  }

  /**
   * Initialize: Fetch pool addresses and subscribe to WebSocket
   */
  async initialize(): Promise<void> {
    console.log('=== Cycle Arbitrage ===\n');
    console.log(`Total cycles: ${this.cycles.size}\n`);

    // Fetch pool addresses for all cycles
    console.log('Fetching pool addresses...');
    for (const [cycleId, cycle] of this.cycles.entries()) {
      console.log(`\nCycle: ${cycle.tokens.join(' -> ')} (${cycleId})`);
      cycle.poolAddresses = [];

      for (let i = 0; i < cycle.tokens.length - 1; i++) {
        const poolAddress = await this.getPoolAddress(
          cycle.addresses[i],
          cycle.addresses[i + 1],
          cycle.fees[i]
        );
        cycle.poolAddresses.push(poolAddress);
        console.log(`  Pool ${i + 1}: ${poolAddress}`);
      }
    }

    // Fetch initial pool states (deduplicate pool addresses)
    console.log('\nFetching initial pool states...');
    const allPoolAddresses = new Set<string>();
    for (const cycle of this.cycles.values()) {
      for (const poolAddress of cycle.poolAddresses) {
        allPoolAddresses.add(poolAddress);
      }
    }

    for (const poolAddress of allPoolAddresses) {
      await this.stateFetcher.fetchPoolState(poolAddress);
    }

    // Start WebSocket if configured
    if (this.options.wssUrl) {
      await this.stateFetcher.startWebSocket();
      console.log('✓ WebSocket connected\n');
    } else {
      console.log('⚠ WebSocket not configured (using polling)\n');
    }
  }

  /**
   * Estimate amount out for a specific cycle (multi-hop)
   * Fee is already handled by QuoterV3 internally
   */
  async estimateAmountOutForCycle(cycleId: string, amountIn: bigint): Promise<bigint> {
    const cycle = this.cycles.get(cycleId);
    if (!cycle) {
      throw new Error(`Cycle not found: ${cycleId}`);
    }

    let amountOut = amountIn;

    // Iterate through each hop
    for (let i = 0; i < cycle.tokens.length - 1; i++) {
      const poolAddress = cycle.poolAddresses[i];
      const tokenIn = cycle.addresses[i];

      // Get pool state from cache (sync - already fetched in initialize)
      const poolState = this.stateFetcher.getPoolState(poolAddress);
      if (!poolState) {
        throw new Error(`Pool state not found in cache: ${poolAddress}. Make sure initialize() was called.`);
      }
      const zeroForOne = poolState.token0.toLowerCase() === tokenIn.toLowerCase();

      // Quote single hop (fee handled internally by QuoterV3)
      amountOut = await this.quoter.quoteExactInputSingle(
        poolAddress,
        zeroForOne,
        amountOut
      );
    }

    return amountOut;
  }

  /**
   * Calculate arbitrage BPS for a given amountIn
   */
  private async calculateArbitrageBps(
    cycleId: string,
    amountIn: bigint
  ): Promise<number> {
    const amountOut = await this.estimateAmountOutForCycle(cycleId, amountIn);
    return Number(
      ((amountOut - amountIn) * BigInt(1e4)) / amountIn
    );
  }

  /**
   * Find optimal amountIn that maximizes arbitrageBps using Ternary Search
   * Ternary search works well for unimodal functions (single peak)
   */
  private async findOptimalAmountIn(
    cycleId: string,
    minAmount: bigint,
    maxAmount: bigint,
    precision: bigint
  ): Promise<{ amountIn: bigint; arbitrageBps: number }> {
    let left = minAmount;
    let right = maxAmount;

    // Ternary search
    while (right - left > precision) {
      const third = (right - left) / 3n;
      const mid1 = left + third;
      const mid2 = right - third;

      const [arb1, arb2] = await Promise.all([
        this.calculateArbitrageBps(cycleId, mid1),
        this.calculateArbitrageBps(cycleId, mid2),
      ]);

      if (arb1 > arb2) {
        right = mid2;
      } else {
        left = mid1;
      }
    }

    const optimalAmount = (left + right) / 2n;
    const optimalArb = await this.calculateArbitrageBps(cycleId, optimalAmount);

    return { amountIn: optimalAmount, arbitrageBps: optimalArb };
  }

  /**
   * Scan a single cycle continuously with optional amountIn optimization
   */
  private async scanCycle(cycleId: string): Promise<void> {
    const cycle = this.cycles.get(cycleId);
    if (!cycle) return;

    let scanCount = 0;
    let currentAmountIn = this.options.amountIn;
    let optimalAmountIn = this.options.amountIn;
    let optimalArbBps = 0;

    // Use cycle-specific min/max amounts (already set in constructor)
    const minAmountIn = cycle.minAmountIn;
    const maxAmountIn = cycle.maxAmountIn;

    // Initial optimization if enabled
    if (this.options.optimizeAmountIn) {
      console.log(
        `[${cycleId}] Finding optimal amountIn (range: ${ethers.formatEther(minAmountIn)} - ${ethers.formatEther(maxAmountIn)})...`
      );
      try {
        const optimal = await this.findOptimalAmountIn(
          cycleId,
          minAmountIn,
          maxAmountIn,
          this.options.optimizationPrecision
        );
        optimalAmountIn = optimal.amountIn;
        optimalArbBps = optimal.arbitrageBps;
        currentAmountIn = optimalAmountIn;
        console.log(
          `[${cycleId}] Optimal: ${ethers.formatEther(optimalAmountIn)} tokens, ` +
          `arb: ${optimalArbBps.toFixed(2)} bps\n`
        );
      } catch (error) {
        console.error(`[${cycleId}] Optimization failed:`, error);
        console.log(`[${cycleId}] Using default amountIn: ${ethers.formatEther(this.options.amountIn)}\n`);
      }
    }

    while (true) {
      try {
        // Re-optimize periodically if enabled
        if (
          this.options.optimizeAmountIn &&
          scanCount > 0 &&
          scanCount % this.options.optimizationInterval === 0
        ) {
          try {
            const optimal = await this.findOptimalAmountIn(
              cycleId,
              minAmountIn,
              maxAmountIn,
              this.options.optimizationPrecision
            );
            if (optimal.arbitrageBps > optimalArbBps) {
              optimalAmountIn = optimal.amountIn;
              optimalArbBps = optimal.arbitrageBps;
              currentAmountIn = optimalAmountIn;
              console.log(
                `[${cycleId}] Re-optimized: ${ethers.formatEther(optimalAmountIn)} tokens, ` +
                `arb: ${optimalArbBps.toFixed(2)} bps`
              );
            }
          } catch (error) {
            console.error(`[${cycleId}] Re-optimization failed:`, error);
          }
        }

        const amountOut = await this.estimateAmountOutForCycle(
          cycleId,
          currentAmountIn
        );

        // Calculate arbitrage in bps
        const arbitrageBps = Number(
          ((amountOut - currentAmountIn) * BigInt(1e4)) /
          currentAmountIn
        );

        scanCount++;

        if (arbitrageBps > this.options.minArbitrageBps) {
          const timestamp = new Date().toISOString();
          console.log(`[${timestamp}] 🎯 Arbitrage detected!`);
          console.log(`  Cycle: ${cycle.tokens.join(' -> ')}`);
          console.log(`  Arbitrage: ${arbitrageBps.toFixed(2)} bps`);
          console.log(`  Amount in:  ${ethers.formatEther(currentAmountIn)}`);
          console.log(`  Amount out: ${ethers.formatEther(amountOut)}`);
          console.log(`  Profit:     ${ethers.formatEther(amountOut - currentAmountIn)}`);
          if (this.options.optimizeAmountIn) {
            console.log(
              `  Optimal amount: ${ethers.formatEther(optimalAmountIn)} (arb: ${optimalArbBps.toFixed(2)} bps)`
            );
          }
          console.log();

          // Execute if wallet/router is set
          if (this.wallet && this.router) {
            // Use optimal amount if available and better
            const executeAmount =
              this.options.optimizeAmountIn && optimalArbBps > arbitrageBps
                ? optimalAmountIn
                : currentAmountIn;

            const executeAmountOut = await this.estimateAmountOutForCycle(
              cycleId,
              executeAmount
            );

            await this.executeCycle(cycleId, executeAmount, executeAmountOut);
          }
        } else if (scanCount % 1000 === 0) {
          console.log(
            `[${new Date().toISOString()}] [${cycleId}] Scanning... ` +
            `(arb: ${arbitrageBps.toFixed(2)} bps, amount: ${ethers.formatEther(currentAmountIn)}, scans: ${scanCount})`
          );
        }

        await this.sleep(this.options.scanIntervalMs);
      } catch (error) {
        console.error(
          `[${new Date().toISOString()}] [${cycleId}] Scan error:`,
          error
        );
        await this.sleep(5000);
      }
    }
  }

  /**
   * Scan all cycles in parallel
   */
  async scan(): Promise<void> {
    console.log('Starting arbitrage scan...');
    console.log(`  Min arbitrage: ${this.options.minArbitrageBps} bps`);
    console.log(`  Scan interval: ${this.options.scanIntervalMs}ms`);
    console.log(`  Test amount: ${ethers.formatEther(this.options.amountIn)} tokens`);
    console.log(`  Cycles: ${this.cycles.size}\n`);

    // Start scanning each cycle in parallel
    const scanTasks = Array.from(this.cycles.keys()).map((cycleId) =>
      this.scanCycle(cycleId)
    );

    // Wait for all tasks (they run forever, so this never resolves)
    await Promise.all(scanTasks);
  }

  /**
   * Execute arbitrage trade for a specific cycle
   */
  private async executeCycle(
    cycleId: string,
    amountIn: bigint,
    estimatedOut: bigint
  ): Promise<void> {
    const cycle = this.cycles.get(cycleId);
    if (!cycle || !this.wallet || !this.router) {
      return;
    }

    try {
      // Apply slippage (10 bps)
      const minAmountOut = (estimatedOut * BigInt(9990)) / BigInt(10000);

      // Encode swap path
      const path = this.encodeSwapPath(cycle.addresses, cycle.fees);

      console.log(`  [${cycleId}] Executing swap...`);

      // Execute swap
      const tx = await this.router.swapExactInput({
        path,
        recipient: this.wallet.address,
        deadline: Math.floor(Date.now() / 1000) + 60, // 60 seconds
        amountIn,
        amountOutMinimum: minAmountOut,
      });

      console.log(`  [${cycleId}] TX hash: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`  [${cycleId}] ✓ Swap confirmed: ${receipt.hash}\n`);

      // Analyze result
      await this.analyze(receipt, amountIn);
    } catch (error: any) {
      console.error(`  [${cycleId}] ✗ Execution failed:`, error.message || error);
    }
  }

  /**
   * Analyze trade result
   */
  private async analyze(receipt: any, amountIn: bigint): Promise<void> {
    try {
      // Parse Swap events from receipt
      const actualOut = await this.parseReceiptAmounts(receipt);
      const profitBps = Number(
        ((actualOut - amountIn) * BigInt(1e4)) / amountIn
      );

      console.log('  Trade Analysis:');
      console.log(`    Profit: ${profitBps.toFixed(2)} bps`);
      console.log(`    Actual out: ${ethers.formatEther(actualOut)}`);
      console.log(`    Actual profit: ${ethers.formatEther(actualOut - amountIn)}\n`);
    } catch (error) {
      console.error('  ⚠ Could not parse receipt:', error);
    }
  }

  /**
   * Get pool address from factory
   */
  private async getPoolAddress(
    token0: string,
    token1: string,
    fee: number
  ): Promise<string> {
    // Sort tokens (Uniswap V3 requirement)
    const [t0, t1] = [token0, token1].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );

    const poolAddress = await this.factory.getPool(t0, t1, fee);

    if (poolAddress === ethers.ZeroAddress) {
      throw new Error(`Pool not found for ${token0}/${token1} with fee ${fee}`);
    }

    return poolAddress;
  }

  /**
   * Encode V3 swap path: token0 (20 bytes) + fee (3 bytes) + token1 (20 bytes) ...
   */
  private encodeSwapPath(addresses: string[], fees: number[]): string {
    if (addresses.length < 2 || fees.length !== addresses.length - 1) {
      throw new Error('Invalid path: addresses and fees mismatch');
    }

    let path = '0x';
    for (let i = 0; i < fees.length; i++) {
      // Address (20 bytes, remove 0x)
      path += addresses[i].slice(2).toLowerCase();
      // Fee (3 bytes, big-endian, hex)
      path += fees[i].toString(16).padStart(6, '0');
    }
    // Last address
    path += addresses[addresses.length - 1].slice(2).toLowerCase();

    return path;
  }

  /**
   * Parse receipt to get actual output amount
   * Simplified version - gets last swap event's amountOut
   */
  private async parseReceiptAmounts(receipt: any): Promise<bigint> {
    // Find Swap events
    const swapLogs = receipt.logs.filter(
      (log: any) => log.topics[0] === SWAP_EVENT_TOPIC
    );

    if (swapLogs.length === 0) {
      throw new Error('No Swap events found in receipt');
    }

    // Get the last swap (final output)
    const lastSwap = swapLogs[swapLogs.length - 1];

    // Decode the data field
    // Swap event data: amount0, amount1, sqrtPriceX96, liquidity, tick, fee0, fee1
    // We need to decode this properly - for now, return a placeholder
    // In production, you should decode using ethers Interface
    const poolAbi = [
      {
        type: 'event',
        name: 'Swap',
        inputs: [
          { indexed: true, name: 'sender', type: 'address' },
          { indexed: true, name: 'recipient', type: 'address' },
          { indexed: false, name: 'amount0', type: 'int256' },
          { indexed: false, name: 'amount1', type: 'int256' },
          { indexed: false, name: 'sqrtPriceX96', type: 'uint160' },
          { indexed: false, name: 'liquidity', type: 'uint128' },
          { indexed: false, name: 'tick', type: 'int24' },
          { indexed: false, name: 'protocolFeesToken0', type: 'uint128' },
          { indexed: false, name: 'protocolFeesToken1', type: 'uint128' },
        ],
      },
    ];

    const poolInterface = new ethers.Interface(poolAbi);
    const decoded = poolInterface.parseLog({
      topics: lastSwap.topics,
      data: lastSwap.data,
    });

    if (!decoded) {
      throw new Error('Could not decode swap event');
    }

    // Get the output amount (positive value)
    const amount0 = decoded.args[2] as bigint;
    const amount1 = decoded.args[3] as bigint;

    // Output is the positive amount
    const actualOut = amount0 > 0n ? amount0 : amount1;

    return actualOut > 0n ? actualOut : -actualOut; // Ensure positive
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

