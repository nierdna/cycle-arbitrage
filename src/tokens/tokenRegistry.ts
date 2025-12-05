/**
 * Token Registry - Manages token collection
 */

import { Token } from './token.js';
import { TokenAmountConfig } from '../cycleArbitrage.js';

export class TokenRegistry {
  private tokens: Map<string, Token> = new Map();

  /**
   * Add a single token to registry
   */
  addToken(token: Token): void {
    this.tokens.set(token.addressLower, token);
  }

  /**
   * Add multiple tokens to registry
   */
  addTokens(tokens: Token[]): void {
    tokens.forEach(token => this.addToken(token));
  }

  /**
   * Get token by address (case-insensitive)
   */
  getToken(address: string): Token | undefined {
    return this.tokens.get(address.toLowerCase());
  }

  /**
   * Get token name by address
   */
  getTokenName(address: string): string | undefined {
    return this.getToken(address)?.name;
  }

  /**
   * Get token amount config by address
   */
  getTokenAmountConfig(address: string): TokenAmountConfig | undefined {
    return this.getToken(address)?.amountConfig;
  }

  /**
   * Get all token addresses
   */
  getAllAddresses(): string[] {
    return Array.from(this.tokens.values()).map(token => token.address);
  }

  /**
   * Get all tokens
   */
  getAllTokens(): Token[] {
    return Array.from(this.tokens.values());
  }

  /**
   * Get number of tokens
   */
  get size(): number {
    return this.tokens.size;
  }

  /**
   * Check if token exists
   */
  hasToken(address: string): boolean {
    return this.tokens.has(address.toLowerCase());
  }
}

