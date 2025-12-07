/**
 * Cycle Arbitrage - Auto-Discovery Mode
 * Orchestrates cycle discovery, scanning, and execution
 */

import { ethers } from 'ethers';
import { QuoterV3, StateFetcher } from 'uniswap-v3-quoter';
import winston from 'winston';
import { createLogger } from './logger.js';
import * as CONSTANTS from './constants.js';
import { AmountOptimizer } from './optimization/amountOptimizer.js';
import { MetricsCollector } from './monitoring/metrics.js';
import { DashboardServer } from './monitoring/dashboard.js';
import { PoolMatrixBuilder } from './poolMatrix/poolMatrixBuilder.js';
import { PathFinder } from './poolMatrix/pathFinder.js';
import { TokenRegistry } from './tokens/tokenRegistry.js';
import {
  CycleDiscoveryService,
  CycleFormatter,
  CycleScanner,
  TradeExecutor,
  BundleConfig,
  ArbitrageContractConfig,
} from './services/index.js';
import { computePoolAddress } from './utils/poolHelper.js';

export interface TokenAmountConfig {
  minAmountIn: bigint;
  maxAmountIn: bigint;
}

export interface CycleConfig {
  tokens: string[]; // ["USDT", "WBNB", "USDT"]
  addresses: string[]; // BSC addresses
  fees: number[]; // [500, 100] in bps
}


export interface CycleWithState extends CycleConfig {
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
  optimizationInterval?: number; // Re-optimize every N scans (default: 100)
  optimizationPrecision?: bigint; // Precision for ternary search (default: 0.001 tokens)
  logDir?: string; // Log directory path (default: 'log')
  dashboardPort?: number; // HTTP dashboard port (default: undefined, disabled)
  historyDir?: string; // History data directory path (default: 'data/history')
  maxHops?: number; // Maximum hops for cycle discovery (default: 3)
  discoveryFees?: number[]; // Fees to try during discovery (default: [100, 500, 2500, 10000])
}

/**
 * Cycle Arbitrage - Auto-Discovery Mode
 */
export class CycleArbitrage {
  private provider: ethers.Provider;
  private stateFetcher: StateFetcher;
  private quoter: QuoterV3;
  private logger: winston.Logger;
  private amountOptimizer?: AmountOptimizer;
  private metrics: MetricsCollector;
  private dashboard?: DashboardServer;
  private poolMatrixBuilder: PoolMatrixBuilder;
  private pathFinder: PathFinder;
  private tokenRegistry: TokenRegistry;
  private cycleDiscovery: CycleDiscoveryService;
  private formatter: CycleFormatter;
  private tradeExecutor?: TradeExecutor;

  private cycles: Map<string, CycleWithState> = new Map();
  private options: Required<Omit<ArbitrageOptions, 'wssUrl' | 'optimizeAmountIn' | 'optimizationInterval' | 'optimizationPrecision' | 'logDir' | 'dashboardPort' | 'historyDir' | 'maxHops' | 'discoveryFees'>> & {
    wssUrl?: string;
    optimizeAmountIn: boolean;
    optimizationInterval: number;
    optimizationPrecision: bigint;
    logDir: string;
    historyDir: string;
    dashboardPort?: number;
    maxHops: number;
    discoveryFees: number[];
  };

