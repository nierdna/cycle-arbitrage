/**
 * Amount Optimizer
 * Finds optimal amountIn that maximizes arbitrage BPS using Ternary Search
 */

export interface OptimizationResult {
  amountIn: bigint;
  arbitrageBps: number;
}

/**
 * AmountOptimizer class for finding optimal input amounts
 * Uses Ternary Search algorithm (works well for unimodal functions)
 */
export class AmountOptimizer {
  constructor(
    private calculateArbitrageBps: (cycleId: string, amountIn: bigint) => Promise<number>
  ) {}

  /**
   * Find optimal amountIn that maximizes arbitrageBps using Ternary Search
   * Ternary search works well for unimodal functions (single peak)
   *
   * @param cycleId Cycle identifier
   * @param minAmount Minimum amount to search
   * @param maxAmount Maximum amount to search
   * @param precision Precision for ternary search (stop when range < precision)
   * @returns Optimal amount and corresponding arbitrage BPS
   */
  async findOptimalAmountIn(
    cycleId: string,
    minAmount: bigint,
    maxAmount: bigint,
    precision: bigint
  ): Promise<OptimizationResult> {
    let left = minAmount;
    let right = maxAmount;

    // Ternary search
    while (right - left > precision) {
      const third = (right - left) / 3n;
      const mid1 = left + third;
      const mid2 = right - third;

      const [arb1, arb2] = await Promise.all([
        this.calculateArbitrageBps(cycleId, mid1),
        this.calculateArbitrageBps(cycleId, mid2),
      ]);

      if (arb1 > arb2) {
        right = mid2;
      } else {
        left = mid1;
      }
    }

    const optimalAmount = (left + right) / 2n;
    const optimalArb = await this.calculateArbitrageBps(cycleId, optimalAmount);

    return { amountIn: optimalAmount, arbitrageBps: optimalArb };
  }
}

