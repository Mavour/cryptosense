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

  // Hype scan stays manual by default. Auto-broadcasting momentum picks can
  // create FOMO alerts after price has already moved.
  const autoBroadcastHype = process.env.AUTO_BROADCAST_HYPE === 'true';
  if (autoBroadcastHype) {
    console.log(`[Cron] Hype scan scheduled every 2 hours`);

    cron.schedule('30 */2 * * *', async () => {
      console.log('[Cron] Running scheduled HYPE scan...');

      try {
        const result = await runCoinScan(250, 'hype');

        if (result.picks.length === 0) {
          console.log('[Cron] No hype picks found this scan');
          return;
        }

        const header = `🔥 *AUTO-SCAN — HYPE MODE (MANUAL OPT-IN)*\n_${new Date().toLocaleString('id-ID')}_\n\n`;
        const message = header + result.aiAnalysis;

        await broadcastToUsers(bot, message);
        console.log(`[Cron] Hype scan complete. Sent ${result.picks.length} picks.`);

      } catch (err) {
        console.error('[Cron] Hype scan failed:', err.message);
      }
    });
  } else {
    console.log('[Cron] Hype auto-broadcast disabled. Use /hype manually for momentum scans.');
  }

  // Early scan: setiap jam di menit ke-15 (offset biar gak tabrakan)
  console.log(`[Cron] Early scan scheduled every hour (except 00:00-04:00 WITA quiet hours)`);

  function isQuietHours() {
    const now = new Date();
    const witaHour = (now.getUTCHours() + 8) % 24;
    return witaHour >= 0 && witaHour < 4;
  }

  cron.schedule('15 * * * *', async () => {
    if (isQuietHours()) {
      console.log('[Cron] Quiet hours (00:00-04:00 WITA), skipping early scan broadcast');
      return;
    }

    console.log('[Cron] Running scheduled EARLY scan...');

    try {
      const result = await runCoinScan(250, 'early');

      if (result.picks.length === 0) {
        console.log('[Cron] No early picks found this scan');
        return;
      }

      const header = `🕵️ *AUTO-SCAN — CEX SMART MONEY WATCH*\n_${new Date().toLocaleString('id-ID')}_\n\n`;
      const message = header + result.aiAnalysis;

      await broadcastToUsers(bot, message);
      console.log(`[Cron] Early scan complete. Sent ${result.picks.length} picks.`);

    } catch (err) {
      console.error('[Cron] Early scan failed:', err.message);
    }
  });
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function main() {
  console.log('\n' + '═'.repeat(50));
  console.log('  CryptoSense Bot v2.0 — Whale Watch Edition');
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
    { command: 'news',    description: '📰 Analisis sentimen berita     |  /news BTC' },
    { command: 'early',   description: '🕵️ Deteksi akumulasi sebelum pump' },
    { command: 'whale',   description: '🐋 Cek smart money CEX | /whale BTC' },
    { command: 'hype',    description: '🔥 Cari coin viral & momentum (agresif)' },
    { command: 'scan',    description: '🔍 Cari coin oversold + bounce (safe mode)' },
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
