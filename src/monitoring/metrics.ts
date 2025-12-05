/**
 * Metrics Collector
 * Tracks statistics for cycle arbitrage operations
 */

import { HistoryPersistence } from './historyPersistence.js';

export interface CycleMetrics {
  cycleId: string;
  scans: number;
  opportunities: number;
  executions: number;
  totalProfit: bigint;
  bestArbitrage: number; // bps
  worstArbitrage: number; // bps
  avgArbitrage: number; // bps
  bestAmountIn?: bigint; // AmountIn that gave best arbitrage
  bestAmountInArbBps?: number; // Arbitrage BPS for bestAmountIn
  lastOpportunity?: number; // timestamp
  lastExecution?: number; // timestamp
  lastArbitrageBps?: number; // last detected arbitrage
}

export interface HistoricalDataPoint {
  timestamp: number; // Unix timestamp in milliseconds
  cycleId: string;
  arbitrageBps: number | null; // from opportunity (aggregated by second)
  bestAmountInArbBps: number | null; // from optimization
}

export interface Metrics {
  // Cycle-level metrics
  cycles: Map<string, CycleMetrics>;
  // Global metrics
  totalScans: number;
  totalOpportunities: number;
  totalExecutions: number;
  totalProfit: bigint;
  uptime: number;
  lastUpdate: number;
}

/**
 * Buffer to track opportunities within the same second
 */
interface SecondBuffer {
  second: number; // Unix timestamp in seconds
  arbitrageBpsValues: number[]; // All arbitrage BPS values in this second
  amountIns: (bigint | undefined)[]; // Corresponding amountIns
  timestamps: number[]; // Exact timestamps in milliseconds
}

export class MetricsCollector {
  private metrics: Metrics;
  private historicalData: HistoricalDataPoint[] = [];
  private maxHistoryPoints: number = 10000; // Keep last 10k points in memory
  private historyPersistence: HistoryPersistence;
  private saveBatch: HistoricalDataPoint[] = [];
  private saveBatchSize: number = 100; // Save to file every N points
  private saveIntervalMs: number = 60000; // Also save every 60 seconds
  private saveInterval?: NodeJS.Timeout;

  // Track opportunities within the same second for each cycle
  private pendingOpportunities: Map<string, SecondBuffer> = new Map();

  constructor(historyDir?: string) {
    this.metrics = {
      cycles: new Map(),
      totalScans: 0,
      totalOpportunities: 0,
      totalExecutions: 0,
      totalProfit: 0n,
      uptime: Date.now(),
      lastUpdate: Date.now(),
    };
    
    this.historyPersistence = new HistoryPersistence(historyDir);
    
    // Load historical data on startup (last 7 days)
    this.loadHistoricalData().catch(err => {
      console.warn('Warning: Could not load historical data on startup:', err);
    });
    
    // Start periodic save
    this.startPeriodicSave();
  }

  /**
   * Load historical data from files on startup
   */
  private async loadHistoricalData(): Promise<void> {
    const maxAgeMs = 7 * 24 * 60 * 60 * 1000; // Last 7 days
    const loaded = await this.historyPersistence.loadAllDataPoints(maxAgeMs);
    
    // Add to in-memory buffer (respecting maxHistoryPoints)
    this.historicalData = loaded.slice(-this.maxHistoryPoints);
    
    console.log(`Loaded ${loaded.length} historical data points (keeping last ${this.historicalData.length} in memory)`);
  }

  /**
   * Start periodic save to disk
   */
  private startPeriodicSave(): void {
    this.saveInterval = setInterval(async () => {
      // Flush old pending opportunities (older than 2 seconds)
      const nowSecond = Math.floor(Date.now() / 1000);
      for (const [cycleId, buffer] of this.pendingOpportunities) {
        if (buffer.second < nowSecond - 1) {
          // Buffer is at least 2 seconds old, flush it
          this.flushPendingOpportunities(cycleId, buffer);
          this.pendingOpportunities.delete(cycleId);
        }
      }

      // Flush save batch
      if (this.saveBatch.length > 0) {
        await this.flushSaveBatch();
      }
    }, this.saveIntervalMs);
  }

