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
import { PoolAddressResolver } from './poolMatrix/poolAddressResolver.js';
import { TokenRegistry } from './tokens/tokenRegistry.js';
import {
  CycleDiscoveryService,
  CycleFormatter,
  CycleScanner,
  TradeExecutor,
  BundleConfig,
  ArbitrageContractConfig,
} from './services/index.js';
import { CycleEstimator } from './estimation/cycleEstimator.js';
import { TelegramNotifier, TelegramConfig } from './notifications/index.js';

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
  telegramConfig?: TelegramConfig; // Telegram notification configuration (optional)
}

/**
 * Cycle Arbitrage - Auto-Discovery Mode
 */
export class CycleArbitrage {
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

  // Separated components following SRP
  private cycleEstimator: CycleEstimator;
  private poolAddressResolver: PoolAddressResolver;

  // Notifications
  private telegramNotifier?: TelegramNotifier;

  private cycles: Map<string, CycleWithState> = new Map();
  private scanners: Map<string, CycleScanner> = new Map(); // Track active scanners for cleanup
  private isRunning: boolean = false; // Track if scanning is active
  private options: Required<Omit<ArbitrageOptions, 'wssUrl' | 'optimizeAmountIn' | 'optimizationInterval' | 'optimizationPrecision' | 'logDir' | 'dashboardPort' | 'historyDir' | 'maxHops' | 'discoveryFees' | 'telegramConfig'>> & {
    wssUrl?: string;
    optimizeAmountIn: boolean;
    optimizationInterval: number;
    optimizationPrecision: bigint;
    logDir: string;
    historyDir: string;
    dashboardPort?: number;
    maxHops: number;
    discoveryFees: number[];
    telegramConfig?: TelegramConfig;
  };

