// PM2 Ecosystem Config
// Deploy: pm2 start ecosystem.config.cjs
// Stop:   pm2 stop cryptosense-bot
// Logs:   pm2 logs cryptosense-bot
// Restart: pm2 restart cryptosense-bot

module.exports = {
  apps: [
    {
      name: 'cryptosense-bot',
      script: 'src/index.js',
      interpreter: 'node',
      interpreter_args: '--experimental-vm-modules',

      // Auto-restart
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 3000,

      // Resources
      max_memory_restart: '300M',

      // Logging
      log_file: './logs/combined.log',
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,

      // Environment
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
