/**
 * Cycle Formatter Utility
 * Formats cycle paths and related display strings
 */

import { TokenRegistry } from '../tokens/tokenRegistry.js';
import { CycleConfig } from '../cycleArbitrage.js';

export class CycleFormatter {
  constructor(private tokenRegistry: TokenRegistry) {}

  /**
   * Format cycle path with token names if available
   * Example: "USDT -> WBNB -> USDT" or "0x123... -> 0x456... -> 0x123..."
   */
  formatCyclePath(tokens: string[]): string {
    return tokens
      .map((tokenAddress) => {
        const token = this.tokenRegistry.getToken(tokenAddress);
        return token?.displayName || `${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}`;
      })
      .join(' -> ');
  }

  /**
   * Format cycle for logging
   */
  formatCycleForLog(cycle: CycleConfig, index?: number): string {
    const tokensPath = this.formatCyclePath(cycle.tokens);
    const feesStr = cycle.fees.join(', ');
    const prefix = index !== undefined ? `  [${index + 1}]` : '';
    return `${prefix} ${tokensPath} | fees: [${feesStr}] bps`;
  }
}

