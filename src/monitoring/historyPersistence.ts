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
        profit TEXT,
        min_profit TEXT,
        amount_in TEXT,
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

    // Create cycle_statistics table for aggregated statistics
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cycle_statistics (
        cycle_id TEXT PRIMARY KEY,
        total_opportunities INTEGER NOT NULL DEFAULT 0,
        total_executions INTEGER NOT NULL DEFAULT 0,
        first_opportunity_timestamp INTEGER,
        last_opportunity_timestamp INTEGER,
        first_execution_timestamp INTEGER,
        last_execution_timestamp INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cycle_statistics_updated ON cycle_statistics(updated_at);
    `);

    // Create cycle_events table for individual events
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cycle_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cycle_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        arbitrage_bps REAL,
        profit TEXT,
        tx_hash TEXT,
        amount_in TEXT,
        CHECK(event_type IN ('opportunity', 'execution'))
      );

      CREATE INDEX IF NOT EXISTS idx_cycle_events_cycle_id ON cycle_events(cycle_id);
      CREATE INDEX IF NOT EXISTS idx_cycle_events_timestamp ON cycle_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_cycle_events_type ON cycle_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_cycle_events_cycle_timestamp ON cycle_events(cycle_id, timestamp);
    `);

    // Add new columns if they don't exist (for existing databases)
    try {
      this.db.exec(`
        ALTER TABLE history_points ADD COLUMN profit TEXT;
        ALTER TABLE history_points ADD COLUMN min_profit TEXT;
        ALTER TABLE history_points ADD COLUMN amount_in TEXT;
      `);
    } catch (err: any) {
      // Columns might already exist, ignore error
      if (!err.message.includes('duplicate column name')) {
        console.warn('Warning: Could not add new columns to history_points:', err.message);
      }
    }
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
      profit: point.profit !== undefined
        ? String(point.profit)
        : null,
      min_profit: point.minProfit !== undefined
        ? String(point.minProfit)
        : null,
      amount_in: point.amountIn !== undefined
        ? String(point.amountIn)
        : null,
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

    // Add scan data if present
    if (row.profit !== null && row.profit !== undefined) {
      point.profit = row.profit;
    }
    if (row.min_profit !== null && row.min_profit !== undefined) {
      point.minProfit = row.min_profit;
    }
    if (row.amount_in !== null && row.amount_in !== undefined) {
      point.amountIn = row.amount_in;
    }

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
       profit, min_profit, amount_in,
       execution_profit, execution_tx_hash, execution_amount_in, execution_arbitrage_bps)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((points: HistoricalDataPoint[]) => {
      for (const point of points) {
        const row = this.pointToRow(point);
        stmt.run(
          row.timestamp,
          row.cycle_id,
          row.arbitrage_bps,
          row.best_amount_in_arb_bps,
          row.profit,
          row.min_profit,
          row.amount_in,
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
   * Update cycle statistics when opportunity or execution occurs
   */
  async updateCycleStatistics(
    cycleId: string,
    eventType: 'opportunity' | 'execution',
    timestamp: number
  ): Promise<void> {
    const now = Date.now();
    
    // Check if cycle exists
    const checkStmt = this.db.prepare(`
      SELECT cycle_id FROM cycle_statistics WHERE cycle_id = ?
    `);
    const existing = checkStmt.get(cycleId);
    
    if (!existing) {
      // Create new record
      const insertStmt = this.db.prepare(`
        INSERT INTO cycle_statistics 
        (cycle_id, total_opportunities, total_executions, 
         first_opportunity_timestamp, last_opportunity_timestamp,
         first_execution_timestamp, last_execution_timestamp,
         created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      if (eventType === 'opportunity') {
        insertStmt.run(
          cycleId,
          1, // total_opportunities
          0, // total_executions
          timestamp, // first_opportunity_timestamp
          timestamp, // last_opportunity_timestamp
          null, // first_execution_timestamp
          null, // last_execution_timestamp
          now, // created_at
          now  // updated_at
        );
      } else {
        insertStmt.run(
          cycleId,
          0, // total_opportunities
          1, // total_executions
          null, // first_opportunity_timestamp
          null, // last_opportunity_timestamp
          timestamp, // first_execution_timestamp
          timestamp, // last_execution_timestamp
          now, // created_at
          now  // updated_at
        );
      }
    } else {
      // Update existing record
      const updateStmt = this.db.prepare(`
        UPDATE cycle_statistics
        SET 
          total_opportunities = total_opportunities + ?,
          total_executions = total_executions + ?,
          first_opportunity_timestamp = CASE 
            WHEN ? = 1 AND (first_opportunity_timestamp IS NULL OR first_opportunity_timestamp > ?) 
            THEN ? ELSE first_opportunity_timestamp END,
          last_opportunity_timestamp = CASE 
            WHEN ? = 1 AND (last_opportunity_timestamp IS NULL OR last_opportunity_timestamp < ?) 
            THEN ? ELSE last_opportunity_timestamp END,
          first_execution_timestamp = CASE 
            WHEN ? = 1 AND (first_execution_timestamp IS NULL OR first_execution_timestamp > ?) 
            THEN ? ELSE first_execution_timestamp END,
          last_execution_timestamp = CASE 
            WHEN ? = 1 AND (last_execution_timestamp IS NULL OR last_execution_timestamp < ?) 
            THEN ? ELSE last_execution_timestamp END,
          updated_at = ?
        WHERE cycle_id = ?
      `);
      
      const isOpportunity = eventType === 'opportunity' ? 1 : 0;
      const isExecution = eventType === 'execution' ? 1 : 0;
      
      updateStmt.run(
        isOpportunity, // increment total_opportunities
        isExecution, // increment total_executions
        isOpportunity, timestamp, timestamp, // first_opportunity_timestamp
        isOpportunity, timestamp, timestamp, // last_opportunity_timestamp
        isExecution, timestamp, timestamp, // first_execution_timestamp
        isExecution, timestamp, timestamp, // last_execution_timestamp
        now, // updated_at
        cycleId
      );
    }
  }

  /**
   * Get cycle statistics from database
   */
  async getCycleStatistics(cycleId: string): Promise<{
    cycleId: string;
    totalOpportunities: number;
    totalExecutions: number;
    firstOpportunityTimestamp: number | null;
    lastOpportunityTimestamp: number | null;
    firstExecutionTimestamp: number | null;
    lastExecutionTimestamp: number | null;
    createdAt: number;
    updatedAt: number;
  } | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM cycle_statistics WHERE cycle_id = ?
    `);
    
    try {
      const row = stmt.get(cycleId) as any;
      if (!row) return null;
      
      return {
        cycleId: row.cycle_id,
        totalOpportunities: row.total_opportunities,
        totalExecutions: row.total_executions,
        firstOpportunityTimestamp: row.first_opportunity_timestamp,
        lastOpportunityTimestamp: row.last_opportunity_timestamp,
        firstExecutionTimestamp: row.first_execution_timestamp,
        lastExecutionTimestamp: row.last_execution_timestamp,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    } catch (err: any) {
      console.warn(`Warning: Could not load cycle statistics:`, err.message);
      return null;
    }
  }

  /**
   * Get all cycle statistics
   */
  async getAllCycleStatistics(): Promise<Array<{
    cycleId: string;
    totalOpportunities: number;
    totalExecutions: number;
    firstOpportunityTimestamp: number | null;
    lastOpportunityTimestamp: number | null;
    firstExecutionTimestamp: number | null;
    lastExecutionTimestamp: number | null;
    createdAt: number;
    updatedAt: number;
  }>> {
    const stmt = this.db.prepare(`
      SELECT * FROM cycle_statistics ORDER BY updated_at DESC
    `);
    
    try {
      const rows = stmt.all() as any[];
      return rows.map(row => ({
        cycleId: row.cycle_id,
        totalOpportunities: row.total_opportunities,
        totalExecutions: row.total_executions,
        firstOpportunityTimestamp: row.first_opportunity_timestamp,
        lastOpportunityTimestamp: row.last_opportunity_timestamp,
        firstExecutionTimestamp: row.first_execution_timestamp,
        lastExecutionTimestamp: row.last_execution_timestamp,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    } catch (err: any) {
      console.warn(`Warning: Could not load all cycle statistics:`, err.message);
      return [];
    }
  }

  /**
   * Save cycle event (opportunity or execution)
   */
  async saveCycleEvent(
    cycleId: string,
    eventType: 'opportunity' | 'execution',
    timestamp: number,
    data: {
      arbitrageBps?: number;
      profit?: bigint | string;
      txHash?: string;
      amountIn?: bigint | string;
    }
  ): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO cycle_events 
      (cycle_id, event_type, timestamp, arbitrage_bps, profit, tx_hash, amount_in)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    try {
      stmt.run(
        cycleId,
        eventType,
        timestamp,
        data.arbitrageBps ?? null,
        data.profit !== undefined ? String(data.profit) : null,
        data.txHash ?? null,
        data.amountIn !== undefined ? String(data.amountIn) : null
      );
    } catch (err: any) {
      console.error(`Error saving cycle event:`, err.message);
      throw err;
    }
  }

  /**
   * Get cycle events within time range
   */
  async getCycleEvents(
    cycleId: string,
    eventType?: 'opportunity' | 'execution',
    startTime?: number,
    endTime?: number,
    limit?: number
  ): Promise<Array<{
    id: number;
    cycleId: string;
    eventType: string;
    timestamp: number;
    arbitrageBps: number | null;
    profit: string | null;
    txHash: string | null;
    amountIn: string | null;
  }>> {
    let query = `
      SELECT * FROM cycle_events
      WHERE cycle_id = ?
    `;
    const params: any[] = [cycleId];
    
    if (eventType) {
      query += ` AND event_type = ?`;
      params.push(eventType);
    }
    
    if (startTime !== undefined) {
      query += ` AND timestamp >= ?`;
      params.push(startTime);
    }
    
    if (endTime !== undefined) {
      query += ` AND timestamp <= ?`;
      params.push(endTime);
    }
    
    query += ` ORDER BY timestamp DESC`;
    
    if (limit !== undefined) {
      query += ` LIMIT ?`;
      params.push(limit);
    }
    
    const stmt = this.db.prepare(query);
    
    try {
      const rows = stmt.all(...params) as any[];
      return rows.map(row => ({
        id: row.id,
        cycleId: row.cycle_id,
        eventType: row.event_type,
        timestamp: row.timestamp,
        arbitrageBps: row.arbitrage_bps,
        profit: row.profit,
        txHash: row.tx_hash,
        amountIn: row.amount_in,
      }));
    } catch (err: any) {
      console.warn(`Warning: Could not load cycle events:`, err.message);
      return [];
    }
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}

/**
 * Test function to verify profit, minProfit, amountIn persistence
 * Run with: npx tsx src/monitoring/historyPersistence.ts
 */
async function testHistoryPersistence() {
  console.log('🧪 Testing HistoryPersistence with profit, minProfit, amountIn...\n');

  // Use test database in temp directory
  const testDb = new HistoryPersistence('data/history-test');

  try {
    const now = Date.now();
    const testCycleId = 'test-cycle-123';

    // Create test data points with profit, minProfit, amountIn
    const testPoints: HistoricalDataPoint[] = [
      {
        timestamp: now,
        cycleId: testCycleId,
        arbitrageBps: 50.5,
        bestAmountInArbBps: null,
        profit: '1000000000000000000', // 1 ETH in wei (as string)
        minProfit: '500000000000000000', // 0.5 ETH in wei (as string)
        amountIn: '10000000000000000000', // 10 ETH in wei (as string)
      },
      {
        timestamp: now + 1000,
        cycleId: testCycleId,
        arbitrageBps: 75.2,
        bestAmountInArbBps: null,
        profit: '2000000000000000000', // 2 ETH
        minProfit: '600000000000000000', // 0.6 ETH
        amountIn: '15000000000000000000', // 15 ETH
      },
    ];

    // Save test data
    console.log('📝 Saving test data points...');
    await testDb.saveDataPoints(testPoints);
    console.log(`✅ Saved ${testPoints.length} data points\n`);

    // Load and verify
    console.log('📖 Loading data points...');
    const loaded = await testDb.loadDataPoints(
      testCycleId,
      now - 1000,
      now + 2000
    );
    console.log(`✅ Loaded ${loaded.length} data points\n`);

    // Verify data
    console.log('🔍 Verifying data...');
    let allPassed = true;

    for (let i = 0; i < testPoints.length; i++) {
      const original = testPoints[i];
      const loadedPoint = loaded[i];

      const checks = [
        { name: 'arbitrageBps', original: original.arbitrageBps, loaded: loadedPoint.arbitrageBps },
        { name: 'profit', original: original.profit, loaded: loadedPoint.profit },
        { name: 'minProfit', original: original.minProfit, loaded: loadedPoint.minProfit },
        { name: 'amountIn', original: original.amountIn, loaded: loadedPoint.amountIn },
      ];

      for (const check of checks) {
        if (String(check.original) !== String(check.loaded)) {
          console.error(`❌ ${check.name} mismatch: expected ${check.original}, got ${check.loaded}`);
          allPassed = false;
        } else {
          console.log(`✅ ${check.name}: ${check.original}`);
        }
      }
      console.log('');
    }

    if (allPassed) {
      console.log('🎉 All tests passed!');
    } else {
      console.error('❌ Some tests failed');
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Test failed with error:', error);
    process.exit(1);
  } finally {
    // Cleanup
    testDb.close();
    console.log('\n🧹 Test database closed');
  }
}

// Export test function for manual execution
export { testHistoryPersistence };

// Uncomment below to run test directly:
// testHistoryPersistence().catch(console.error);