  constructor(
    provider: ethers.Provider,
    tokenRegistry: TokenRegistry,
    options: ArbitrageOptions = {}
  ) {
    this.provider = provider;
    this.tokenRegistry = tokenRegistry;
    this.options = {
      minArbitrageBps: options.minArbitrageBps ?? 2,
      scanIntervalMs: options.scanIntervalMs ?? 10,
      amountIn: options.amountIn ?? BigInt(1e18), // 1 token (18 decimals)
      wssUrl: options.wssUrl,
      optimizeAmountIn: options.optimizeAmountIn ?? false,
      optimizationInterval: options.optimizationInterval ?? 100,
      optimizationPrecision: options.optimizationPrecision ?? BigInt(1e15), // 0.001 tokens
      logDir: options.logDir ?? 'log',
      historyDir: options.historyDir ?? 'data/history',
      maxHops: options.maxHops ?? 3,
      discoveryFees: options.discoveryFees ?? [100, 500, 2500, 10000],
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

    // Initialize pool matrix builder and path finder
    // Pass tokenRegistry to PoolMatrixBuilder for liquidity checks
    this.poolMatrixBuilder = new PoolMatrixBuilder(provider, this.tokenRegistry);
    this.pathFinder = new PathFinder();

    // Initialize services
    this.cycleDiscovery = new CycleDiscoveryService(
      this.poolMatrixBuilder,
      this.pathFinder,
      this.tokenRegistry,
      this.logger
    );
    this.formatter = new CycleFormatter(this.tokenRegistry);

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

    // Initialize AmountOptimizer if optimization is enabled
    if (this.options.optimizeAmountIn) {
      this.amountOptimizer = new AmountOptimizer(
        (cycleId: string, amountIn: bigint) => this.calculateArbitrageBps(cycleId, amountIn)
      );
    }
  }

  /**
   * Discover cycles automatically from token list
   * Builds pool matrix and finds all valid cycles
   */
  async discoverCycles(): Promise<CycleConfig[]> {
    const cyclesWithAmounts = await this.cycleDiscovery.discoverCycles(
      this.options.maxHops,
      this.options.discoveryFees
    );

    // Log cycles with readable format
    for (let i = 0; i < cyclesWithAmounts.length; i++) {
      const cycle = cyclesWithAmounts[i];
      this.logger.info(this.formatter.formatCycleForLog(cycle, i));
    }

    // Register cycles for monitoring
    for (const cycle of cyclesWithAmounts) {
      this.cycles.set(cycle.cycleId, {
        ...cycle,
        poolAddresses: [],
      });
    }

    return cyclesWithAmounts;
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
   * Set wallet and arbitrage contract for execution (bundle mode only)
   */
  setExecution(
    wallet: ethers.Wallet,
    bundleConfig: BundleConfig,
    contractAddress: string
  ): void {
    const contractConfig: ArbitrageContractConfig = {
      contractAddress,
      contractABI: CONSTANTS.ARBITRAGE_CONTRACT_ABI,
    };

    this.tradeExecutor = new TradeExecutor(
      wallet,
      this.logger,
      bundleConfig,
      contractConfig
    );

    // Subscribe to TradeExecutor events
    this.tradeExecutor.on('opportunity', (data) => {
      this.metrics.recordOpportunity(data.cycleId, data.arbitrageBps, data.amountIn);
    });

    this.tradeExecutor.on('execution', (data) => {
      this.metrics.recordExecution(data.cycleId, data.profit);
    });
  }

  /**
   * Initialize: Discover cycles, fetch pool addresses and subscribe to WebSocket
   */
  async initialize(): Promise<void> {
    this.logger.info('=== Cycle Arbitrage ===');

    // Initialize token registry (load decimal cache from file)
    await this.tokenRegistry.initialize();

    // Initialize pool matrix builder cache (load pool existence cache from file)
    await this.poolMatrixBuilder.initialize();

    // Discover cycles if not already discovered
    if (this.cycles.size === 0) {
      await this.discoverCycles();
    }

    this.logger.info(`Total cycles: ${this.cycles.size}`);

    // Fetch pool addresses for all cycles
    this.logger.info('Fetching pool addresses...');
    for (const [cycleId, cycle] of this.cycles.entries()) {
      const tokensPath = this.formatter.formatCyclePath(cycle.tokens);
      this.logger.info(`Cycle: ${tokensPath} (${cycleId})`);
      cycle.poolAddresses = [];

      for (let i = 0; i < cycle.tokens.length - 1; i++) {
        const poolAddress = this.getPoolAddress(
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

    const scanner = new CycleScanner(
      cycleId,
      cycle,
      (cid: string, amountIn: bigint) => this.estimateAmountOutForCycle(cid, amountIn),
      {
        minArbitrageBps: this.options.minArbitrageBps,
        scanIntervalMs: this.options.scanIntervalMs,
        amountIn: this.options.amountIn,
        optimizeAmountIn: this.options.optimizeAmountIn,
        optimizationInterval: this.options.optimizationInterval,
        optimizationPrecision: this.options.optimizationPrecision,
      },
      this.amountOptimizer,
      this.logger,
      this.formatter
    );

    // Subscribe to CycleScanner events
    scanner.on('scan', (data) => {
      this.metrics.recordScan(data.cycleId);
    });

    scanner.on('opportunity', async (data) => {
      // Record metrics
      this.metrics.recordOpportunity(data.cycleId, data.arbitrageBps, data.amountIn);

      // Execute trade if tradeExecutor is set
      if (this.tradeExecutor) {
        const executeAmount =
          this.options.optimizeAmountIn &&
            data.optimalArbBps &&
            data.optimalArbBps > data.arbitrageBps
            ? data.optimalAmountIn!
            : data.amountIn;

        // Lấy từ data, không estimate lại
        const executeAmountOut =
          executeAmount === data.amountIn
            ? data.amountOut
            : data.optimalAmountOut!;

        await this.tradeExecutor.executeCycle(
          cycleId,
          cycle,
          executeAmount,
          executeAmountOut
        );
      }
    });

    scanner.on('arbitrage-bps', (data) => {
      this.metrics.recordArbitrageBps(data.cycleId, data.arbitrageBps);
    });

    scanner.on('optimization-result', (data) => {
      this.metrics.recordOptimizationResult(data.cycleId, data.amountIn, data.arbitrageBps);
    });

    await scanner.start();
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
   * Get pool address using off-chain CREATE2 computation (no on-chain call)
   * This is much faster than calling factory.getPool() on-chain
   * 
   * Note: This computes the address but doesn't verify the pool exists.
   * The address will be valid if the pool has been deployed.
   */
  private getPoolAddress(
    token0: string,
    token1: string,
    fee: number
  ): string {
    return computePoolAddress(token0, token1, fee);
  }


}

