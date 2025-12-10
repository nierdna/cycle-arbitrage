# Cycle Persistence - Discovery & Scan Modes

Dự án hỗ trợ 2 modes riêng biệt để tách biệt discovery và scanning phases.

## Tổng quan

### Flow mới:
1. **Discovery Mode**: Discover cycles và save vào JSON file
2. **Scan Mode**: Load cycles từ JSON file và scan

### Lợi ích:
- Tách biệt discovery (tốn thời gian) và scanning (chạy liên tục)
- Có thể filter cycles trước khi scan
- Không cần rediscover mỗi lần restart
- Tối ưu performance bằng cách chỉ scan cycles đã được chọn

## Cách sử dụng

### 1. Discovery Mode (Discover và save cycles)

Chạy discovery để tìm tất cả cycles và save vào file:

```bash
# Development
npm run discover

# Production
npm run build
npm run discover:prod
```

Hoặc set environment variable:
```bash
ARBITRAGE_MODE=discovery npm start
```

**Output**: File `data/cycles.json` sẽ được tạo với tất cả cycles đã discover.

### 2. Scan Mode (Load cycles và scan)

Sau khi có file cycles, chạy scan mode:

```bash
# Development
npm run scan

# Production
npm run build
npm run scan:prod
```

Hoặc set environment variable:
```bash
ARBITRAGE_MODE=scan npm start
```

**Behavior**: Load cycles từ `data/cycles.json` và bắt đầu scan.

### 3. Auto Mode (Mặc định)

Auto mode sẽ tự động detect:
- Nếu file `data/cycles.json` tồn tại → load từ file
- Nếu không → tự động discover

```bash
npm start  # Default: auto mode
```

## Configuration

### Environment Variables

```bash
# Mode selection
ARBITRAGE_MODE=discovery|scan|auto  # Default: auto

# Cycles file path (optional)
CYCLES_FILE_PATH=data/cycles.json  # Default: data/cycles.json
```

### Config File

Có thể config trong `tokens.config.json`:

```json
{
  "tokens": [...],
  "arbitrage": {
    "mode": "scan",
    "cyclesFilePath": "data/cycles.json",
    "validateCyclesOnLoad": true,
    "cyclesWhitelist": ["USDT-WBNB-USDT-100-500", "ASTER-USDT-ASTER-500-100"],
    ...
  },
  "cycles": [
    {
      "cycleId": "USDT-WBNB-USDT-100-500"
    },
    {
      "cycleId": "ASTER-USDT-ASTER-500-100"
    }
  ]
}
```

**Lưu ý**: 
- `cyclesWhitelist` trong `arbitrage` và `cycles` array sẽ được merge
- `cycles` array là cách khuyến nghị (dễ đọc hơn)

## Cycles File Format

File `data/cycles.json` có format:

```json
{
  "metadata": {
    "discoveryTimestamp": 1234567890,
    "tokenListHash": "abc123...",
    "tokenCount": 6,
    "maxHops": 3,
    "discoveryFees": [100, 500, 2500, 10000],
    "totalCycles": 42
  },
  "cycles": [
    {
      "cycleId": "USDT-WBNB-USDT-500-100",
      "tokens": ["USDT", "WBNB", "USDT"],
      "addresses": ["0x...", "0x...", "0x..."],
      "fees": [500, 100],
      "minAmountIn": "10000000000",
      "maxAmountIn": "10000000000000000000000"
    },
    ...
  ]
}
```

## Validation

Khi load cycles từ file, system sẽ:

1. **Validate file existence**: Check file có tồn tại không
2. **Validate token list hash**: So sánh hash của token list hiện tại với hash khi discover
3. **Validate cycles**: Filter cycles có start token không còn `amountConfig`
4. **Resolve pool addresses**: Resolve pool addresses cho tất cả cycles

### Token List Hash Mismatch

Nếu token list thay đổi sau khi discover, system sẽ warning:

```
⚠ Token list hash mismatch! 
File hash: abc123..., Current hash: def456... 
Cycles may be outdated. Consider re-running discovery.
```

**Giải pháp**: Chạy lại discovery mode để update cycles.

## Filtering Cycles

Có 2 cách để filter cycles:

### 1. Whitelist từ Config File (Khuyến nghị)

Thêm field `cycles` vào config file (`tokens.config.json`):

```json
{
  "tokens": [...],
  "arbitrage": {...},
  "cycles": [
    {
      "cycleId": "USDT-WBNB-USDT-100-500"
    },
    {
      "cycleId": "ASTER-USDT-ASTER-500-100"
    },
    {
      "cycleId": "USDT-ASTER-USDT-100-500"
    }
  ]
}
```

**Lợi ích**:
- Chỉ scan cycles trong whitelist
- Áp dụng cả khi discover và khi load từ file
- Dễ quản lý và version control

**Lưu ý**: 
- CycleIds phải match chính xác với cycleId trong cycles file
- Case-insensitive matching
- Nếu cycleId không tồn tại, sẽ có warning log

### 2. Manual Filter (Edit JSON file)

Sau khi discover, bạn có thể:

1. **Manual filter**: Edit file `data/cycles.json` để remove cycles không muốn scan
2. **Script filter**: Viết script để filter cycles dựa trên criteria (liquidity, historical performance, etc.)

**Lưu ý**: Khi edit file, đảm bảo format JSON vẫn valid.

## Workflow khuyến nghị

### Development:
```bash
# 1. Discover cycles (chỉ cần chạy 1 lần hoặc khi token list thay đổi)
npm run discover

# 2. Scan cycles (có thể chạy nhiều lần)
npm run scan
```

### Production:
```bash
# 1. Build
npm run build

# 2. Discover cycles
npm run discover:prod

# 3. Scan cycles (với PM2)
npm run pm2:start
```

## Troubleshooting

### Error: "Cycles file not found"
**Nguyên nhân**: Chưa chạy discovery mode hoặc file bị xóa.

**Giải pháp**: Chạy `npm run discover` để tạo file.

### Error: "No valid cycles found after loading from file"
**Nguyên nhân**: Tất cả cycles đều invalid (start token không còn amountConfig).

**Giải pháp**: 
1. Kiểm tra token config trong `tokens.config.json`
2. Chạy lại discovery mode

### Warning: "Token list hash mismatch"
**Nguyên nhân**: Token list đã thay đổi sau khi discover.

**Giải pháp**: Chạy lại discovery mode để update cycles.

### Cycles không được load
**Nguyên nhân**: File JSON format sai hoặc cycles không có amountConfig.

**Giải pháp**: 
1. Kiểm tra file JSON format
2. Chạy lại discovery mode

## Advanced Usage

### Custom Cycles File Path

```bash
CYCLES_FILE_PATH=./custom-cycles.json npm run discover
CYCLES_FILE_PATH=./custom-cycles.json npm run scan
```

### Disable Validation

Để disable validation khi load (không khuyến nghị):

```json
{
  "arbitrage": {
    "validateCyclesOnLoad": false
  }
}
```

## Notes

- Discovery mode tốn thời gian (có thể vài phút tùy số lượng tokens)
- Scan mode nhanh hơn vì không cần discover
- Cycles file có thể share giữa các instances
- Nên re-discover khi token list thay đổi

