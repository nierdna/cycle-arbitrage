/**
 * Rate Limiter
 * Limits the rate of async operations to prevent overwhelming external services
 */

export class RateLimiter {
  private queue: Array<() => Promise<any>> = [];
  private running = 0;
  private maxConcurrent: number;
  private delayMs: number;

  /**
   * Create a rate limiter
   * 
   * @param maxConcurrent - Maximum number of concurrent operations (default: 50)
   * @param delayMs - Delay in milliseconds between operations (default: 10ms)
   * 
   * Example: maxConcurrent=50, delayMs=10 means max ~100 ops/second
   */
  constructor(maxConcurrent: number = 50, delayMs: number = 10) {
    this.maxConcurrent = maxConcurrent;
    this.delayMs = delayMs;
  }

  /**
   * Execute a function with rate limiting
   * 
   * @param fn - Function to execute
   * @returns Promise that resolves with the function result
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      this.process();
    });
  }

  /**
   * Process the queue
   * Automatically processes tasks up to maxConcurrent limit
   */
  private async process(): Promise<void> {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    this.running++;
    const task = this.queue.shift()!;
    
    try {
      await task();
    } finally {
      // Add delay between operations to respect rate limit
      await new Promise(resolve => setTimeout(resolve, this.delayMs));
      this.running--;
      // Process next task
      this.process();
    }
  }

  /**
   * Get current queue size
   */
  getQueueSize(): number {
    return this.queue.length;
  }

  /**
   * Get number of currently running operations
   */
  getRunningCount(): number {
    return this.running;
  }
}

