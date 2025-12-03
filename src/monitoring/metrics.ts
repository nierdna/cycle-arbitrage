/**
 * Metrics Collector
 * Tracks statistics for cycle arbitrage operations
 */

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
  timestamp: number;
  cycleId: string;
  arbitrageBps: number | null; // from opportunity
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

export class MetricsCollector {
  private metrics: Metrics;
  private historicalData: HistoricalDataPoint[] = [];
  private maxHistoryPoints: number = 10000; // Keep last 10k points

  constructor() {
    this.metrics = {
      cycles: new Map(),
      totalScans: 0,
      totalOpportunities: 0,
      totalExecutions: 0,
      totalProfit: 0n,
      uptime: Date.now(),
      lastUpdate: Date.now(),
    };
  }

  recordScan(cycleId: string): void {
    this.metrics.totalScans++;
    const cycle = this.getOrCreateCycle(cycleId);
    cycle.scans++;
    this.metrics.lastUpdate = Date.now();
  }

  recordOpportunity(cycleId: string, arbitrageBps: number, amountIn?: bigint): void {
    this.metrics.totalOpportunities++;
    const cycle = this.getOrCreateCycle(cycleId);
    cycle.opportunities++;
    
    // Update best arbitrage and best amountIn
    if (arbitrageBps > cycle.bestArbitrage) {
      cycle.bestArbitrage = arbitrageBps;
      if (amountIn !== undefined) {
        cycle.bestAmountIn = amountIn;
        cycle.bestAmountInArbBps = arbitrageBps;
      }
    }
    
    cycle.worstArbitrage = Math.min(cycle.worstArbitrage, arbitrageBps);
    cycle.lastOpportunity = Date.now();
    cycle.lastArbitrageBps = arbitrageBps;
    // Update average
    cycle.avgArbitrage =
      (cycle.avgArbitrage * (cycle.opportunities - 1) + arbitrageBps) /
      cycle.opportunities;
    this.metrics.lastUpdate = Date.now();
    
    // Record historical data point
    this.addHistoricalDataPoint({
      timestamp: Date.now(),
      cycleId,
      arbitrageBps,
      bestAmountInArbBps: null,
    });
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
  
  private addHistoricalDataPoint(point: HistoricalDataPoint): void {
    this.historicalData.push(point);
    
    // Keep only last N points (circular buffer)
    if (this.historicalData.length > this.maxHistoryPoints) {
      this.historicalData.shift();
    }
  }
  
  /**
   * Get historical data for a cycle within time range
   */
  getHistoricalData(cycleId: string, startTime?: number, endTime?: number): HistoricalDataPoint[] {
    const now = Date.now();
    const start = startTime ?? (now - 24 * 60 * 60 * 1000); // Default: last 24h
    const end = endTime ?? now;
    
    return this.historicalData.filter(
      point =>
        point.cycleId === cycleId &&
        point.timestamp >= start &&
        point.timestamp <= end
    );
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

