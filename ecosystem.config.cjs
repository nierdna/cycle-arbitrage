module.exports = {
  apps: [
    {
      name: 'cycle-arbitrage',
      // Production: chạy từ dist/ sau khi build
      script: 'node',
      args: 'dist/examples/main.js',
      cwd: '/home/ubuntu/cycle-arbitrage',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },
    {
      name: 'cycle-arbitrage-dev',
      // Development: chạy trực tiếp từ TS với tsx
      script: 'tsx',
      args: 'examples/main.ts',
      cwd: '/home/ubuntu/cycle-arbitrage',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
      },
      error_file: './logs/pm2-error-dev.log',
      out_file: './logs/pm2-out-dev.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },
  ],
};
