# Test Guide

## Setup

```bash
npm install
```

## Run Tests

```bash
# Run tests in watch mode
npm test

# Run tests once
npm run test:run

# Run tests with coverage
npm run test:coverage
```

## Test Files

- `src/services/tradeExecutor.test.ts` - Tests for TradeExecutor service

## Test Coverage

Test suite covers:
- ✅ Reverse pools logic (2 pools và 3 pools)
- ✅ ZeroForOne flags calculation
- ✅ Bundle creation và submission
- ✅ Edge cases (1 pool, 4+ pools)
- ✅ Gas limits configuration
- ✅ Price limits setting
- ✅ Transaction details
- ✅ Metrics recording
- ✅ Error handling

## Notes

- Tests use Vitest framework với mock cho axios, ethers, winston
- Test data sử dụng token addresses thật từ BSC
- Bundle submission được mock để không gửi request thật

