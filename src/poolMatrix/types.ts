/**
 * Types for Pool Matrix and Cycle Discovery
 */

export interface PoolInfo {
  token0: string;
  token1: string;
  fee: number; // 100, 500, 2500, 10000 in bps
  poolAddress: string;
  exists: boolean;
}

export interface PoolMatrix {
  // Key: "token0-token1-fee" (sorted, lowercase), Value: PoolInfo
  pools: Map<string, PoolInfo>;
  // All unique tokens
  tokens: Set<string>;
}

export interface CycleCandidate {
  tokens: string[];
  addresses: string[];
  fees: number[];
  poolAddresses: string[];
}

