import winston from 'winston';
import path from 'path';
import fs from 'fs';

/**
 * Create Winston logger with file rotation
 * Logs are saved to log/ directory with separate files for errors and combined logs
 */
export function createLogger(logDir: string = 'log'): winston.Logger {
  // Tạo folder log nếu chưa tồn tại
  const logPath = path.join(process.cwd(), logDir);
  if (!fs.existsSync(logPath)) {
    fs.mkdirSync(logPath, { recursive: true });
  }

  // Format timestamp
  const timestampFormat = winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss.SSS',
  });

  // Format log message
  const logFormat = winston.format.printf(({ level, message, timestamp, ...metadata }) => {
    let msg = `${timestamp} [${level.toUpperCase()}]: ${message}`;
    if (Object.keys(metadata).length > 0) {
      msg += ` ${JSON.stringify(metadata)}`;
    }
    return msg;
  });

  // Tạo logger với file rotation
  const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      timestampFormat,
      winston.format.errors({ stack: true }),
      logFormat
    ),
    defaultMeta: { service: 'cycle-arbitrage' },
    transports: [
      // File log với rotation theo ngày
      new winston.transports.File({
        filename: path.join(logPath, 'error.log'),
        level: 'error',
        maxsize: 5242880, // 5MB
        maxFiles: 7, // Giữ 7 file
      }),
      new winston.transports.File({
        filename: path.join(logPath, 'combined.log'),
        maxsize: 5242880, // 5MB
        maxFiles: 7,
      }),
      // Console output với màu sắc
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          timestampFormat,
          logFormat
        ),
      }),
    ],
  });

  console.log(`Logging to: ${logPath}/combined.log`);
  return logger;
}