  constructor(
    provider: ethers.Provider,
    tokenRegistry: TokenRegistry,
    options: ArbitrageOptions = {}
  ) {
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

    // Initialize separated components
    this.poolAddressResolver = new PoolAddressResolver(this.logger, this.formatter);

    // CycleEstimator will be initialized after cycles are discovered
    // We need to create a placeholder first, then update it in initialize()
    this.cycleEstimator = new CycleEstimator(
      this.stateFetcher,
      this.quoter,
      this.cycles,
      this.logger
    );

    // Initialize AmountOptimizer if optimization is enabled
    if (this.options.optimizeAmountIn) {
      this.amountOptimizer = new AmountOptimizer(
        (cycleId: string, amountIn: bigint) => this.cycleEstimator.calculateArbitrageBps(cycleId, amountIn)
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
    // Note: 'opportunity' event is emitted from CycleScanner, not from TradeExecutor
    // So we don't need to subscribe here

    this.tradeExecutor.on('execution', (data) => {
      // Record metrics
      this.metrics.recordExecution(
        data.cycleId,
        data.profit,
        data.txHash,
        data.amountIn,
        data.arbitrageBps
      );

      // Send Telegram notification
      if (this.telegramNotifier) {
        this.telegramNotifier.sendExecutionNotification({
          cycleId: data.cycleId,
          profit: data.profit,
          txHash: data.txHash,
          amountIn: data.amountIn,
          amountOut: data.amountOut,
          arbitrageBps: data.arbitrageBps,
        }).catch((error: any) => {
          // Log error but don't break execution flow
          this.logger.error('[Telegram] Notification error:', error?.message || String(error));
        });
      }
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

    // Resolve pool addresses for all cycles using PoolAddressResolver
    this.poolAddressResolver.resolveAllPoolAddresses(this.cycles);

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
   * Delegates to CycleEstimator
   * Fee is already handled by QuoterV3 internally
   */
  async estimateAmountOutForCycle(cycleId: string, amountIn: bigint): Promise<bigint> {
    return this.cycleEstimator.estimateAmountOutForCycle(cycleId, amountIn);
  }


  /**
   * Scan a single cycle continuously with optional amountIn optimization
   */
  private async scanCycle(cycleId: string): Promise<void> {
    const cycle = this.cycles.get(cycleId);
    if (!cycle) {
      this.logger.warn(`Cycle ${cycleId} not found, skipping scan`);
      return;
    }

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

    // Track scanner for cleanup
    this.scanners.set(cycleId, scanner);

    // Subscribe to CycleScanner events
    scanner.on('scan', (data) => {
      this.metrics.recordScan(data.cycleId);
    });

    scanner.on('opportunity', async (data) => {
      // Record metrics
      this.metrics.recordOpportunity(data.cycleId, data.arbitrageBps, data.amountIn);

      // Execute trade if tradeExecutor is set
      if (this.tradeExecutor) {
        try {
          // Determine which amount to use (optimized or default)
          let executeAmount: bigint;
          let executeAmountOut: bigint;

          if (
            this.options.optimizeAmountIn &&
            data.optimalArbBps &&
            data.optimalArbBps > data.arbitrageBps &&
            data.optimalAmountIn
          ) {
            // Use optimized amount if available and better
            executeAmount = data.optimalAmountIn;

            // Validate optimalAmountOut exists
            if (!data.optimalAmountOut) {
              this.logger.warn(
                `[${data.cycleId}] optimalAmountOut not available for optimalAmountIn, ` +
                `falling back to default amount. This may indicate a timing issue.`
              );
              // Fallback to default amount
              executeAmount = data.amountIn;
              executeAmountOut = data.amountOut;
            } else {
              executeAmountOut = data.optimalAmountOut;
            }
          } else {
            // Use default amount
            executeAmount = data.amountIn;
            executeAmountOut = data.amountOut;
          }

          // Validate amounts before execution
          if (executeAmount <= 0n) {
            this.logger.error(
              `[${data.cycleId}] Invalid executeAmount: ${executeAmount}. Skipping execution.`
            );
            return;
          }

          if (executeAmountOut <= 0n) {
            this.logger.error(
              `[${data.cycleId}] Invalid executeAmountOut: ${executeAmountOut}. Skipping execution.`
            );
            return;
          }

          await this.tradeExecutor.executeCycle(
            data.cycleId,
            cycle,
            executeAmount,
            executeAmountOut
          );
        } catch (error: any) {
          this.logger.error(
            `[${data.cycleId}] Failed to execute trade:`,
            error instanceof Error ? error.message : String(error)
          );
          // Don't throw - allow scanning to continue
        }
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
    if (this.isRunning) {
      this.logger.warn('Scan is already running. Call stop() first if you want to restart.');
      return;
    }

    this.isRunning = true;
    this.logger.info('Starting arbitrage scan...');
    this.logger.info(`  Min arbitrage: ${this.options.minArbitrageBps} bps`);
    this.logger.info(`  Scan interval: ${this.options.scanIntervalMs}ms`);
    this.logger.info(`  Test amount: ${ethers.formatEther(this.options.amountIn)} tokens`);
    this.logger.info(`  Cycles: ${this.cycles.size}`);

    try {
      // Start scanning each cycle in parallel
      const scanTasks = Array.from(this.cycles.keys()).map((cycleId) =>
        this.scanCycle(cycleId).catch((error) => {
          this.logger.error(`[${cycleId}] Scanner error:`, error);
          // Continue with other scanners even if one fails
        })
      );

      // Wait for all tasks (they run forever, so this never resolves unless stopped)
      await Promise.all(scanTasks);
    } catch (error) {
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Stop scanning and cleanup all resources
   * Gracefully shuts down scanners, WebSocket, dashboard, and metrics
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      this.logger.warn('Scan is not running. Nothing to stop.');
      return;
    }

    this.logger.info('Stopping Cycle Arbitrage...');
    this.isRunning = false;

    try {
      // Stop all scanners
      this.logger.info(`Stopping ${this.scanners.size} scanner(s)...`);
      for (const [cycleId, scanner] of this.scanners.entries()) {
        try {
          if (scanner && typeof scanner.stop === 'function') {
            await scanner.stop();
            this.logger.debug(`Scanner ${cycleId} stopped`);
          }
        } catch (error: any) {
          this.logger.warn(`Error stopping scanner ${cycleId}:`, error?.message || String(error));
        }
      }
      this.scanners.clear();

      // Stop WebSocket if configured
      if (this.options.wssUrl && this.stateFetcher) {
        try {
          // Check if StateFetcher has stopWebSocket method
          if (typeof (this.stateFetcher as any).stopWebSocket === 'function') {
            await (this.stateFetcher as any).stopWebSocket();
            this.logger.info('WebSocket connection closed');
          } else {
            this.logger.debug('StateFetcher does not have stopWebSocket method, skipping');
          }
        } catch (error: any) {
          this.logger.warn('Error closing WebSocket:', error?.message || String(error));
        }
      }

      // Stop dashboard if running
      if (this.dashboard) {
        try {
          this.dashboard.stop();
          this.logger.info('Dashboard stopped');
        } catch (error: any) {
          this.logger.warn('Error stopping dashboard:', error?.message || String(error));
        }
      }

      // Stop metrics (flush data)
      try {
        this.metrics.stop();
        this.logger.info('Metrics collector stopped (data flushed)');
      } catch (error: any) {
        this.logger.warn('Error stopping metrics:', error?.message || String(error));
      }

      this.logger.info('✓ Cycle Arbitrage stopped successfully');
    } catch (error: any) {
      this.logger.error('Error during shutdown:', error?.message || String(error));
      throw error;
    }
  }


}

