/**
 * Token class - Encapsulates token information
 */

import { TokenAmountConfig } from '../cycleArbitrage.js';

export class Token {
  constructor(
    public readonly address: string,
    public readonly name?: string,
    public readonly amountConfig?: TokenAmountConfig
  ) {}

  /**
   * Get lowercase address for consistent lookups
   */
  get addressLower(): string {
    return this.address.toLowerCase();
  }

  /**
   * Get display name (name or shortened address)
   */
  get displayName(): string {
    return this.name || `${this.address.slice(0, 6)}...${this.address.slice(-4)}`;
  }

  /**
   * Check if token has amount config
   */
  hasAmountConfig(): boolean {
    return this.amountConfig !== undefined;
  }
}

