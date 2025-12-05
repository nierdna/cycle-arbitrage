/**
 * Path Finder
 * Finds all valid cycles using DFS algorithm
 */

import { PoolMatrix, CycleCandidate, PoolInfo } from './types.js';

export class PathFinder {
  /**
   * Get all neighbors (tokens) that can be reached from current token
   */
  private getNeighbors(
    currentToken: string,
    matrix: PoolMatrix
  ): Array<{ token: string; poolKey: string; pool: PoolInfo }> {
    const neighbors: Array<{ token: string; poolKey: string; pool: PoolInfo }> = [];

    for (const [poolKey, pool] of matrix.pools.entries()) {
      const [t0, t1] = poolKey.split('-');
      
      if (t0.toLowerCase() === currentToken.toLowerCase()) {
        // Can go from currentToken to t1
        neighbors.push({ token: t1, poolKey, pool });
      } else if (t1.toLowerCase() === currentToken.toLowerCase()) {
        // Can go from currentToken to t0
        neighbors.push({ token: t0, poolKey, pool });
      }
    }

    return neighbors;
  }

  /**
   * Find all cycles starting from a token using DFS
   */
  private findAllCyclesDFS(
    currentToken: string,
    startToken: string,
    path: string[],
    pathPools: Array<{ token: string; pool: PoolInfo }>,
    matrix: PoolMatrix,
    maxHops: number,
    visited: Set<string>,
    usedPools: Set<string>
  ): CycleCandidate[] {
    const cycles: CycleCandidate[] = [];

    // Base case: found a cycle (back to startToken)
    // path.length > 0 means we've visited at least one token
    if (path.length > 0 && currentToken.toLowerCase() === startToken.toLowerCase()) {
      // Build cycle candidate
      // path contains tokens we've visited, add startToken at the end to complete cycle
      const tokens = [...path, startToken];
      const addresses = tokens; // Same as tokens in this case
      const fees: number[] = [];
      const poolAddresses: string[] = [];

      for (const pathPool of pathPools) {
        fees.push(pathPool.pool.fee);
        poolAddresses.push(pathPool.pool.poolAddress);
      }

      cycles.push({
        tokens,
        addresses,
        fees,
        poolAddresses,
      });

      return cycles;
    }

    // Max hops reached
    if (path.length >= maxHops) {
      return cycles;
    }

    // Get neighbors
    const neighbors = this.getNeighbors(currentToken, matrix);

    for (const neighbor of neighbors) {
      // Avoid loops (except when returning to startToken)
      const neighborLower = neighbor.token.toLowerCase();
      if (neighborLower === startToken.toLowerCase() || !visited.has(neighborLower)) {
        // Check if pool has already been used in this path (avoid same pool in cycle)
        if (usedPools.has(neighbor.poolKey.toLowerCase())) {
          continue; // Skip pool that's already been used
        }

        const newPath = [...path, currentToken];
        const newPathPools = [...pathPools, { token: neighbor.token, pool: neighbor.pool }];
        const newVisited = new Set(visited);
        newVisited.add(currentToken.toLowerCase());
        const newUsedPools = new Set(usedPools);
        newUsedPools.add(neighbor.poolKey.toLowerCase());

        const foundCycles = this.findAllCyclesDFS(
          neighbor.token,
          startToken,
          newPath,
          newPathPools,
          matrix,
          maxHops,
          newVisited,
          newUsedPools
        );

        cycles.push(...foundCycles);
      }
    }

    return cycles;
  }

  /**
   * Find all cycles for a given start token
   */
  findAllCycles(
    matrix: PoolMatrix,
    startToken: string,
    maxHops: number = 3
  ): CycleCandidate[] {
    const cycles = this.findAllCyclesDFS(
      startToken,
      startToken,
      [],
      [],
      matrix,
      maxHops,
      new Set(),
      new Set() // usedPools: track pools already used in current path
    );

    // Deduplicate cycles (same tokens + fees)
    const seen = new Set<string>();
    const uniqueCycles: CycleCandidate[] = [];

    for (const cycle of cycles) {
      const key = `${cycle.tokens.join('-')}-${cycle.fees.join('-')}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueCycles.push(cycle);
      }
    }

    return uniqueCycles;
  }

  /**
   * Validate a cycle candidate
   * Checks that all pools exist and path is valid
   */
  validateCycle(candidate: CycleCandidate, matrix: PoolMatrix): boolean {
    // Check that we have enough pools for the path
    if (candidate.poolAddresses.length !== candidate.tokens.length - 1) {
      return false;
    }

    // Check that all pools exist (non-zero addresses)
    for (const poolAddress of candidate.poolAddresses) {
      if (!poolAddress || poolAddress === '0x0000000000000000000000000000000000000000') {
        return false;
      }
    }

    // Check that path is valid (each hop has a pool)
    for (let i = 0; i < candidate.tokens.length - 1; i++) {
      const token0 = candidate.tokens[i];
      const token1 = candidate.tokens[i + 1];
      const fee = candidate.fees[i];

      const key = this.getPoolKey(token0, token1, fee);
      const pool = matrix.pools.get(key);

      if (!pool) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get pool key for a token pair with fee (sorted, lowercase)
   */
  private getPoolKey(token0: string, token1: string, fee: number): string {
    const [t0, t1] = [token0, token1].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );
    return `${t0.toLowerCase()}-${t1.toLowerCase()}-${fee}`;
  }
}

