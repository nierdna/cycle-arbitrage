/**
 * Decimal Cache - Manages token decimals with file persistence
 * Caches ERC20 token decimals to avoid repeated on-chain calls
 */

import { ethers } from 'ethers';
import { promises as fs } from 'fs';
import path from 'path';
import { ERC20_ABI } from '../constants.js';

const CACHE_FILE = path.join(process.cwd(), 'data', 'token-decimals.json');

export class DecimalCache {
  private cache: Map<string, number> = new Map();
  private provider?: ethers.Provider;
  private loaded = false;

  constructor(provider?: ethers.Provider) {
    this.provider = provider;
  }

  /**
   * Load decimals cache from file
   */
  async load(): Promise<void> {
    if (this.loaded) return;

    try {
      // Ensure data directory exists
      const cacheDir = path.dirname(CACHE_FILE);
      await fs.mkdir(cacheDir, { recursive: true });

      // Try to read cache file
      const content = await fs.readFile(CACHE_FILE, 'utf-8');
      const data = JSON.parse(content);

      // Load into memory cache
      for (const [address, decimals] of Object.entries(data)) {
        this.cache.set(address.toLowerCase(), decimals as number);
      }

      this.loaded = true;
    } catch (error: any) {
      // File doesn't exist or invalid - start with empty cache
      if (error.code !== 'ENOENT') {
        console.warn(`Failed to load decimal cache: ${error.message}`);
      }
      this.loaded = true;
    }
  }

  /**
   * Save decimals cache to file
   */
  private async save(): Promise<void> {
    try {
      // Convert Map to plain object
      const data: Record<string, number> = {};
      for (const [address, decimals] of this.cache.entries()) {
        data[address] = decimals;
      }

      // Ensure data directory exists
      const cacheDir = path.dirname(CACHE_FILE);
      await fs.mkdir(cacheDir, { recursive: true });

      // Write to file
      await fs.writeFile(CACHE_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error: any) {
      console.warn(`Failed to save decimal cache: ${error.message}`);
    }
  }

  /**
   * Get decimals for a token address
   * - First checks memory cache
   * - Then checks file cache (after loading)
   * - Finally fetches from chain if not cached
   */
  async getDecimals(tokenAddress: string): Promise<number> {
    // Ensure cache is loaded
    if (!this.loaded) {
      await this.load();
    }

    const addressLower = tokenAddress.toLowerCase();

    // Check memory cache first
    if (this.cache.has(addressLower)) {
      return this.cache.get(addressLower)!;
    }

    // Fetch from chain if provider is available
    if (this.provider) {
      try {
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
        const decimals = await tokenContract.decimals();
        const decimalsNumber = Number(decimals);

        // Cache it
        this.cache.set(addressLower, decimalsNumber);
        await this.save(); // Persist to file

        return decimalsNumber;
      } catch (error: any) {
        // If fetching fails, default to 18 (most common)
        console.warn(`Failed to fetch decimals for ${tokenAddress}: ${error.message}. Defaulting to 18.`);
        const defaultDecimals = 18;
        this.cache.set(addressLower, defaultDecimals);
        await this.save();
        return defaultDecimals;
      }
    }

    // No provider - default to 18
    const defaultDecimals = 18;
    this.cache.set(addressLower, defaultDecimals);
    await this.save();
    return defaultDecimals;
  }

  /**
   * Set decimals manually (for known tokens)
   */
  async setDecimals(tokenAddress: string, decimals: number): Promise<void> {
    const addressLower = tokenAddress.toLowerCase();
    this.cache.set(addressLower, decimals);
    await this.save();
  }

  /**
   * Check if decimals are cached
   */
  hasDecimals(tokenAddress: string): boolean {
    return this.cache.has(tokenAddress.toLowerCase());
  }

  /**
   * Get all cached decimals
   */
  getAll(): Map<string, number> {
    return new Map(this.cache);
  }
}

