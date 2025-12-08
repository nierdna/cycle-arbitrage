/**
 * Min Profit Calculator
 * Calculates minimum profit required for arbitrage based on gas costs
 */

import { ethers } from 'ethers';
import winston from 'winston';
import { CycleWithState } from '../cycleArbitrage.js';
import { GasPriceService } from './gasPriceService.js';
import { TokenPriceService } from './tokenPriceService.js';
import { DecimalCache } from '../tokens/decimalCache.js';

// WBNB address on BSC
const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';

// Gas used constants (from tradeExecutor)
const GAS_USED_2_POOLS = 231398;
const GAS_USED_3_POOLS = 321410;

export class MinProfitCalculator {
  constructor(
    private gasPriceService: GasPriceService,
    private tokenPriceService: TokenPriceService,
    private decimalCache: DecimalCache,
    private logger: winston.Logger
  ) {}

  /**
   * Calculate minimum profit based on gas cost
   * Formula: minProfit = (gasUsed * gasPrice * wbnbPrice) / startTokenPrice
   * 
   * @param cycle Cycle information to get start token address
   * @param poolCount Number of pools (2 or 3)
   * @returns Minimum profit in start token units (with correct decimals)
   */
  async calculateMinProfit(
    cycle: CycleWithState,
    poolCount: number
  ): Promise<bigint> {
    try {
      // Get gas used based on pool count
      const gasUsed = poolCount === 2 ? GAS_USED_2_POOLS : GAS_USED_3_POOLS;

      // Get gas price from service
      const gasPriceWei = this.gasPriceService.getGasPrice();

      // Calculate gas value in wei
      const gasValueWei = BigInt(gasUsed) * gasPriceWei;

      // Get WBNB price in USDT from service
      const wbnbPrice = this.tokenPriceService.getPrice(WBNB_ADDRESS);

      if (!wbnbPrice || wbnbPrice <= 0) {
        this.logger.warn('Failed to get WBNB price from service, using default minProfit = 1');
        return 1n;
      }

      // Get start token address (first token in cycle)
      const startTokenAddress = cycle.addresses[0];

      // Get start token price in USDT from service
      const startTokenPrice = this.tokenPriceService.getPrice(startTokenAddress);

      if (!startTokenPrice || startTokenPrice <= 0) {
        this.logger.warn(
          `Failed to get start token price for ${startTokenAddress} from service, using default minProfit = 1`
        );
        return 1n;
      }

      // Calculate gas value in WBNB (WBNB has 18 decimals)
      // gasValueWBNB = gasValueWei / 1e18
      const gasValueWBNB = Number(gasValueWei) / 1e18;

      // Calculate dollar value
      const dollarValue = gasValueWBNB * wbnbPrice;

      // Calculate minProfit in token units: dollarValue / startTokenPrice
      const minProfitTokens = dollarValue / startTokenPrice;

      // Get start token decimals
      const startTokenDecimals = await this.decimalCache.getDecimals(startTokenAddress);

      // Convert to token units with correct decimals
      // minProfitWei = minProfitTokens * 10^decimals
      const minProfitWei = BigInt(Math.ceil(minProfitTokens * Math.pow(10, startTokenDecimals)));

      this.logger.debug(
        `Calculated minProfit: gasUsed=${gasUsed}, gasPrice=${ethers.formatUnits(gasPriceWei, 'gwei')} gwei, ` +
        `wbnbPrice=$${wbnbPrice.toFixed(2)}, startTokenPrice=$${startTokenPrice.toFixed(2)}, ` +
        `dollarValue=$${dollarValue.toFixed(4)}, minProfit=${ethers.formatUnits(minProfitWei, startTokenDecimals)} tokens (${minProfitWei.toString()} wei)`
      );

      return minProfitWei;
    } catch (error: any) {
      this.logger.warn(`Failed to calculate minProfit: ${error.message}, using default minProfit = 1`);
      return 1n;
    }
  }
}

