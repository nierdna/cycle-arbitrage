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
  GasPriceService,
  TokenPriceService,
  MinProfitCalculator,
} from './services/index.js';
import { WalletPool } from './wallet/walletPool.js';
import { CycleEstimator } from './estimation/cycleEstimator.js';
import { TelegramNotifier, TelegramConfig } from './notifications/index.js';
import { CyclePersistenceService } from './services/cyclePersistence.js';
import { CycleWithAmounts } from './services/cycleDiscovery.js';

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
  minArbitrageBps?: number; // Deprecated: kept for backward compatibility, not used anymore
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
  gasPriceUpdateInterval?: number; // Gas price update interval in ms (default: 5000)
  tokenPriceUpdateInterval?: number; // Token price update interval in ms (default: 30000)
  // New options for cycle persistence
  cyclesFilePath?: string; // Path to cycles JSON file (default: 'data/cycles.json')
  mode?: 'discovery' | 'scan' | 'auto'; // Mode: discovery (save cycles), scan (load cycles), auto (discover if file doesn't exist)
  validateCyclesOnLoad?: boolean; // Validate cycles when loading from file (default: true)
  cyclesWhitelist?: string[]; // List of cycleIds to whitelist (only scan these cycles)
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

  // Background services for minProfit calculation
  private gasPriceService?: GasPriceService;
  private tokenPriceService?: TokenPriceService;
  private minProfitCalculator?: MinProfitCalculator;

  // Cycle persistence
  private cyclePersistence: CyclePersistenceService;

  private cycles: Map<string, CycleWithState> = new Map();
  private scanners: Map<string, CycleScanner> = new Map(); // Track active scanners for cleanup
  private isRunning: boolean = false; // Track if scanning is active
  private options: Required<Omit<ArbitrageOptions, 'wssUrl' | 'optimizeAmountIn' | 'optimizationInterval' | 'optimizationPrecision' | 'logDir' | 'dashboardPort' | 'historyDir' | 'maxHops' | 'discoveryFees' | 'telegramConfig' | 'cyclesFilePath' | 'mode' | 'validateCyclesOnLoad' | 'cyclesWhitelist'>> & {
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
    cyclesFilePath: string;
    mode: 'discovery' | 'scan' | 'auto';
    validateCyclesOnLoad: boolean;
    cyclesWhitelist?: string[];
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
      gasPriceUpdateInterval: options.gasPriceUpdateInterval ?? 5000, // 5 seconds
      tokenPriceUpdateInterval: options.tokenPriceUpdateInterval ?? 30000, // 30 seconds
      cyclesFilePath: options.cyclesFilePath ?? 'data/cycles.json',
      mode: options.mode ?? 'auto',
      validateCyclesOnLoad: options.validateCyclesOnLoad ?? true,
      cyclesWhitelist: options.cyclesWhitelist,
    };

    // Initialize logger first (needed by cyclePersistence)
    this.logger = createLogger(this.options.logDir);

    // Initialize cycle persistence service
    this.cyclePersistence = new CyclePersistenceService(
      this.options.cyclesFilePath,
      this.logger
    );

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

    // Initialize background services for minProfit calculation
    this.gasPriceService = new GasPriceService(
      provider,
      this.options.gasPriceUpdateInterval,
      this.logger
    );

    this.tokenPriceService = new TokenPriceService(
      provider,
      this.tokenRegistry.getDecimalCache(),
      this.options.tokenPriceUpdateInterval,
      this.logger
    );

    this.minProfitCalculator = new MinProfitCalculator(
      this.gasPriceService,
      this.tokenPriceService,
      this.tokenRegistry.getDecimalCache(),
      this.logger
    );
  }

  /**
   * Filter cycles based on whitelist if configured
   */
  private filterCyclesByWhitelist(cycles: CycleWithAmounts[]): CycleWithAmounts[] {
    if (!this.options.cyclesWhitelist || this.options.cyclesWhitelist.length === 0) {
      return cycles; // No whitelist, return all cycles
    }

    const whitelistSet = new Set(this.options.cyclesWhitelist.map(id => id.toLowerCase()));
    const filtered = cycles.filter(cycle => whitelistSet.has(cycle.cycleId.toLowerCase()));

    if (filtered.length < cycles.length) {
      const filteredCount = cycles.length - filtered.length;
      this.logger.info(
        `Whitelist filter: ${filtered.length} cycles allowed, ${filteredCount} cycles filtered out`
      );
    }

    // Log warning if some whitelist cycleIds are not found
    const foundCycleIds = new Set(filtered.map(c => c.cycleId.toLowerCase()));
    const missingCycleIds = this.options.cyclesWhitelist.filter(
      id => !foundCycleIds.has(id.toLowerCase())
    );
    if (missingCycleIds.length > 0) {
      this.logger.warn(
        `Whitelist cycles not found: ${missingCycleIds.join(', ')}`
      );
    }

    return filtered;
  }

  /**
   * Discover cycles automatically from token list
   * Builds pool matrix and finds all valid cycles
   */
  async discoverCycles(): Promise<CycleWithAmounts[]> {
    const cyclesWithAmounts = await this.cycleDiscovery.discoverCycles(
      this.options.maxHops,
      this.options.discoveryFees
    );

    // Apply whitelist filter if configured
    const filteredCycles = this.filterCyclesByWhitelist(cyclesWithAmounts);

    // Log cycles with readable format
    for (let i = 0; i < filteredCycles.length; i++) {
      const cycle = filteredCycles[i];
      this.logger.info(this.formatter.formatCycleForLog(cycle, i));
    }

    // Register cycles for monitoring
    for (const cycle of filteredCycles) {
      this.cycles.set(cycle.cycleId, {
        ...cycle,
        poolAddresses: [],
      });
    }

    return filteredCycles;
  }

  /**
   * Discover cycles and save to JSON file (Discovery Mode)
   */
  async discoverAndSaveCycles(): Promise<void> {
    this.logger.info('=== Discovery Mode: Discovering cycles ===');

    // Initialize token registry and pool matrix builder
    await this.tokenRegistry.initialize();
    await this.poolMatrixBuilder.initialize();

    // Discover cycles
    const cyclesWithAmounts = await this.discoverCycles();

    // Calculate token list hash for validation
    const tokenAddresses = this.tokenRegistry.getAllAddresses();
    const tokenListHash = CyclePersistenceService.calculateTokenListHash(tokenAddresses);

    // Save cycles to file
    this.cyclePersistence.saveCycles(cyclesWithAmounts, {
      tokenListHash,
      tokenCount: tokenAddresses.length,
      maxHops: this.options.maxHops,
      discoveryFees: this.options.discoveryFees,
    });

    this.logger.info(
      `✓ Discovery complete: ${cyclesWithAmounts.length} cycles saved to ${this.options.cyclesFilePath}`
    );
  }

  /**
   * Load cycles from JSON file (Scan Mode)
   * Validates cycles and filters invalid ones
   */
  async loadCyclesFromFile(): Promise<void> {
    this.logger.info('=== Scan Mode: Loading cycles from file ===');

    if (!this.cyclePersistence.cyclesFileExists()) {
      throw new Error(
        `Cycles file not found: ${this.options.cyclesFilePath}. ` +
        `Please run discovery mode first or set mode='auto' to auto-discover.`
      );
    }

    // Load cycles from file
    const { cycles, metadata } = this.cyclePersistence.loadCycles();

    this.logger.info(
      `Loaded ${cycles.length} cycles from file ` +
      `(discovered: ${new Date(metadata.discoveryTimestamp).toISOString()}, ` +
      `tokens: ${metadata.tokenCount}, maxHops: ${metadata.maxHops})`
    );

    // Apply whitelist filter if configured
    const filteredCycles = this.filterCyclesByWhitelist(cycles);

    // Validate token list hash if validateCyclesOnLoad is enabled
    if (this.options.validateCyclesOnLoad) {
      const currentTokenAddresses = this.tokenRegistry.getAllAddresses();
      const currentTokenListHash = CyclePersistenceService.calculateTokenListHash(currentTokenAddresses);

      if (currentTokenListHash !== metadata.tokenListHash) {
        this.logger.warn(
          `⚠ Token list hash mismatch! ` +
          `File hash: ${metadata.tokenListHash}, Current hash: ${currentTokenListHash}. ` +
          `Cycles may be outdated. Consider re-running discovery.`
        );
      }
    }

    // Validate and register cycles
    let validCycles = 0;
    let invalidCycles = 0;

    for (const cycle of filteredCycles) {
      // Basic validation: check if start token still has amountConfig
      const startTokenAddress = cycle.addresses[0].toLowerCase();
      const token = this.tokenRegistry.getToken(startTokenAddress);

      if (!token?.amountConfig) {
        this.logger.warn(
          `Skipping cycle ${cycle.cycleId}: start token ${startTokenAddress} no longer has amountConfig`
        );
        invalidCycles++;
        continue;
      }

      // Register cycle
      this.cycles.set(cycle.cycleId, {
        ...cycle,
        poolAddresses: [], // Will be resolved later
      });
      validCycles++;
    }

    this.logger.info(
      `✓ Loaded ${validCycles} valid cycles, ${invalidCycles} invalid cycles filtered`
    );

    if (validCycles === 0) {
      throw new Error(
        'No valid cycles found after loading from file. Please re-run discovery.'
      );
    }
  }



  /**
   * Set wallet pool and arbitrage contract for execution (bundle mode only)
   * 
   * @param walletPool WalletPool instance for wallet rotation
   * @param bundleConfig Bundle configuration
   * @param contractAddress Arbitrage contract address
   */
  setExecution(
    walletPool: WalletPool,
    bundleConfig: BundleConfig,
    contractAddress: string
  ): void {
    const contractConfig: ArbitrageContractConfig = {
      contractAddress,
      contractABI: CONSTANTS.ARBITRAGE_CONTRACT_ABI,
    };

    this.tradeExecutor = new TradeExecutor(
      walletPool,
      this.logger,
      bundleConfig,
      contractConfig,
      this.gasPriceService
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
          this.logger.error('[Telegram] Notification error:', error);
        });
      }
    });
  }

  /**
   * Initialize: Load or discover cycles, fetch pool addresses and subscribe to WebSocket
   */
  async initialize(): Promise<void> {
    this.logger.info('=== Cycle Arbitrage ===');

    // Initialize token registry (load decimal cache from file)
    await this.tokenRegistry.initialize();

    // Initialize pool matrix builder cache (load pool existence cache from file)
    await this.poolMatrixBuilder.initialize();

    // Handle cycles based on mode
    if (this.options.mode === 'discovery') {
      // Discovery mode: discover and save cycles, then exit
      await this.discoverAndSaveCycles();
      return; // Exit after saving
    } else if (this.options.mode === 'scan') {
      // Scan mode: load cycles from file
      await this.loadCyclesFromFile();
    } else {
      // Auto mode: try to load from file, fallback to discovery
      if (this.cyclePersistence.cyclesFileExists()) {
        this.logger.info('Cycles file found, loading from file...');
        try {
          await this.loadCyclesFromFile();
        } catch (error: any) {
          this.logger.warn(
            `Failed to load cycles from file: ${error.message}. Falling back to discovery...`
          );
          await this.discoverCycles();
        }
      } else {
        this.logger.info('Cycles file not found, discovering cycles...');
        await this.discoverCycles();
      }
    }

    // If in discovery mode, we already returned above
    // Continue with scan mode initialization
    if (this.cycles.size === 0) {
      throw new Error('No cycles available for scanning');
    }

    this.logger.info(`Total cycles: ${this.cycles.size}`);

    // Start background services for minProfit calculation
    if (this.gasPriceService) {
      await this.gasPriceService.start();
    }

    if (this.tokenPriceService) {
      // Register all token addresses from cycles
      const allTokenAddresses = new Set<string>();
      for (const cycle of this.cycles.values()) {
        for (const address of cycle.addresses) {
          allTokenAddresses.add(address);
        }
      }
      // Also add WBNB address (needed for gas price calculation)
      allTokenAddresses.add('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c');

      this.tokenPriceService.registerTokens(Array.from(allTokenAddresses));
      await this.tokenPriceService.start();
    }

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

    if (!this.minProfitCalculator) {
      throw new Error('MinProfitCalculator not initialized. Make sure initialize() was called.');
    }

    const scanner = new CycleScanner(
      cycleId,
      cycle,
      (cid: string, amountIn: bigint) => this.estimateAmountOutForCycle(cid, amountIn),
      {
        minArbitrageBps: this.options.minArbitrageBps, // Deprecated, kept for backward compatibility
        scanIntervalMs: this.options.scanIntervalMs,
        amountIn: this.options.amountIn,
        optimizeAmountIn: this.options.optimizeAmountIn,
        optimizationInterval: this.options.optimizationInterval,
        optimizationPrecision: this.options.optimizationPrecision,
      },
      this.minProfitCalculator,
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
            executeAmountOut,
            data.minProfit // Pass minProfit from scanner
          );
        } catch (error: any) {
          this.logger.error(
            `[${data.cycleId}] Failed to execute trade:`,
            error
          );
          // Don't throw - allow scanning to continue
        }
      }
    });

    scanner.on('arbitrage-bps', (data) => {
      this.metrics.recordArbitrageBps(
        data.cycleId,
        data.arbitrageBps,
        data.profit,
        data.minProfit,
        data.amountIn
      );
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
    this.logger.info(`  Min profit: calculated dynamically based on gas costs`);
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

      // Stop background services
      if (this.gasPriceService) {
        try {
          this.gasPriceService.stop();
          this.logger.info('GasPriceService stopped');
        } catch (error: any) {
          this.logger.warn('Error stopping GasPriceService:', error?.message || String(error));
        }
      }

      if (this.tokenPriceService) {
        try {
          this.tokenPriceService.stop();
          this.logger.info('TokenPriceService stopped');
        } catch (error: any) {
          this.logger.warn('Error stopping TokenPriceService:', error?.message || String(error));
        }
      }

      this.logger.info('✓ Cycle Arbitrage stopped successfully');
    } catch (error: any) {
      this.logger.error('Error during shutdown:', error);
      throw error;
    }
  }


}