  /**
   * Group historical data points by second (aggregate multiple points in same second)
   */
  private groupHistoricalDataBySecond(points: HistoricalDataPoint[]): HistoricalDataPoint[] {
    // Group by cycleId and second (timestamp rounded to second)
    const grouped = new Map<string, {
      cycleId: string;
      second: number;
      arbitrageBpsValues: number[];
      bestAmountInArbBpsValues: number[];
      timestamps: number[];
    }>();

    for (const point of points) {
      const second = Math.floor(point.timestamp / 1000);
      const key = `${point.cycleId}-${second}`;

      if (!grouped.has(key)) {
        grouped.set(key, {
          cycleId: point.cycleId,
          second,
          arbitrageBpsValues: [],
          bestAmountInArbBpsValues: [],
          timestamps: [],
        });
      }

      const group = grouped.get(key)!;
      group.timestamps.push(point.timestamp);

      if (point.arbitrageBps !== null) {
        group.arbitrageBpsValues.push(point.arbitrageBps);
      }
      if (point.bestAmountInArbBps !== null) {
        group.bestAmountInArbBpsValues.push(point.bestAmountInArbBps);
      }
    }

    // Aggregate each group into one point
    const aggregated: HistoricalDataPoint[] = [];
    for (const group of grouped.values()) {
      const avgArbitrageBps = group.arbitrageBpsValues.length > 0
        ? group.arbitrageBpsValues.reduce((sum, val) => sum + val, 0) / group.arbitrageBpsValues.length
        : null;

      const avgBestAmountInArbBps = group.bestAmountInArbBpsValues.length > 0
        ? group.bestAmountInArbBpsValues.reduce((sum, val) => sum + val, 0) / group.bestAmountInArbBpsValues.length
        : null;

      // Use middle timestamp as representative
      const representativeTimestamp = group.timestamps[Math.floor(group.timestamps.length / 2)];

      aggregated.push({
        timestamp: representativeTimestamp,
        cycleId: group.cycleId,
        arbitrageBps: avgArbitrageBps,
        bestAmountInArbBps: avgBestAmountInArbBps,
      });
    }

    return aggregated.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Flush save batch to disk (with grouping by second)
   */
  private async flushSaveBatch(): Promise<void> {
    if (this.saveBatch.length === 0) return;
    
    const toSave = [...this.saveBatch];
    this.saveBatch = [];
    
    try {
      // Group by second before saving
      const grouped = this.groupHistoricalDataBySecond(toSave);
      await this.historyPersistence.saveDataPoints(grouped);
    } catch (err: any) {
      console.error('Error saving historical data to disk:', err);
      // Put back to batch for retry (but limit size to prevent memory issues)
      if (this.saveBatch.length < this.saveBatchSize) {
        this.saveBatch.unshift(...toSave);
      }
    }
  }

  /**
   * Stop periodic save (cleanup)
   */
  stop(): void {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = undefined;
    }

    // Flush all pending opportunities before stopping
    for (const [cycleId, buffer] of this.pendingOpportunities) {
      this.flushPendingOpportunities(cycleId, buffer);
    }
    this.pendingOpportunities.clear();

    // Flush remaining data
    this.flushSaveBatch().catch(err => {
      console.error('Error flushing save batch on stop:', err);
    });
  }

  recordScan(cycleId: string): void {
    this.metrics.totalScans++;
    const cycle = this.getOrCreateCycle(cycleId);
    cycle.scans++;
    this.metrics.lastUpdate = Date.now();
  }

