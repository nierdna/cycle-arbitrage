# Cycle Arbitrage

Cycle arbitrage bot for PancakeSwap V3 on BSC with support for multiple cycle clusters.

## Features

- ✅ Cycle cluster support (multiple cycles per cluster)
- ✅ Parallel scanning (each cycle scans independently)
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

## Example Cycle Clusters

The default example uses:

**Cluster 1: USDT-WBNB**
- Cycle 1: USDT -> WBNB -> USDT (fees: [500, 100])
- Cycle 2: USDT -> WBNB -> USDT (fees: [100, 500])

**Cluster 2: USDT-ASTER**
- Cycle 1: USDT -> ASTER -> USDT (fees: [2500, 500])

## Customize Cycles

Edit `examples/main.ts`:

```typescript
const clusters = [
  {
    cycles: [
      {
        tokens: ['USDT', 'ASTER', 'USDT'],
        addresses: [TOKENS.USDT, TOKENS.ASTER, TOKENS.USDT],
        fees: [2500, 500],
      },
    ],
    name: 'USDT-ASTER cluster',
  },
];
```

## Architecture

- **Single file**: All logic in `src/cycleArbitrage.ts`
- **Minimal dependencies**: Only `ethers` and `uniswap-v3-quoter`
- **No fee calculation**: Library handles fees internally
- **Parallel scanning**: Each cycle scans independently in parallel

## Notes

- Supports multiple cycle clusters (like Python version)
- Each cycle in a cluster scans in parallel
- Fee is handled by `QuoterV3` - no manual fee calculation needed
- WebSocket is optional but recommended for real-time updates
- Execution mode requires private key (use with caution!)

## License

MIT

