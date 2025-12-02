# Quick Start Guide

## Setup

1. **Install dependencies:**
```bash
cd cycle-arbitrage
npm install
```

2. **Set environment variables:**
```bash
export BSC_RPC_URL=https://bsc-dataseed.binance.org/
# Optional:
export BSC_WSS_URL=wss://bsc-mainnet.nodereal.io/ws/v1/YOUR_API_KEY
export PRIVATE_KEY=0x... # Only if you want auto-execution
```

3. **Run:**
```bash
npm start
```

## What it does

- Scans for arbitrage opportunities in a single cycle (e.g., USDT -> WBNB -> USDT)
- Uses real-time quotes from `uniswap-v3-quoter` library
- Fee is handled automatically by the library (no manual calculation)
- Optionally executes trades if `PRIVATE_KEY` is set

## Customize Cycle

Edit `examples/main.ts`:

```typescript
const cycle = {
  tokens: ['USDT', 'ASTER', 'USDT'],
  addresses: [TOKENS.USDT, TOKENS.ASTER, TOKENS.USDT],
  fees: [2500, 500], // 0.25%, 0.05%
};
```

## Notes

- This is MVP - minimal implementation
- Only supports 1 cycle (not multiple cycles)
- Fee calculation is done by library internally
- WebSocket is optional but recommended for real-time updates