  /**
   * Flush pending opportunities from previous second and record as one opportunity
   */
  private flushPendingOpportunities(cycleId: string, buffer: SecondBuffer): void {
    if (buffer.arbitrageBpsValues.length === 0) return;

    // Calculate aggregated values
    const avgArbitrage = buffer.arbitrageBpsValues.reduce((sum, val) => sum + val, 0) / buffer.arbitrageBpsValues.length;
    const bestArbitrage = Math.max(...buffer.arbitrageBpsValues);
    const worstArbitrage = Math.min(...buffer.arbitrageBpsValues);
    const bestIndex = buffer.arbitrageBpsValues.indexOf(bestArbitrage);
    const bestAmountIn = buffer.amountIns[bestIndex];
    const representativeTimestamp = buffer.timestamps[Math.floor(buffer.timestamps.length / 2)]; // Use middle timestamp

  // Record as ONE opportunity
    this.metrics.totalOpportunities++;
    const cycle = this.getOrCreateCycle(cycleId);
    cycle.opportunities++;
    
    // Update best arbitrage and best amountIn
    if (bestArbitrage > cycle.bestArbitrage) {
      cycle.bestArbitrage = bestArbitrage;
      if (bestAmountIn !== undefined) {
        cycle.bestAmountIn = bestAmountIn;
        cycle.bestAmountInArbBps = bestArbitrage;
      }
    }
    
    cycle.worstArbitrage = Math.min(cycle.worstArbitrage, worstArbitrage);
    cycle.lastOpportunity = representativeTimestamp;
    cycle.lastArbitrageBps = bestArbitrage;

    // Update average (using running average formula)
    cycle.avgArbitrage =
      (cycle.avgArbitrage * (cycle.opportunities - 1) + avgArbitrage) /
      cycle.opportunities;

    this.metrics.lastUpdate = Date.now();
    
    // Record aggregated historical data point (one per second)
    this.addHistoricalDataPoint({
      timestamp: representativeTimestamp,
      cycleId,
      arbitrageBps: avgArbitrage, // Store average for chart
      bestAmountInArbBps: null,
    });
  }

  recordOpportunity(cycleId: string, arbitrageBps: number, amountIn?: bigint): void {
    const now = Date.now();
    const currentSecond = Math.floor(now / 1000);

    // Get or create buffer for this cycle
    let buffer = this.pendingOpportunities.get(cycleId);

    // Check if we need to flush previous second
    if (buffer && buffer.second !== currentSecond) {
      // Flush opportunities from previous second
      this.flushPendingOpportunities(cycleId, buffer);
      buffer = undefined; // Reset for new second
    }

    // Initialize buffer if needed
    if (!buffer) {
      buffer = {
        second: currentSecond,
        arbitrageBpsValues: [],
        amountIns: [],
        timestamps: [],
      };
      this.pendingOpportunities.set(cycleId, buffer);
    }

    // Add to buffer (same second)
    buffer.arbitrageBpsValues.push(arbitrageBps);
    buffer.amountIns.push(amountIn);
    buffer.timestamps.push(now);
  }

  recordExecution(cycleId: string, profit: bigint): void {
    this.metrics.totalExecutions++;
    this.metrics.totalProfit += profit;
    const cycle = this.getOrCreateCycle(cycleId);
    cycle.executions++;
    cycle.totalProfit += profit;
    cycle.lastExecution = Date.now();
    this.metrics.lastUpdate = Date.now();
  }

  /**
   * Record optimization result (best amountIn found)
   * This is called when optimization finds a good amountIn, even without opportunity
   */
  recordOptimizationResult(cycleId: string, amountIn: bigint, arbitrageBps: number): void {
    const cycle = this.getOrCreateCycle(cycleId);
    
    // Update bestAmountIn if this is better than current best
    if (arbitrageBps > (cycle.bestAmountInArbBps ?? -Infinity)) {
      cycle.bestAmountIn = amountIn;
      cycle.bestAmountInArbBps = arbitrageBps;
      this.metrics.lastUpdate = Date.now();
    }
    
    // Record historical data point (but only if it's better than previous)
    // To avoid too many data points, we could sample (e.g., every N seconds)
    // For now, record all optimization results
    this.addHistoricalDataPoint({
      timestamp: Date.now(),
      cycleId,
      arbitrageBps: null,
      bestAmountInArbBps: arbitrageBps,
    });
  }

  /**
   * Record arbitrage BPS for historical chart
   * This is called periodically during scanning to track arbitrage trends over time
   */
  recordArbitrageBps(cycleId: string, arbitrageBps: number): void {
    // Record historical data point with arbitrage BPS
    this.addHistoricalDataPoint({
      timestamp: Date.now(),
      cycleId,
      arbitrageBps: arbitrageBps,
      bestAmountInArbBps: null,
    });
  }
  
