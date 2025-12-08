/**
 * Migration script: Migrate JSON history files to SQLite database
 * Run this once to migrate existing data
 */

import { promises as fs } from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { HistoricalDataPoint } from './metrics.js';

async function migrateJSONToSQLite(
  historyDir: string = 'data/history',
  dbPath?: string
): Promise<void> {
  const targetDbPath = dbPath || path.join(historyDir, 'history.db');
  
  console.log(`Starting migration from JSON files to SQLite: ${targetDbPath}`);

  // Open or create database
  const db = new Database(targetDbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Initialize schema
  db.exec(`
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

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO history_points 
    (timestamp, cycle_id, arbitrage_bps, best_amount_in_arb_bps, 
     execution_profit, execution_tx_hash, execution_amount_in, execution_arbitrage_bps)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Get all JSON files recursively
  const jsonFiles: string[] = [];

  async function walkDir(dir: string): Promise<void> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          await walkDir(fullPath);
        } else if (
          entry.isFile() && 
          entry.name.endsWith('.json') &&
          !entry.name.endsWith('.tmp') &&
          !entry.name.includes('.corrupted.')
        ) {
          jsonFiles.push(fullPath);
        }
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
  }

  await walkDir(historyDir);

  console.log(`Found ${jsonFiles.length} JSON files to migrate`);

  let totalPoints = 0;
  let migratedFiles = 0;
  let errorFiles = 0;

  // Migrate each file
  const migrateTransaction = db.transaction((points: HistoricalDataPoint[]) => {
    for (const point of points) {
      insertStmt.run(
        point.timestamp,
        point.cycleId,
        point.arbitrageBps ?? null,
        point.bestAmountInArbBps ?? null,
        point.executionProfit !== undefined ? String(point.executionProfit) : null,
        point.executionTxHash ?? null,
        point.executionAmountIn !== undefined ? String(point.executionAmountIn) : null,
        point.executionArbitrageBps ?? null
      );
    }
  });

  for (const filePath of jsonFiles) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const points: HistoricalDataPoint[] = JSON.parse(content);
      
      if (!Array.isArray(points)) {
        console.warn(`Skipping ${filePath}: not a valid JSON array`);
        errorFiles++;
        continue;
      }

      migrateTransaction(points);
      totalPoints += points.length;
      migratedFiles++;

      if (migratedFiles % 10 === 0) {
        console.log(`Migrated ${migratedFiles}/${jsonFiles.length} files, ${totalPoints} points...`);
      }
    } catch (err: any) {
      console.warn(`Error migrating ${filePath}:`, err.message);
      errorFiles++;
    }
  }

  db.close();

  console.log('\nMigration completed!');
  console.log(`  Files migrated: ${migratedFiles}`);
  console.log(`  Files with errors: ${errorFiles}`);
  console.log(`  Total data points: ${totalPoints}`);
  console.log(`  Database: ${targetDbPath}`);
}

// Run migration if called directly
if (process.argv[1] && process.argv[1].endsWith('migrateToSQLite.ts')) {
  const historyDir = process.argv[2] || 'data/history';
  migrateJSONToSQLite(historyDir)
    .then(() => {
      console.log('Migration successful!');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}

export { migrateJSONToSQLite };

