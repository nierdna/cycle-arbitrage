import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';

/**
 * Create Winston logger with daily file rotation
 * Logs are saved to log/ directory with separate files for errors and combined logs
 * Format: combined-YYYY-MM-DD.log, error-YYYY-MM-DD.log
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

  // Daily rotate transport cho combined logs
  const combinedRotateTransport = new DailyRotateFile({
    filename: path.join(logPath, 'combined-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    maxFiles: '30d', // Giữ log trong 30 ngày
    maxSize: '100m',
    format: winston.format.combine(
      timestampFormat,
      winston.format.errors({ stack: true }),
      logFormat
    ),
  });

  // Daily rotate transport cho error logs
  const errorRotateTransport = new DailyRotateFile({
    filename: path.join(logPath, 'error-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    level: 'error',
    maxFiles: '30d', // Giữ error log trong 30 ngày
    format: winston.format.combine(
      timestampFormat,
      winston.format.errors({ stack: true }),
      logFormat
    ),
  });

  // Tạo logger với daily rotation
  const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      timestampFormat,
      winston.format.errors({ stack: true }),
      logFormat
    ),
    defaultMeta: { service: 'cycle-arbitrage' },
    transports: [
      combinedRotateTransport,
      errorRotateTransport,
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

  console.log(`Logging to: ${logPath}/ (daily rotation)`);
  return logger;
}

