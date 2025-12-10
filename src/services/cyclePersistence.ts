/**
 * Cycle Persistence Service
 * Handles saving and loading cycles to/from JSON file
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { CycleWithAmounts } from './cycleDiscovery.js';
import winston from 'winston';

export interface CycleMetadata {
  discoveryTimestamp: number;
  tokenListHash: string;
  tokenCount: number;
  maxHops: number;
  discoveryFees: number[];
  totalCycles: number;
}

export interface CyclesFile {
  metadata: CycleMetadata;
  cycles: CycleWithAmounts[];
}

export class CyclePersistenceService {
  constructor(
    private defaultFilePath: string = 'data/cycles.json',
    private logger?: winston.Logger
  ) {}

  /**
   * Save cycles to JSON file with metadata
   */
  saveCycles(
    cycles: CycleWithAmounts[],
    metadata: {
      tokenListHash: string;
      tokenCount: number;
      maxHops: number;
      discoveryFees: number[];
    }
  ): void {
    const cyclesFile: CyclesFile = {
      metadata: {
        discoveryTimestamp: Date.now(),
        tokenListHash: metadata.tokenListHash,
        tokenCount: metadata.tokenCount,
        maxHops: metadata.maxHops,
        discoveryFees: metadata.discoveryFees,
        totalCycles: cycles.length,
      },
      cycles: cycles.map((cycle) => ({
        ...cycle,
        // Convert bigint to string for JSON serialization
        minAmountIn: cycle.minAmountIn.toString(),
        maxAmountIn: cycle.maxAmountIn.toString(),
      })) as any,
    };

    try {
      // Ensure directory exists
      const pathParts = this.defaultFilePath.split('/');
      if (pathParts.length > 1) {
        const dir = pathParts.slice(0, -1).join('/');
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
      }

      writeFileSync(this.defaultFilePath, JSON.stringify(cyclesFile, null, 2), 'utf-8');
      this.logger?.info(
        `Saved ${cycles.length} cycles to ${this.defaultFilePath}`
      );
    } catch (error: any) {
      this.logger?.error(`Failed to save cycles to ${this.defaultFilePath}:`, error);
      throw error;
    }
  }

  /**
   * Load cycles from JSON file
   * Returns cycles with bigint values restored
   */
  loadCycles(filePath?: string): {
    cycles: CycleWithAmounts[];
    metadata: CycleMetadata;
  } {
    const targetPath = filePath || this.defaultFilePath;

    if (!existsSync(targetPath)) {
      throw new Error(
        `Cycles file not found: ${targetPath}. Please run discovery first.`
      );
    }

    try {
      const fileContent = readFileSync(targetPath, 'utf-8');
      const cyclesFile: CyclesFile = JSON.parse(fileContent);

      // Validate file structure
      if (!cyclesFile.metadata || !Array.isArray(cyclesFile.cycles)) {
        throw new Error('Invalid cycles file format');
      }

      // Restore bigint values
      const cycles: CycleWithAmounts[] = cyclesFile.cycles.map((cycle: any) => ({
        ...cycle,
        minAmountIn: BigInt(cycle.minAmountIn),
        maxAmountIn: BigInt(cycle.maxAmountIn),
      }));

      this.logger?.info(
        `Loaded ${cycles.length} cycles from ${targetPath} ` +
        `(discovered at: ${new Date(cyclesFile.metadata.discoveryTimestamp).toISOString()})`
      );

      return {
        cycles,
        metadata: cyclesFile.metadata,
      };
    } catch (error: any) {
      this.logger?.error(`Failed to load cycles from ${targetPath}:`, error);
      throw error;
    }
  }

  /**
   * Check if cycles file exists
   */
  cyclesFileExists(filePath?: string): boolean {
    const targetPath = filePath || this.defaultFilePath;
    return existsSync(targetPath);
  }

  /**
   * Get metadata from cycles file without loading all cycles
   */
  getMetadata(filePath?: string): CycleMetadata | null {
    const targetPath = filePath || this.defaultFilePath;

    if (!existsSync(targetPath)) {
      return null;
    }

    try {
      const fileContent = readFileSync(targetPath, 'utf-8');
      const cyclesFile: CyclesFile = JSON.parse(fileContent);
      return cyclesFile.metadata;
    } catch (error: any) {
      this.logger?.warn(`Failed to read metadata from ${targetPath}:`, error);
      return null;
    }
  }

  /**
   * Calculate hash of token list for validation
   */
  static calculateTokenListHash(tokenAddresses: string[]): string {
    // Simple hash: sort addresses and join
    const sorted = [...tokenAddresses].sort().join(',');
    // Use a simple hash function (for simplicity, just use the string length and first/last chars)
    // In production, you might want to use a proper hash function
    return Buffer.from(sorted).toString('base64').slice(0, 16);
  }
}

