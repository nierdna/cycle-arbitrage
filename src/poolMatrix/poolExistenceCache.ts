/**
 * Pool Existence Cache - Manages pool existence status with file persistence
 * Caches pool existence check to avoid repeated on-chain getCode() calls
 * Since pools are deployed via CREATE2 (deterministic), once a pool exists, it will always exist
 */

import { promises as fs } from 'fs';
import path from 'path';

const CACHE_FILE = path.join(process.cwd(), 'data', 'pool-existence.json');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

interface PoolExistenceRecord {
  poolAddress: string;
  exists: boolean;
  timestamp: number;
}

interface CacheData {
  [poolAddress: string]: {
    exists: boolean;
    timestamp: number;
  };
}

export class PoolExistenceCache {
  private cache: Map<string, PoolExistenceRecord> = new Map();
  private loaded = false;

  /**
   * Load cache from file
   */
  async load(): Promise<void> {
    if (this.loaded) return;

    try {
      // Ensure data directory exists
      const cacheDir = path.dirname(CACHE_FILE);
      await fs.mkdir(cacheDir, { recursive: true });

      // Try to read cache file
      const content = await fs.readFile(CACHE_FILE, 'utf-8');
      const data: CacheData = JSON.parse(content);
      const now = Date.now();

      // Load into memory cache (only non-expired entries)
      for (const [poolAddress, record] of Object.entries(data)) {
        const age = now - record.timestamp;
        if (age < CACHE_TTL_MS) {
          // Still valid
          this.cache.set(poolAddress.toLowerCase(), {
            poolAddress: poolAddress.toLowerCase(),
            exists: record.exists,
            timestamp: record.timestamp,
          });
        }
        // Expired entries are ignored (will be re-fetched)
      }

      this.loaded = true;
    } catch (error: any) {
      // File doesn't exist or invalid - start with empty cache
      if (error.code !== 'ENOENT') {
        console.warn(`Failed to load pool existence cache: ${error.message}`);
      }
      this.loaded = true;
    }
  }

  /**
   * Save cache to file
   */
  private async save(): Promise<void> {
    try {
      // Convert Map to plain object
      const data: CacheData = {};
      for (const [poolAddress, record] of this.cache.entries()) {
        data[poolAddress] = {
          exists: record.exists,
          timestamp: record.timestamp,
        };
      }

      // Ensure data directory exists
      const cacheDir = path.dirname(CACHE_FILE);
      await fs.mkdir(cacheDir, { recursive: true });

      // Write to file
      await fs.writeFile(CACHE_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error: any) {
      console.warn(`Failed to save pool existence cache: ${error.message}`);
    }
  }

  /**
   * Get cached pool existence status
   * Returns undefined if not cached or expired
   */
  get(poolAddress: string): boolean | undefined {
    const addressLower = poolAddress.toLowerCase();
    const record = this.cache.get(addressLower);

    if (!record) {
      return undefined; // Not cached
    }

    // Check if expired
    const age = Date.now() - record.timestamp;
    if (age >= CACHE_TTL_MS) {
      // Expired - remove from cache
      this.cache.delete(addressLower);
      return undefined;
    }

    return record.exists;
  }

  /**
   * Set pool existence status (will be saved to file)
   */
  async set(poolAddress: string, exists: boolean): Promise<void> {
    const addressLower = poolAddress.toLowerCase();
    const now = Date.now();

    this.cache.set(addressLower, {
      poolAddress: addressLower,
      exists,
      timestamp: now,
    });

    // Save to file (async, don't wait)
    await this.save();
  }

  /**
   * Check if pool existence is cached (and not expired)
   */
  has(poolAddress: string): boolean {
    const addressLower = poolAddress.toLowerCase();
    const record = this.cache.get(addressLower);

    if (!record) {
      return false;
    }

    // Check if expired
    const age = Date.now() - record.timestamp;
    if (age >= CACHE_TTL_MS) {
      this.cache.delete(addressLower);
      return false;
    }

    return true;
  }

  /**
   * Clear all cache (useful for testing)
   */
  async clear(): Promise<void> {
    this.cache.clear();
    try {
      await fs.unlink(CACHE_FILE);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        console.warn(`Failed to clear pool existence cache file: ${error.message}`);
      }
    }
  }

  /**
   * Get cache size
   */
  get size(): number {
    return this.cache.size;
  }
}

