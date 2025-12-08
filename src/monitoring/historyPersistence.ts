/**
 * History Persistence with SQLite
 * Saves and loads historical data points to/from SQLite database
 * Uses better-sqlite3 for synchronous, high-performance operations
 */

import Database from 'better-sqlite3';
import path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { HistoricalDataPoint } from './metrics.js';

export class HistoryPersistence {
  private db: Database.Database;
  private dbPath: string;

  constructor(historyDir: string = 'data/history') {
    // Use SQLite database file in history directory
    this.dbPath = path.join(historyDir, 'history.db');

    // Ensure directory exists (synchronous for constructor)
    const dirPath = path.dirname(this.dbPath);
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }

    // Open database with WAL mode for better concurrency
    // SQLite will create the file if it doesn't exist
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL'); // Write-Ahead Logging for better concurrency
    this.db.pragma('synchronous = NORMAL'); // Balance between safety and performance

    // Initialize schema
    this.initializeSchema();
  }

  /**
   * Initialize database schema
   */
  private initializeSchema(): void {
    // Create table if not exists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history_points (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        cycle_id TEXT NOT NULL,
        arbitrage_bps REAL,
        best_amount_in_arb_bps REAL,
        execution_profit TEXT,
        execution_tx_hash TEXT,
        execution_amount_in TEXT,
        execution_arbitrage_bps REAL,
        UNIQUE(timestamp, cycle_id)
      );

      CREATE INDEX IF NOT EXISTS idx_timestamp ON history_points(timestamp);
      CREATE INDEX IF NOT EXISTS idx_cycle_id ON history_points(cycle_id);
      CREATE INDEX IF NOT EXISTS idx_cycle_timestamp ON history_points(cycle_id, timestamp);
    `);
  }

  /**
   * Convert HistoricalDataPoint to database row
   */
  private pointToRow(point: HistoricalDataPoint): any {
    return {
      timestamp: point.timestamp,
      cycle_id: point.cycleId,
      arbitrage_bps: point.arbitrageBps ?? null,
      best_amount_in_arb_bps: point.bestAmountInArbBps ?? null,
      execution_profit: point.executionProfit !== undefined
        ? String(point.executionProfit)
        : null,
      execution_tx_hash: point.executionTxHash ?? null,
      execution_amount_in: point.executionAmountIn !== undefined
        ? String(point.executionAmountIn)
        : null,
      execution_arbitrage_bps: point.executionArbitrageBps ?? null,
    };
  }

  /**
   * Convert database row to HistoricalDataPoint
   */
  private rowToPoint(row: any): HistoricalDataPoint {
    const point: HistoricalDataPoint = {
      timestamp: row.timestamp,
      cycleId: row.cycle_id,
      arbitrageBps: row.arbitrage_bps,
      bestAmountInArbBps: row.best_amount_in_arb_bps,
    };

    // Add execution data if present
    if (row.execution_profit !== null) {
      point.executionProfit = row.execution_profit;
    }
    if (row.execution_tx_hash !== null) {
      point.executionTxHash = row.execution_tx_hash;
    }
    if (row.execution_amount_in !== null) {
      point.executionAmountIn = row.execution_amount_in;
    }
    if (row.execution_arbitrage_bps !== null) {
      point.executionArbitrageBps = row.execution_arbitrage_bps;
    }

    return point;
  }

  /**
   * Save data points to database
   * Uses INSERT OR REPLACE to handle duplicates (based on timestamp + cycle_id)
   */
  async saveDataPoints(points: HistoricalDataPoint[]): Promise<void> {
    if (points.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO history_points 
      (timestamp, cycle_id, arbitrage_bps, best_amount_in_arb_bps, 
       execution_profit, execution_tx_hash, execution_amount_in, execution_arbitrage_bps)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((points: HistoricalDataPoint[]) => {
      for (const point of points) {
        const row = this.pointToRow(point);
        stmt.run(
          row.timestamp,
          row.cycle_id,
          row.arbitrage_bps,
          row.best_amount_in_arb_bps,
          row.execution_profit,
          row.execution_tx_hash,
          row.execution_amount_in,
          row.execution_arbitrage_bps
        );
      }
    });

    try {
      insertMany(points);
    } catch (err: any) {
      console.error(`Error saving history to database:`, err.message);
      throw err;
    }
  }

  /**
   * Load data points from database within time range
   */
  async loadDataPoints(
    cycleId: string,
    startTime: number,
    endTime: number
  ): Promise<HistoricalDataPoint[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM history_points
      WHERE cycle_id = ? AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC
    `);

    try {
      const rows = stmt.all(cycleId, startTime, endTime);
      return rows.map(row => this.rowToPoint(row));
    } catch (err: any) {
      console.warn(`Warning: Could not load history from database:`, err.message);
      return [];
    }
  }

  /**
   * Load all data points from database (for initialization)
   */
  async loadAllDataPoints(maxAgeMs?: number): Promise<HistoricalDataPoint[]> {
    const cutoffTime = maxAgeMs ? Date.now() - maxAgeMs : 0;

    let stmt;
    if (maxAgeMs) {
      stmt = this.db.prepare(`
        SELECT * FROM history_points
        WHERE timestamp >= ?
        ORDER BY timestamp ASC
      `);
    } else {
      stmt = this.db.prepare(`
        SELECT * FROM history_points
        ORDER BY timestamp ASC
      `);
    }

    try {
      const rows = maxAgeMs ? stmt.all(cutoffTime) : stmt.all();
      return rows.map(row => this.rowToPoint(row));
    } catch (err: any) {
      console.warn(`Warning: Could not load history from database:`, err.message);
      return [];
    }
  }

  /**
   * Clean up old data points (older than maxAgeMs)
   */
  async cleanupOldFiles(maxAgeMs: number): Promise<number> {
    const cutoffTime = Date.now() - maxAgeMs;

    const stmt = this.db.prepare(`
      DELETE FROM history_points
      WHERE timestamp < ?
    `);

    try {
      const result = stmt.run(cutoffTime);
      return result.changes;
    } catch (err: any) {
      console.warn(`Warning: Could not cleanup old history data:`, err.message);
      return 0;
    }
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}
