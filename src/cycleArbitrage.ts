/**
 * Cycle Arbitrage - Support Cycle Clusters
 * Minimal implementation for cycle arbitrage on PancakeSwap V3
 */

import { ethers } from 'ethers';
import { QuoterV3, StateFetcher } from 'uniswap-v3-quoter';
import winston from 'winston';
import { createLogger } from './logger';
import * as CONSTANTS from './constants';
import { AmountOptimizer } from './optimization/amountOptimizer';
import { MetricsCollector } from './monitoring/metrics';
import { DashboardServer } from './monitoring/dashboard';

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
  logDir?: string; // Log directory path (default: 'log')
  dashboardPort?: number; // HTTP dashboard port (default: undefined, disabled)
  historyDir?: string; // History data directory path (default: 'data/history')
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
  private logger: winston.Logger;
  private amountOptimizer?: AmountOptimizer;
  private metrics: MetricsCollector;
  private dashboard?: DashboardServer;

  private cycles: Map<string, CycleWithState> = new Map();
  private options: Required<Omit<ArbitrageOptions, 'wssUrl' | 'optimizeAmountIn' | 'minAmountIn' | 'maxAmountIn' | 'optimizationInterval' | 'optimizationPrecision' | 'logDir' | 'dashboardPort' | 'historyDir'>> & {
    wssUrl?: string;
    optimizeAmountIn: boolean;
    minAmountIn: bigint;
    maxAmountIn: bigint;
    optimizationInterval: number;
    optimizationPrecision: bigint;
    logDir: string;
    historyDir: string;
    dashboardPort?: number;
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
      logDir: options.logDir ?? 'log',
      historyDir: options.historyDir ?? 'data/history',
    };

    // Initialize logger
    this.logger = createLogger(this.options.logDir);

    // Initialize metrics collector with history persistence
    this.metrics = new MetricsCollector(this.options.historyDir);

    // Initialize dashboard if port is specified
    if (options.dashboardPort) {
      this.dashboard = new DashboardServer(this.metrics, options.dashboardPort);
      this.dashboard.start();
      this.logger.info(`Dashboard started on port ${options.dashboardPort}`);
    }

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
    this.factory = new ethers.Contract(CONSTANTS.PANCAKE_V3_FACTORY, CONSTANTS.FACTORY_ABI, this.provider);

    // Initialize AmountOptimizer if optimization is enabled
    if (this.options.optimizeAmountIn) {
      this.amountOptimizer = new AmountOptimizer(
        (cycleId: string, amountIn: bigint) => this.calculateArbitrageBps(cycleId, amountIn)
      );
    }
  }

  /**
   * Calculate arbitrage BPS for a given amountIn
   * Used by AmountOptimizer
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
    this.router = new ethers.Contract(CONSTANTS.BITSWAP_V3_ROUTER, CONSTANTS.ROUTER_ABI, wallet);
  }

  /**
   * Initialize: Fetch pool addresses and subscribe to WebSocket
   */
  async initialize(): Promise<void> {
    this.logger.info('=== Cycle Arbitrage ===');
    this.logger.info(`Total cycles: ${this.cycles.size}`);

    // Fetch pool addresses for all cycles
    this.logger.info('Fetching pool addresses...');
    for (const [cycleId, cycle] of this.cycles.entries()) {
      this.logger.info(`Cycle: ${cycle.tokens.join(' -> ')} (${cycleId})`);
      cycle.poolAddresses = [];

      for (let i = 0; i < cycle.tokens.length - 1; i++) {
        const poolAddress = await this.getPoolAddress(
          cycle.addresses[i],
          cycle.addresses[i + 1],
          cycle.fees[i]
        );
        cycle.poolAddresses.push(poolAddress);
        this.logger.info(`  Pool ${i + 1}: ${poolAddress}`);
      }
    }

    // Fetch initial pool states (deduplicate pool addresses)
    this.logger.info('Fetching initial pool states...');
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
      this.logger.info('✓ WebSocket connected');
    } else {
      this.logger.warn('⚠ WebSocket not configured (using polling)');
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
    if (this.options.optimizeAmountIn && this.amountOptimizer) {
      this.logger.info(
        `[${cycleId}] Finding optimal amountIn (range: ${ethers.formatEther(minAmountIn)} - ${ethers.formatEther(maxAmountIn)})...`
      );
      try {
        const optimal = await this.amountOptimizer.findOptimalAmountIn(
          cycleId,
          minAmountIn,
          maxAmountIn,
          this.options.optimizationPrecision
        );
        optimalAmountIn = optimal.amountIn;
        optimalArbBps = optimal.arbitrageBps;
        currentAmountIn = optimalAmountIn;
        
        // Record optimization result (best amountIn)
        this.metrics.recordOptimizationResult(cycleId, optimalAmountIn, optimalArbBps);
        
        this.logger.info(
          `[${cycleId}] Optimal: ${ethers.formatEther(optimalAmountIn)} tokens, ` +
          `arb: ${optimalArbBps.toFixed(2)} bps`
        );
      } catch (error) {
        this.logger.error(`[${cycleId}] Optimization failed:`, error);
        this.logger.info(`[${cycleId}] Using default amountIn: ${ethers.formatEther(this.options.amountIn)}`);
      }
    }

    while (true) {
      try {
        // Record scan
        this.metrics.recordScan(cycleId);

        // Re-optimize periodically if enabled
        if (
          this.options.optimizeAmountIn &&
          this.amountOptimizer &&
          scanCount > 0 &&
          scanCount % this.options.optimizationInterval === 0
        ) {
          try {
            const optimal = await this.amountOptimizer.findOptimalAmountIn(
              cycleId,
              minAmountIn,
              maxAmountIn,
              this.options.optimizationPrecision
            );
            if (optimal.arbitrageBps > optimalArbBps) {
              optimalAmountIn = optimal.amountIn;
              optimalArbBps = optimal.arbitrageBps;
              currentAmountIn = optimalAmountIn;
              
              // Record optimization result (best amountIn)
              this.metrics.recordOptimizationResult(cycleId, optimalAmountIn, optimalArbBps);
              
              this.logger.info(
                `[${cycleId}] Re-optimized: ${ethers.formatEther(optimalAmountIn)} tokens, ` +
                `arb: ${optimalArbBps.toFixed(2)} bps`
              );
            }
          } catch (error) {
            this.logger.error(`[${cycleId}] Re-optimization failed:`, error);
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

        // Record arbitrage BPS for historical chart (every 1000 scans)
        if (scanCount % 1000 === 0) {
          this.metrics.recordArbitrageBps(cycleId, arbitrageBps);
        }

        if (arbitrageBps > this.options.minArbitrageBps) {
          // Record opportunity với amountIn
          this.metrics.recordOpportunity(cycleId, arbitrageBps, currentAmountIn);

          const timestamp = new Date().toISOString();
          this.logger.info('🎯 Arbitrage detected!', {
            cycle: cycle.tokens.join(' -> '),
            cycleId,
            arbitrageBps: arbitrageBps.toFixed(2),
            amountIn: ethers.formatEther(currentAmountIn),
            amountOut: ethers.formatEther(amountOut),
            profit: ethers.formatEther(amountOut - currentAmountIn),
            optimalAmount: this.options.optimizeAmountIn ? ethers.formatEther(optimalAmountIn) : undefined,
            optimalArbBps: this.options.optimizeAmountIn ? optimalArbBps.toFixed(2) : undefined,
            timestamp,
          });

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
          this.logger.info(
            `[${cycleId}] Scanning... ` +
            `(arb: ${arbitrageBps.toFixed(2)} bps, amount: ${ethers.formatEther(currentAmountIn)}, scans: ${scanCount})`
          );
        }

        await this.sleep(this.options.scanIntervalMs);
      } catch (error) {
        this.logger.error(
          `[${cycleId}] Scan error:`,
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
    this.logger.info('Starting arbitrage scan...');
    this.logger.info(`  Min arbitrage: ${this.options.minArbitrageBps} bps`);
    this.logger.info(`  Scan interval: ${this.options.scanIntervalMs}ms`);
    this.logger.info(`  Test amount: ${ethers.formatEther(this.options.amountIn)} tokens`);
    this.logger.info(`  Cycles: ${this.cycles.size}`);

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

      this.logger.info(`[${cycleId}] Executing swap...`);

      // Execute swap
      const tx = await this.router.swapExactInput({
        path,
        recipient: this.wallet.address,
        deadline: Math.floor(Date.now() / 1000) + 60, // 60 seconds
        amountIn,
        amountOutMinimum: minAmountOut,
      });

      this.logger.info(`[${cycleId}] TX hash: ${tx.hash}`);
      const receipt = await tx.wait();
      this.logger.info(`[${cycleId}] ✓ Swap confirmed: ${receipt.hash}`);

      // Analyze result
      const profit = await this.analyze(receipt, amountIn);

      // Record execution
      if (profit !== null) {
        this.metrics.recordExecution(cycleId, profit);
      }
    } catch (error: any) {
      this.logger.error(`[${cycleId}] ✗ Execution failed:`, error.message || error);
    }
  }

  /**
   * Analyze trade result
   * Returns profit amount (bigint) or null if parsing failed
   */
  private async analyze(receipt: any, amountIn: bigint): Promise<bigint | null> {
    try {
      // Parse Swap events from receipt
      const actualOut = await this.parseReceiptAmounts(receipt);
      const profit = actualOut - amountIn;
      const profitBps = Number((profit * BigInt(1e4)) / amountIn);

      this.logger.info('Trade Analysis:', {
        profitBps: profitBps.toFixed(2),
        actualOut: ethers.formatEther(actualOut),
        actualProfit: ethers.formatEther(profit),
      });

      return profit;
    } catch (error) {
      this.logger.error('⚠ Could not parse receipt:', error);
      return null;
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
      (log: any) => log.topics[0] === CONSTANTS.SWAP_EVENT_TOPIC
    );

    if (swapLogs.length === 0) {
      throw new Error('No Swap events found in receipt');
    }

    // Get the last swap (final output)
    const lastSwap = swapLogs[swapLogs.length - 1];

    // Decode the data field
    // Swap event data: amount0, amount1, sqrtPriceX96, liquidity, tick, fee0, fee1
    const poolInterface = new ethers.Interface(CONSTANTS.POOL_SWAP_ABI);
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

