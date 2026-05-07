/**
 * =============================================
 * CRYPTOSENSE BOT — Main Entry Point
 * =============================================
 * Starts: Telegram bot + cron jobs
 * Run: node src/index.js
 * PM2: pm2 start ecosystem.config.cjs
 */

import 'dotenv/config';
import cron from 'node-cron';
import { createBot } from './bot/handlers.js';
import { runCoinScan } from './utils/scanner.js';
import { getAllUserIds } from './utils/database.js';

// ─────────────────────────────────────────────
// Startup validation
// ─────────────────────────────────────────────
function validateEnv() {
  const required = ['TELEGRAM_BOT_TOKEN', 'OPENROUTER_API_KEY'];
  const missing = required.filter(k => !process.env[k]);

  if (missing.length > 0) {
    console.error(`\n❌ Missing required env vars: ${missing.join(', ')}`);
    console.error('   Copy .env.example ke .env dan isi API keys\n');
    process.exit(1);
  }
}

// ─────────────────────────────────────────────
// Send message to all users (untuk broadcast scan)
// ─────────────────────────────────────────────
async function broadcastToUsers(bot, message) {
  const userIds = getAllUserIds();
  const adminId = process.env.ADMIN_CHAT_ID;

  // Jika ada ADMIN_CHAT_ID, kirim ke admin saja (lebih aman untuk MVP)
  if (adminId) {
    try {
      await bot.api.sendMessage(adminId, message, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error('[Broadcast] Failed to send to admin:', e.message);
    }
    return;
  }

  // Broadcast ke semua users
  for (const userId of userIds) {
    try {
      await bot.api.sendMessage(userId, message, { parse_mode: 'Markdown' });
      await new Promise(r => setTimeout(r, 50)); // 50ms delay antar message
    } catch (e) {
      console.warn(`[Broadcast] Failed for user ${userId}:`, e.message);
    }
  }
}

// ─────────────────────────────────────────────
// Auto-scan cron jobs
// ─────────────────────────────────────────────
function setupCronJobs(bot) {
  const scanHours = parseInt(process.env.SCAN_INTERVAL_HOURS) || 4;

  // Safe scan: setiap 4 jam di menit ke-0
  const safeCron = `0 */${scanHours} * * *`;
  console.log(`[Cron] Safe scan scheduled every ${scanHours} hours`);

  cron.schedule(safeCron, async () => {
    console.log('[Cron] Running scheduled SAFE scan...');

    try {
      const result = await runCoinScan(250, 'safe');

      if (result.picks.length === 0) {
        console.log('[Cron] No safe picks found this scan');
        return;
      }

      const header = `🔍 *AUTO-SCAN — SAFE MODE*\n_${new Date().toLocaleString('id-ID')}_\n\n`;
      const message = header + result.aiAnalysis;

      await broadcastToUsers(bot, message);
      console.log(`[Cron] Safe scan complete. Sent ${result.picks.length} picks.`);

    } catch (err) {
      console.error('[Cron] Safe scan failed:', err.message);
    }
  });

  // Hype scan: setiap 2 jam di menit ke-30 (offset biar gak tabrakan)
  console.log(`[Cron] Hype scan scheduled every 2 hours`);

  cron.schedule('30 */2 * * *', async () => {
    console.log('[Cron] Running scheduled HYPE scan...');

    try {
      const result = await runCoinScan(250, 'hype');

      if (result.picks.length === 0) {
        console.log('[Cron] No hype picks found this scan');
        return;
      }

      const header = `🔥 *AUTO-SCAN — HYPE MODE*\n_${new Date().toLocaleString('id-ID')}_\n\n`;
      const message = header + result.aiAnalysis;

      await broadcastToUsers(bot, message);
      console.log(`[Cron] Hype scan complete. Sent ${result.picks.length} picks.`);

    } catch (err) {
      console.error('[Cron] Hype scan failed:', err.message);
    }
  });

  // Daily watchlist digest — setiap hari jam 08:00 WIB (01:00 UTC)
  cron.schedule('0 1 * * *', async () => {
    console.log('[Cron] Running daily watchlist digest...');

    const userIds = getAllUserIds();
    const adminId = process.env.ADMIN_CHAT_ID;
    const targetUsers = adminId ? [adminId] : userIds;

    for (const userId of targetUsers) {
      try {
        const { getWatchlist } = await import('./utils/database.js');
        const { fetchBinanceTicker } = await import('./ta/marketData.js');
        const { formatPrice } = await import('./ta/marketData.js');

        const watchlist = getWatchlist(userId);
        if (watchlist.length === 0) continue;

        const priceData = await Promise.allSettled(
          watchlist.map(w => fetchBinanceTicker(w.symbol))
        );

        let msg = `🌅 *DAILY WATCHLIST DIGEST*\n_${new Date().toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}_\n\n`;

        watchlist.forEach((w, i) => {
          const result = priceData[i];
          if (result.status === 'fulfilled') {
            const t = result.value;
            const emoji = t.priceChangePct >= 2 ? '🚀' : t.priceChangePct >= 0 ? '📈' : t.priceChangePct >= -2 ? '📉' : '💥';
            msg += `${emoji} *${w.symbol}:* $${formatPrice(t.price)} (${t.priceChangePct > 0 ? '+' : ''}${t.priceChangePct}%)\n`;
          }
        });

        msg += `\n_Gunakan /signal SYMBOL untuk analisis lebih dalam_`;

        await bot.api.sendMessage(userId, msg, { parse_mode: 'Markdown' });
        await new Promise(r => setTimeout(r, 100));

      } catch (e) {
        console.warn(`[Cron] Daily digest failed for ${userId}:`, e.message);
      }
    }
  });
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function main() {
  console.log('\n' + '═'.repeat(50));
  console.log('  CryptoSense Bot v1.0');
  console.log('  Powered by OpenRouter + Binance + CoinGecko');
  console.log('═'.repeat(50) + '\n');

  validateEnv();

  const bot = createBot();

  // Setup cron jobs
  setupCronJobs(bot);

  // Graceful shutdown
  process.once('SIGINT', () => {
    console.log('\n[Main] Shutting down gracefully...');
    bot.stop();
    process.exit(0);
  });

  process.once('SIGTERM', () => {
    bot.stop();
    process.exit(0);
  });

  // ── Set command menu Telegram (muncul saat user klik "/" di input) ──
  await bot.api.setMyCommands([
    { command: 'signal',  description: '⚡ Sinyal beli/jual + SL & TP  |  /signal BTC' },
    { command: 'analyze', description: '📊 Analisis lengkap TA + AI    |  /analyze ETH 4h' },
    { command: 'wave',    description: '🌊 Elliott Wave explanation     |  /wave SOL' },
    { command: 'news',    description: '📰 Analisis sentimen berita     |  /news BTC' },
    { command: 'scan',    description: '🔍 Cari coin oversold + bounce (safe mode)' },
    { command: 'hype',    description: '🔥 Cari coin viral & momentum (agresif)' },
    { command: 'macro',   description: '🌍 Overview kondisi makro market' },
    { command: 'watch',   description: '👁 Tambah watchlist  |  /watch BTC ETH SOL' },
    { command: 'list',    description: '📋 Lihat watchlist + harga terkini' },
    { command: 'unwatch', description: '🗑 Hapus dari watchlist  |  /unwatch BTC' },
    { command: 'status',  description: '🤖 Status bot & statistik' },
    { command: 'help',    description: '📖 Panduan lengkap semua command' },
  ]);
  console.log('[Main] ✅ Command menu registered in Telegram');

  // Start bot
  console.log('[Main] Starting bot...');
  await bot.start({
    onStart: (botInfo) => {
      console.log(`[Main] ✅ Bot @${botInfo.username} is running!`);
      console.log(`[Main] Send /start to @${botInfo.username} to test\n`);
    },
  });
}

main().catch((err) => {
  console.error('\n[Main] Fatal error:', err);
  process.exit(1);
});
