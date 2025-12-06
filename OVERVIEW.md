# Cycle Arbitrage Bot - Overview

Bot tự động tìm và thực thi cycle arbitrage trên PancakeSwap V3 (BSC).

## Tính năng chính

- **Auto-discovery**: Tự động tìm tất cả cycles từ token registry
- **Parallel scanning**: Quét nhiều cycles song song
- **Amount optimization**: Tối ưu amountIn bằng Ternary Search
- **Auto-execution**: Tự động execute trades (optional)
- **Monitoring**: Dashboard HTTP, metrics, lưu lịch sử

## Cấu trúc

```
src/
├── cycleArbitrage.ts          # Main orchestrator
├── services/                  # Core services
│   ├── cycleDiscovery.ts      # Auto-discover cycles
│   ├── cycleScanner.ts        # Scan cycles continuously
│   └── tradeExecutor.ts       # Execute trades
├── poolMatrix/                # Pool matrix & path finder
├── tokens/                    # Token registry
├── optimization/              # Amount optimizer
└── monitoring/                # Metrics & dashboard
```

## Cách chạy

### 1. Setup

```bash
npm install
```

### 2. Cấu hình environment

Tạo file `.env`:

```bash
BSC_RPC_URL=https://bsc-dataseed.binance.org/
BSC_WSS_URL=wss://...  # Optional: real-time updates
PRIVATE_KEY=0x...      # Optional: chỉ cần khi enable execution
```

### 3. Cấu hình tokens

Sửa `examples/main.ts`:

```typescript
tokenRegistry.addToken(new Token(
  TOKENS.USDT,
  'USDT',
  {
    minAmountIn: BigInt(1e10),  // 0.0001 USDT
    maxAmountIn: BigInt(1e19),  // 10 USDT
  }
));
```

**Lưu ý**: Tất cả tokens phải có `amountConfig`. Cycles bắt đầu từ token không có config sẽ bị bỏ qua.

### 4. Chạy bot

```bash
# Development
npm start

# Production
npm run build
npm run start:prod

# PM2
npm run pm2:start
```

## Cấu hình options

```typescript
const arbitrage = new CycleArbitrage(provider, tokenRegistry, {
  minArbitrageBps: 2,              // Minimum profit (2 bps)
  scanIntervalMs: 1,               // Scan interval (1ms)
  amountIn: BigInt(1e18),          // Default test amount
  optimizeAmountIn: true,          // Enable optimization
  optimizationInterval: 100,       // Re-optimize every N scans
  optimizationPrecision: BigInt(1e15), // 0.001 tokens precision
  dashboardPort: 8080,             // HTTP dashboard port
  maxHops: 3,                      // Max cycle hops
  discoveryFees: [100, 500, 2500, 10000], // Fees to try
});
```

## Execution mode

Để enable auto-execution:

1. Set `PRIVATE_KEY` trong `.env`
2. Gọi `arbitrage.setExecution(wallet)` trong code

**⚠️ Cảnh báo**: Execution mode sẽ tự động execute trades khi phát hiện opportunity!

## Dashboard

Truy cập dashboard tại `http://localhost:8080` (nếu enable):

- Real-time metrics
- Cycle performance
- Historical charts
- Opportunity tracking

## Lưu ý quan trọng

1. **Token registry**: Tất cả tokens phải có `amountConfig` trước khi discovery
2. **Gas costs**: Execution mode tốn gas đáng kể (~800k-1M per trade)
3. **WebSocket**: Nên dùng WSS để real-time updates, không bắt buộc
4. **Amount optimization**: Chỉ enable khi cần, tốn thêm thời gian scan
5. **PM2**: Dùng PM2 cho production để auto-restart

## Files quan trọng

- `examples/main.ts` - Entry point, cấu hình tokens
- `src/cycleArbitrage.ts` - Main orchestrator
- `src/services/cycleDiscovery.ts` - Auto-discovery logic
- `src/services/tradeExecutor.ts` - Execution logic

## Troubleshooting

- **Cycles không được discover**: Kiểm tra token có `amountConfig` chưa
- **Execution fail**: Kiểm tra balance, gas limit, pool state
- **High gas**: Giảm số cycles hoặc tắt optimization

