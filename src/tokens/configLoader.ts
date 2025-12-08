/**
 * Token Config Loader - Loads tokens from JSON config file
 */

import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { ethers } from 'ethers';
import { Token } from './token.js';
import { TokenAmountConfig } from '../cycleArbitrage.js';

export interface TokenConfig {
  address: string;
  name?: string;
  amountConfig?: {
    minAmountIn: string;
    maxAmountIn: string;
  };
}

export interface ArbitrageConfig {
  discoveryFees?: number[];
  minArbitrageBps?: number;
  scanIntervalMs?: number;
  amountIn?: string; // BigInt as string
  optimizeAmountIn?: boolean;
  optimizationInterval?: number;
  optimizationPrecision?: string; // BigInt as string
  dashboardPort?: number;
  maxHops?: number;
  gasPriceUpdateInterval?: number;
  tokenPriceUpdateInterval?: number;
}

export interface TokensConfigFile {
  tokens: TokenConfig[];
  arbitrage?: ArbitrageConfig;
}

/**
 * Load tokens from JSON config file
 * @param configPath Path to config file (default: tokens.config.json in project root)
 * @returns Array of Token instances
 * @throws Error if file not found, invalid JSON, or invalid token config
 */
export function loadTokensFromConfig(configPath?: string): Token[] {
  const defaultPath = join(process.cwd(), 'tokens.config.json');
  const envPath = process.env.TOKENS_CONFIG_PATH;
  const rawPath = configPath || envPath || defaultPath;
  
  // Resolve path (handles both relative and absolute paths)
  // resolve() works correctly for both relative and absolute paths
  const filePath = resolve(rawPath);

  let fileContent: string;
  try {
    fileContent = readFileSync(filePath, 'utf-8');
  } catch (error) {
    throw new Error(
      `Failed to read tokens config file at ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let config: TokensConfigFile;
  try {
    config = JSON.parse(fileContent);
  } catch (error) {
    throw new Error(
      `Invalid JSON in tokens config file: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!config.tokens || !Array.isArray(config.tokens)) {
    throw new Error('Config file must contain a "tokens" array');
  }

  const tokens: Token[] = [];

  for (const tokenConfig of config.tokens) {
    // Validate address
    if (!tokenConfig.address || typeof tokenConfig.address !== 'string') {
      throw new Error(`Invalid token address: ${JSON.stringify(tokenConfig.address)}`);
    }

    // Validate address format (ethers will validate)
    try {
      ethers.getAddress(tokenConfig.address);
    } catch (error) {
      throw new Error(
        `Invalid token address format: ${tokenConfig.address} - ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Parse amountConfig if provided
    let amountConfig: TokenAmountConfig | undefined;
    if (tokenConfig.amountConfig) {
      const { minAmountIn, maxAmountIn } = tokenConfig.amountConfig;

      if (!minAmountIn || !maxAmountIn) {
        throw new Error(`Token ${tokenConfig.address} missing minAmountIn or maxAmountIn`);
      }

      try {
        const min = BigInt(minAmountIn);
        const max = BigInt(maxAmountIn);

        if (min >= max) {
          throw new Error(
            `Token ${tokenConfig.address}: minAmountIn (${minAmountIn}) must be less than maxAmountIn (${maxAmountIn})`
          );
        }

        amountConfig = { minAmountIn: min, maxAmountIn: max };
      } catch (error) {
        if (error instanceof Error && error.message.includes('must be less')) {
          throw error;
        }
        throw new Error(
          `Token ${tokenConfig.address}: Invalid amount config - ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    tokens.push(new Token(tokenConfig.address, tokenConfig.name, amountConfig));
  }

  return tokens;
}

/**
 * Load arbitrage config from JSON config file
 * @param configPath Path to config file (default: tokens.config.json in project root)
 * @returns ArbitrageConfig object or undefined if not found
 * @throws Error if file not found or invalid JSON
 */
export function loadArbitrageConfig(configPath?: string): ArbitrageConfig | undefined {
  const defaultPath = join(process.cwd(), 'tokens.config.json');
  const envPath = process.env.TOKENS_CONFIG_PATH;
  const rawPath = configPath || envPath || defaultPath;
  
  // Resolve path (handles both relative and absolute paths)
  const filePath = resolve(rawPath);

  let fileContent: string;
  try {
    fileContent = readFileSync(filePath, 'utf-8');
  } catch (error) {
    throw new Error(
      `Failed to read tokens config file at ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let config: TokensConfigFile;
  try {
    config = JSON.parse(fileContent);
  } catch (error) {
    throw new Error(
      `Invalid JSON in tokens config file: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!config.arbitrage) {
    return undefined;
  }

  const arbitrageConfig: ArbitrageConfig = { ...config.arbitrage };

  // Convert string BigInt values to actual BigInt if needed (for validation)
  // Note: We keep them as strings in the config, but validate format
  if (arbitrageConfig.amountIn) {
    try {
      BigInt(arbitrageConfig.amountIn);
    } catch (error) {
      throw new Error(
        `Invalid amountIn in arbitrage config: ${arbitrageConfig.amountIn} - ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (arbitrageConfig.optimizationPrecision) {
    try {
      BigInt(arbitrageConfig.optimizationPrecision);
    } catch (error) {
      throw new Error(
        `Invalid optimizationPrecision in arbitrage config: ${arbitrageConfig.optimizationPrecision} - ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Validate discoveryFees
  if (arbitrageConfig.discoveryFees) {
    if (!Array.isArray(arbitrageConfig.discoveryFees)) {
      throw new Error('discoveryFees must be an array');
    }
    for (const fee of arbitrageConfig.discoveryFees) {
      if (typeof fee !== 'number' || fee < 0) {
        throw new Error(`Invalid discovery fee: ${fee}. Must be a non-negative number`);
      }
    }
  }

  return arbitrageConfig;
}

