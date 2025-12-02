# Cycle Arbitrage MVP

MVP implementation of cycle arbitrage bot for PancakeSwap V3 on BSC.

## Features

- ✅ Single cycle support (minimal implementation)
- ✅ Real-time quotes using `uniswap-v3-quoter`
- ✅ WebSocket support for instant pool state updates
- ✅ Auto-execution mode (optional)
- ✅ Fee handling done by library (no manual fee calculation)

## Installation

```bash
cd cycle-arbitrage
npm install
```

## Configuration

Create `.env` file or set environment variables:

```bash
# Required
export BSC_RPC_URL=https://bsc-dataseed.binance.org/

# Optional: For real-time updates
export BSC_WSS_URL=wss://bsc-mainnet.nodereal.io/ws/v1/YOUR_API_KEY

# Optional: For auto-execution
export PRIVATE_KEY=0x...
```

## Usage

### Scan Only (No Execution)

```bash
npm start
```

### With Execution

```bash
export PRIVATE_KEY=0x...
npm start
```

## Example Cycle

The default example uses:
- **Cycle**: USDT -> WBNB -> USDT
- **Fees**: [500, 100] bps (0.05%, 0.01%)
- **Min Arbitrage**: 2 bps
- **Scan Interval**: 10ms

## Customize Cycle

Edit `examples/main.ts`:

```typescript
const cycle = {
  tokens: ['USDT', 'ASTER', 'USDT'],
  addresses: [TOKENS.USDT, TOKENS.ASTER, TOKENS.USDT],
  fees: [2500, 500], // 0.25%, 0.05%
};
```

## Architecture

- **Single file**: All logic in `src/cycleArbitrage.ts`
- **Minimal dependencies**: Only `ethers` and `uniswap-v3-quoter`
- **No fee calculation**: Library handles fees internally

## Notes

- This is an MVP - minimal implementation for one cycle only
- Fee is handled by `QuoterV3` - no manual fee calculation needed
- WebSocket is optional but recommended for real-time updates
- Execution mode requires private key (use with caution!)

## License

MIT

