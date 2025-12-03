/**
 * History Persistence
 * Saves and loads historical data points to/from files organized by time
 * Format: data/history/YYYY/MM/DD/HH.json
 */

import { promises as fs } from 'fs';
import path from 'path';
import { HistoricalDataPoint } from './metrics.js';

export class HistoryPersistence {
  private historyDir: string;

  constructor(historyDir: string = 'data/history') {
    this.historyDir = historyDir;
  }

  /**
   * Get file path for a given timestamp
   * Format: data/history/YYYY/MM/DD/HH.json
   */
  private getHistoryFilePath(timestamp: number): string {
    const date = new Date(timestamp);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hour = String(date.getUTCHours()).padStart(2, '0');

    return path.join(this.historyDir, String(year), month, day, `${hour}.json`);
  }

  /**
   * Save data points to file (append mode)
   * Creates directory structure if needed
   */
  async saveDataPoints(points: HistoricalDataPoint[]): Promise<void> {
    if (points.length === 0) return;

    // Group points by hour (same file)
    const pointsByFile = new Map<string, HistoricalDataPoint[]>();

    for (const point of points) {
      const filePath = this.getHistoryFilePath(point.timestamp);
      if (!pointsByFile.has(filePath)) {
        pointsByFile.set(filePath, []);
      }
      pointsByFile.get(filePath)!.push(point);
    }

    // Save each file
    for (const [filePath, filePoints] of pointsByFile) {
      try {
        // Ensure directory exists
        await fs.mkdir(path.dirname(filePath), { recursive: true });

        // Read existing data if file exists
        let existingData: HistoricalDataPoint[] = [];
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          existingData = JSON.parse(content);
        } catch (err: any) {
          // File doesn't exist or is invalid, start fresh
          if (err.code !== 'ENOENT') {
            console.warn(`Warning: Could not read history file ${filePath}:`, err.message);
          }
        }

        // Merge and deduplicate by timestamp + cycleId
        const merged = [...existingData, ...filePoints];
        const unique = new Map<string, HistoricalDataPoint>();
        
        for (const point of merged) {
          const key = `${point.timestamp}-${point.cycleId}`;
          // Keep the latest one if duplicate
          if (!unique.has(key) || unique.get(key)!.timestamp < point.timestamp) {
            unique.set(key, point);
          }
        }

        // Sort by timestamp
        const sorted = Array.from(unique.values()).sort((a, b) => a.timestamp - b.timestamp);

        // Write back to file
        await fs.writeFile(filePath, JSON.stringify(sorted, null, 2), 'utf-8');
      } catch (err: any) {
        console.error(`Error saving history to ${filePath}:`, err.message);
      }
    }
  }

  /**
   * Load data points from files within time range
   */
  async loadDataPoints(
    cycleId: string,
    startTime: number,
    endTime: number
  ): Promise<HistoricalDataPoint[]> {
    const allPoints: HistoricalDataPoint[] = [];

    // Calculate date range
    const startDate = new Date(startTime);
    const endDate = new Date(endTime);

    // Iterate through all hours in range
    const currentDate = new Date(startDate);
    currentDate.setUTCMinutes(0);
    currentDate.setUTCSeconds(0);
    currentDate.setUTCMilliseconds(0);

    while (currentDate <= endDate) {
      const filePath = this.getHistoryFilePath(currentDate.getTime());
      
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const filePoints: HistoricalDataPoint[] = JSON.parse(content);
        
        // Filter by cycleId and time range
        for (const point of filePoints) {
          if (
            point.cycleId === cycleId &&
            point.timestamp >= startTime &&
            point.timestamp <= endTime
          ) {
            allPoints.push(point);
          }
        }
      } catch (err: any) {
        // File doesn't exist or is invalid, skip
        if (err.code !== 'ENOENT') {
          console.warn(`Warning: Could not read history file ${filePath}:`, err.message);
        }
      }

      // Move to next hour
      currentDate.setUTCHours(currentDate.getUTCHours() + 1);
    }

    // Sort by timestamp
    return allPoints.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Load all data points from files (for initialization)
   */
  async loadAllDataPoints(maxAgeMs?: number): Promise<HistoricalDataPoint[]> {
    const allPoints: HistoricalDataPoint[] = [];
    const cutoffTime = maxAgeMs ? Date.now() - maxAgeMs : 0;

    try {
      // Recursively read all JSON files in history directory
      const files = await this.getAllHistoryFiles();
      
      for (const filePath of files) {
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const filePoints: HistoricalDataPoint[] = JSON.parse(content);
          
          for (const point of filePoints) {
            if (point.timestamp >= cutoffTime) {
              allPoints.push(point);
            }
          }
        } catch (err: any) {
          console.warn(`Warning: Could not read history file ${filePath}:`, err.message);
        }
      }
    } catch (err: any) {
      // Directory doesn't exist yet, that's ok
      if (err.code !== 'ENOENT') {
        console.warn(`Warning: Could not read history directory:`, err.message);
      }
    }

    // Sort by timestamp
    return allPoints.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Get all history files recursively
   */
  private async getAllHistoryFiles(): Promise<string[]> {
    const files: string[] = [];

    async function walkDir(dir: string): Promise<void> {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          
          if (entry.isDirectory()) {
            await walkDir(fullPath);
          } else if (entry.isFile() && entry.name.endsWith('.json')) {
            files.push(fullPath);
          }
        }
      } catch (err: any) {
        if (err.code !== 'ENOENT') {
          throw err;
        }
      }
    }

    await walkDir(this.historyDir);
    return files;
  }

  /**
   * Clean up old files (older than maxAgeMs)
   */
  async cleanupOldFiles(maxAgeMs: number): Promise<number> {
    const cutoffTime = Date.now() - maxAgeMs;
    let deletedCount = 0;

    try {
      const files = await this.getAllHistoryFiles();
      
      for (const filePath of files) {
        try {
          const stats = await fs.stat(filePath);
          if (stats.mtimeMs < cutoffTime) {
            await fs.unlink(filePath);
            deletedCount++;
          }
        } catch (err: any) {
          console.warn(`Warning: Could not delete file ${filePath}:`, err.message);
        }
      }
    } catch (err: any) {
      console.warn(`Warning: Could not cleanup history files:`, err.message);
    }

    return deletedCount;
  }
}