  private addHistoricalDataPoint(point: HistoricalDataPoint): void {
    this.historicalData.push(point);
    
    // Keep only last N points (circular buffer)
    if (this.historicalData.length > this.maxHistoryPoints) {
      this.historicalData.shift();
    }
    
    // Add to save batch
    this.saveBatch.push(point);
    
    // Flush to disk if batch is full
    if (this.saveBatch.length >= this.saveBatchSize) {
      this.flushSaveBatch().catch(err => {
        console.error('Error flushing save batch:', err);
      });
    }
  }
  
  /**
   * Get historical data for a cycle within time range
   * Loads from both memory and disk files, grouped by second
   */
  async getHistoricalData(cycleId: string, startTime?: number, endTime?: number): Promise<HistoricalDataPoint[]> {
    const now = Date.now();
    const start = startTime ?? (now - 24 * 60 * 60 * 1000); // Default: last 24h
    const end = endTime ?? now;
    
    // Get from in-memory buffer
    const memoryData = this.historicalData.filter(
      point =>
        point.cycleId === cycleId &&
        point.timestamp >= start &&
        point.timestamp <= end
    );
    
    // Get from disk files (for older data or if memory doesn't have enough)
    let diskData: HistoricalDataPoint[] = [];
    try {
      diskData = await this.historyPersistence.loadDataPoints(cycleId, start, end);
    } catch (err: any) {
      console.warn('Warning: Could not load historical data from disk:', err.message);
    }
    
    // Merge all data (may have duplicates if same data in memory and disk)
    const allData = new Map<string, HistoricalDataPoint>();
    
    for (const point of [...memoryData, ...diskData]) {
      const key = `${point.timestamp}-${point.cycleId}`;
      // Keep the latest one if duplicate (by exact timestamp)
      if (!allData.has(key) || allData.get(key)!.timestamp < point.timestamp) {
        allData.set(key, point);
      }
    }
    
    // Convert to array and group by second
    const allPoints = Array.from(allData.values());
    const grouped = this.groupHistoricalDataBySecond(allPoints);

    // Filter by cycleId again (in case grouping created issues)
    return grouped.filter(point => point.cycleId === cycleId).sort((a, b) => a.timestamp - b.timestamp);
  }

  getMetrics(): Metrics {
    return { ...this.metrics };
  }

  getCycleMetrics(cycleId: string): CycleMetrics | undefined {
    return this.metrics.cycles.get(cycleId);
  }

  getAllCycleMetrics(): CycleMetrics[] {
    return Array.from(this.metrics.cycles.values());
  }

  getSummary() {
    const uptimeMs = Date.now() - this.metrics.uptime;
    const uptimeHours = (uptimeMs / (1000 * 60 * 60)).toFixed(2);
    const scansPerSecond =
      this.metrics.totalScans > 0
        ? (this.metrics.totalScans / (uptimeMs / 1000)).toFixed(2)
        : '0';

    return {
      uptime: {
        ms: uptimeMs,
        hours: uptimeHours,
      },
      totalScans: this.metrics.totalScans,
      totalOpportunities: this.metrics.totalOpportunities,
      totalExecutions: this.metrics.totalExecutions,
      totalProfit: this.metrics.totalProfit.toString(),
      scansPerSecond,
      cyclesCount: this.metrics.cycles.size,
      lastUpdate: this.metrics.lastUpdate,
    };
  }

  private getOrCreateCycle(cycleId: string): CycleMetrics {
    if (!this.metrics.cycles.has(cycleId)) {
      this.metrics.cycles.set(cycleId, {
        cycleId,
        scans: 0,
        opportunities: 0,
        executions: 0,
        totalProfit: 0n,
        bestArbitrage: -Infinity,
        worstArbitrage: Infinity,
        avgArbitrage: 0,
        bestAmountIn: undefined,
        bestAmountInArbBps: undefined,
      });
    }
    return this.metrics.cycles.get(cycleId)!;
  }
}

