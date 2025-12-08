/**
 * Telegram Notification Service
 * Sends notifications to Telegram group when execution events occur
 */

import 'dotenv/config'; // Load .env file
import axios from 'axios';
import winston from 'winston';
import { ethers } from 'ethers';

export interface TelegramConfig {
  botToken: string; // Bot token from @BotFather
  chatId: string; // Group chat ID (có thể là số hoặc username với @)
  enabled?: boolean; // Enable/disable notifications (default: true)
}

export interface ExecutionNotificationData {
  cycleId: string;
  profit: bigint;
  txHash?: string;
  amountIn?: bigint;
  amountOut?: bigint;
  arbitrageBps?: number;
}

export class TelegramNotifier {
  private botToken: string;
  private chatId: string;
  private enabled: boolean;
  private logger: winston.Logger;
  private readonly apiUrl = 'https://api.telegram.org/bot';

  constructor(config: TelegramConfig, logger: winston.Logger) {
    if (!config.botToken) {
      throw new Error('Telegram botToken is required');
    }
    if (!config.chatId) {
      throw new Error('Telegram chatId is required');
    }

    this.botToken = config.botToken;
    this.chatId = config.chatId;
    this.enabled = config.enabled ?? true;
    this.logger = logger;
  }

  /**
   * Send execution notification to Telegram group
   */
  async sendExecutionNotification(data: ExecutionNotificationData): Promise<void> {
    if (!this.enabled) {
      this.logger.debug('Telegram notifications are disabled');
      return;
    }

    try {
      const message = this.formatExecutionMessage(data);
      await this.sendMessage(message);
      this.logger.info(`[Telegram] Execution notification sent for cycle ${data.cycleId}`);
    } catch (error: any) {
      this.logger.error(`[Telegram] Failed to send notification:`, error);
      // Don't throw - notification failure shouldn't break execution flow
    }
  }

  /**
   * Format execution message with emoji and formatting
   */
  private formatExecutionMessage(data: ExecutionNotificationData): string {
    const profitFormatted = ethers.formatEther(data.profit);
    const profitBps = data.arbitrageBps?.toFixed(2) || 'N/A';
    
    // Format amountIn if available
    const amountInFormatted = data.amountIn 
      ? ethers.formatEther(data.amountIn) 
      : 'N/A';
    
    // Format amountOut if available
    const amountOutFormatted = data.amountOut 
      ? ethers.formatEther(data.amountOut) 
      : 'N/A';

    // Format transaction hash with explorer link
    const txLink = data.txHash
      ? `[View on BSCScan](https://bscscan.com/tx/${data.txHash})`
      : 'Pending...';

    const timestamp = new Date().toLocaleString('en-US', {
      timeZone: 'Asia/Ho_Chi_Minh',
      dateStyle: 'short',
      timeStyle: 'medium',
    });

    return `🎯 *Arbitrage Execution*

*Cycle:* \`${data.cycleId}\`
*Profit:* ${profitFormatted} tokens (${profitBps} bps)
*Amount In:* ${amountInFormatted} tokens
*Amount Out:* ${amountOutFormatted} tokens
*TX Hash:* ${txLink}
*Time:* ${timestamp}

✅ Bundle submitted successfully`;
  }

  /**
   * Send message to Telegram
   */
  private async sendMessage(text: string): Promise<void> {
    const url = `${this.apiUrl}${this.botToken}/sendMessage`;
    
    const response = await axios.post(url, {
      chat_id: this.chatId,
      text: text,
      parse_mode: 'Markdown',
      disable_web_page_preview: false,
    }, {
      timeout: 10000, // 10 seconds timeout
    });

    if (!response.data.ok) {
      throw new Error(`Telegram API error: ${response.data.description || 'Unknown error'}`);
    }
  }

  /**
   * Test notification (for setup verification)
   */
  async testNotification(): Promise<void> {
    if (!this.enabled) {
      throw new Error('Telegram notifications are disabled');
    }

    const testMessage = `🤖 *Telegram Bot Test*

Bot is configured correctly and ready to send notifications!

*Time:* ${new Date().toLocaleString('en-US', {
      timeZone: 'Asia/Ho_Chi_Minh',
      dateStyle: 'short',
      timeStyle: 'medium',
    })}`;

    await this.sendMessage(testMessage);
    this.logger.info('[Telegram] Test notification sent successfully');
  }

  /**
   * Enable/disable notifications
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.logger.info(`[Telegram] Notifications ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Check if notifications are enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }
}

/**
 * Test script - Run this file directly to test Telegram notification
 * Usage: tsx src/notifications/telegramNotifier.ts
 * Or: node dist/notifications/telegramNotifier.js
 * 
 * Requires environment variables:
 * - TELEGRAM_BOT_TOKEN: Bot token from @BotFather
 * - TELEGRAM_CHAT_ID: Group chat ID
 */
// Check if this file is being run directly (not imported)
const isMainModule = 
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.includes('telegramNotifier');

if (isMainModule) {
  (async () => {
    try {
      console.log('=== Telegram Notification Test ===\n');

      // Check environment variables
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;

      if (!botToken) {
        console.error('❌ Error: TELEGRAM_BOT_TOKEN not set in environment variables');
        console.log('\nPlease set TELEGRAM_BOT_TOKEN in .env file or export it:');
        console.log('  export TELEGRAM_BOT_TOKEN=your_bot_token');
        process.exit(1);
      }

      if (!chatId) {
        console.error('❌ Error: TELEGRAM_CHAT_ID not set in environment variables');
        console.log('\nPlease set TELEGRAM_CHAT_ID in .env file or export it:');
        console.log('  export TELEGRAM_CHAT_ID=your_chat_id');
        process.exit(1);
      }

      console.log('✓ Environment variables loaded');
      console.log(`  Bot Token: ${botToken.substring(0, 10)}...`);
      console.log(`  Chat ID: ${chatId}\n`);

      // Create simple logger for testing
      const winston = await import('winston');
      const logger = winston.default.createLogger({
        level: 'info',
        format: winston.default.format.simple(),
        transports: [new winston.default.transports.Console()],
      });

      // Create TelegramNotifier instance
      const notifier = new TelegramNotifier(
        {
          botToken,
          chatId,
          enabled: true,
        },
        logger
      );

      console.log('Sending test notification...\n');

      // Send test notification
      await notifier.testNotification();

      console.log('\n✅ Test notification sent successfully!');
      console.log('Check your Telegram group to see the message.\n');

    } catch (error: any) {
      console.error('\n❌ Test failed:', error?.message || String(error));
      if (error?.response?.data) {
        console.error('Telegram API response:', JSON.stringify(error.response.data, null, 2));
      }
      process.exit(1);
    }
  })();
}

