/**
 * =============================================
 * CRYPTOSENSE BOT — Telegram Bot Handlers
 * =============================================
 * Framework: Grammy
 * Commands: /start /analyze /signal /wave /news /watch /unwatch /list /scan /macro /status /help
 */

import { Bot, InlineKeyboard } from 'grammy';
import axios from 'axios';
import { fetchBinanceKlines, fetchBinanceTicker, fetchCryptoNews,
         fetchFearGreedIndex, fetchBTCDominance, fetchTrendingCoins, formatPrice } from '../ta/marketData.js';
import { runFullAnalysis } from '../ta/indicators.js';
import { analyzeSignal, analyzeElliottWave, analyzeNews, analyzeMacro, freeChat, analyzeChartImage } from '../ai/analyzer.js';
import { addToWatchlist, removeFromWatchlist, getWatchlist, upsertUser, getStats } from '../utils/database.js';
import { runCoinScan } from '../utils/scanner.js';

// ─────────────────────────────────────────────
// Initialize bot
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// resolveSymbol — map nama/alias coin ke simbol Binance
// Juga handle typo umum dan coin dengan nama panjang
// ─────────────────────────────────────────────
function resolveSymbol(input) {
  const clean = input.toUpperCase()
    .replace(/[^A-Z0-9]/g, '')  // hapus karakter non-alphanumeric
    .replace(/USDT$/, '')       // strip USDT kalau sudah ada
    .trim();

  // Map nama populer → simbol Binance
  const nameMap = {
    // Nama lengkap umum
    'BITCOIN': 'BTC', 'ETHEREUM': 'ETH', 'SOLANA': 'SOL',
    'RIPPLE': 'XRP', 'CARDANO': 'ADA', 'DOGECOIN': 'DOGE',
    'AVALANCHE': 'AVAX', 'POLKADOT': 'DOT', 'CHAINLINK': 'LINK',
    'LITECOIN': 'LTC', 'UNISWAP': 'UNI', 'COSMOS': 'ATOM',
    'NEARPROTOCOL': 'NEAR', 'NEAR': 'NEAR',
    'SHIBA': 'SHIB', 'SHIBAINU': 'SHIB',
    'PEPE': 'PEPE', 'FLOKI': 'FLOKI',
    'TRON': 'TRX', 'STELLAR': 'XLM',
    'POLYGON': 'POL', 'MATIC': 'POL',
    'ARBITRUM': 'ARB', 'OPTIMISM': 'OP',
    'APTOS': 'APT', 'SUI': 'SUI',
    'INJECTIVE': 'INJ', 'SEI': 'SEI',
    'HYPERLIQUID': 'HYPE', 'HYPE': 'HYPE',
    // Meme coins
    'FARTCOIN': 'FARTCOIN', 'WIF': 'WIF',
    'DOGWIFHAT': 'WIF', 'BONK': 'BONK',
    'POPCAT': 'POPCAT', 'MEW': 'MEW',
    // Lainnya
    'WORLDCOIN': 'WLD', 'RENDER': 'RENDER',
    'FETCHAI': 'FET', 'FETCH': 'FET',
    'TONCOIN': 'TON', 'TON': 'TON',
  };

  return nameMap[clean] || clean;
}

export function createBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set in .env');

  const bot = new Bot(token);

  // ── Middleware: register user ─────────────────
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      upsertUser(ctx.from.id, ctx.from.username || ctx.from.first_name || '');
    }
    await next();
  });

  // ─────────────────────────────────────────────
  // /start — Welcome message
  // ─────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    const name = ctx.from?.first_name || 'Trader';
    await ctx.reply(
      `👋 *Halo ${name}!*\n\n` +
      `Aku *CryptoSense* — AI Trading Assistant kamu.\n\n` +
      `🎯 *Yang bisa aku bantu:*\n` +
      `• Analisis teknikal real-time (RSI, EMA, MACD)\n` +
      `• Sinyal beli/jual dengan SL & TP\n` +
      `• Elliott Wave explanation\n` +
      `• Analisis sentimen berita\n` +
      `• Coin discovery scan otomatis\n` +
      `• Macro market overview\n\n` +
      `📖 Ketik /help untuk melihat semua command\n\n` +
      `_⚠️ Disclaimer: Ini bukan financial advice. Selalu manage risiko kamu sendiri._`,
      { parse_mode: 'Markdown' }
    );
  });

  // ─────────────────────────────────────────────
  // /help — Command list
  // ─────────────────────────────────────────────
  bot.command('help', async (ctx) => {
    await ctx.reply(
      `📖 *DAFTAR COMMAND*\n\n` +
      `*Analisis:*\n` +
      `/analyze BTC 4h — Analisis lengkap + sinyal\n` +
      `/signal ETH — Sinyal cepat beli/jual + SL/TP\n` +
      `/wave SOL — Penjelasan Elliott Wave\n` +
      `/news BTC — Analisis berita + dampak harga\n\n` +
      `*Discovery:*\n` +
      `/scan — Cari coin berpotensi naik\n\n` +
      `*Watchlist:*\n` +
      `/watch BTC ETH SOL — Tambah ke watchlist\n` +
      `/unwatch BTC — Hapus dari watchlist\n` +
      `/list — Lihat watchlist kamu\n\n` +
      `*Market:*\n` +
      `/macro — Overview kondisi makro market\n\n` +
      `*Lainnya:*\n` +
      `/status — Status bot\n` +
      `/help — Tampilkan bantuan ini\n\n` +
      `💬 *Atau tanya langsung!*\n` +
      `_"BTC kapan entry?"_ atau _"ETH aman beli sekarang?"_`,
      { parse_mode: 'Markdown' }
    );
  });

  // ─────────────────────────────────────────────
  // /analyze [SYMBOL] [TIMEFRAME] — Full analysis
  // ─────────────────────────────────────────────
  bot.command('analyze', async (ctx) => {
    const args = ctx.message?.text?.split(' ').slice(1) || [];
    const symbol = args[0]?.toUpperCase() || 'BTC';
    const timeframe = args[1] || '4h';

    const statusMsg = await ctx.reply(`🔍 Menganalisis *${symbol}* timeframe *${timeframe}*...\n_Fetching data & running TA engine..._`, {
      parse_mode: 'Markdown'
    });

    try {
      const resolvedSymbol = resolveSymbol(symbol);
      if (resolvedSymbol !== symbol) {
        console.log(`[Bot] Symbol resolved: ${symbol} → ${resolvedSymbol}`);
      }
      const [candles, ticker] = await Promise.all([
        fetchBinanceKlines(resolvedSymbol, timeframe, 200),
        fetchBinanceTicker(resolvedSymbol),
      ]);

      await editMessage(ctx, statusMsg, `🧮 Menghitung indikator...\n_RSI, MACD, EMA, Bollinger Bands..._`);

      const analysis = runFullAnalysis(candles, symbol, timeframe);

      // Fetch news for context
      let newsContext = '';
      try {
        const news = await fetchCryptoNews([symbol], 'hot');
        if (news.length > 0) {
          newsContext = news.slice(0, 3).map(n =>
            `[${n.sentiment.toUpperCase()}] ${n.title} (${n.source})`
          ).join('\n');
        }
      } catch (e) { /* news optional */ }

      await editMessage(ctx, statusMsg, `🤖 AI sedang menganalisis...\n_Elliott Wave, SMC, Risk Management..._`);

      const aiResponse = await analyzeSignal(analysis, newsContext);

      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      await ctx.reply(aiResponse, { parse_mode: 'Markdown' });

      // Send quick summary keyboard
      const kb = new InlineKeyboard()
        .text(`🌊 Elliott Wave`, `wave_${symbol}_${timeframe}`)
        .text(`📰 Berita`, `news_${symbol}`);
      await ctx.reply(`_Quick actions untuk ${symbol}:_`, {
        parse_mode: 'Markdown',
        reply_markup: kb,
      });

    } catch (err) {
      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      await ctx.reply(`❌ *Error:* ${formatError(err)}`, { parse_mode: 'Markdown' });
    }
  });

  // ─────────────────────────────────────────────
  // /signal [SYMBOL] — Quick signal
  // ─────────────────────────────────────────────
  bot.command('signal', async (ctx) => {
    const symbol = ctx.message?.text?.split(' ')[1]?.toUpperCase() || 'BTC';

    const statusMsg = await ctx.reply(`⚡ Generating signal untuk *${symbol}*...`, { parse_mode: 'Markdown' });

    try {
      const candles = await fetchBinanceKlines(symbol, '1h', 100);
      const analysis = runFullAnalysis(candles, symbol, '1h');
      const { signal, riskManagement, currentPrice, indicators } = analysis;

      const signalEmoji = { BUY: '🟢', SELL: '🔴', NEUTRAL: '🟡' };
      const strengthEmoji = { STRONG: '⚡⚡⚡', MODERATE: '⚡⚡', WEAK: '⚡' };

      // SL/TP selalu dihitung dari ATR agar arahnya benar
      // SL selalu di bawah harga (untuk long/buy bias)
      // TP selalu di atas harga
      const atr = indicators.atr || (currentPrice * 0.01);
      const sl  = parseFloat((currentPrice - atr * 1.5).toFixed(6));
      const tp  = parseFloat((currentPrice + atr * 2.5).toFixed(6));
      const slPct = (((currentPrice - sl) / currentPrice) * 100).toFixed(2);
      const tpPct = (((tp - currentPrice) / currentPrice) * 100).toFixed(2);

      const msg =
        `${signalEmoji[signal.direction]} *SIGNAL — ${symbol}*\n\n` +
        `💰 Harga: *$${formatPrice(currentPrice)}*\n` +
        `📊 Signal: *${signal.direction}* ${strengthEmoji[signal.strength] || ''}\n` +
        `🎯 Confidence: *${signal.bullishPercent}% bullish*\n\n` +
        `*Indikator Kunci:*\n` +
        `• RSI: ${indicators.rsi} ${indicators.rsi < 30 ? '🔴 Oversold' : indicators.rsi > 70 ? '🔴 Overbought' : '⚪'}\n` +
        `• EMA20 ${indicators.ema20 > indicators.ema50 ? '>' : '<'} EMA50 ${indicators.ema20 > indicators.ema50 ? '✅' : '❌'}\n` +
        `• MACD Histogram: ${indicators.macd.histogram > 0 ? '🟢 Positif' : '🔴 Negatif'} (${indicators.macd.histogram})\n\n` +
        `*Risk Management (ATR-based):*\n` +
        `• 🎯 Entry: $${formatPrice(currentPrice)}\n` +
        `• 🔴 Stop Loss: $${formatPrice(sl)} (-${slPct}%)\n` +
        `• 🎯 Take Profit: $${formatPrice(tp)} (+${tpPct}%)\n` +
        `• ⚖️ R:R Ratio: 1:1.67\n\n` +
        `_⚠️ Bukan financial advice. Timeframe: 1H._`;

      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      await ctx.reply(msg, { parse_mode: 'Markdown' });

    } catch (err) {
      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      await ctx.reply(`❌ *Error:* ${formatError(err)}`, { parse_mode: 'Markdown' });
    }
  });

  // ─────────────────────────────────────────────
  // /wave [SYMBOL] [TIMEFRAME] — Elliott Wave
  // ─────────────────────────────────────────────
  bot.command('wave', async (ctx) => {
    const args = ctx.message?.text?.split(' ').slice(1) || [];
    const symbol = args[0]?.toUpperCase() || 'BTC';
    const timeframe = args[1] || '4h';

    const statusMsg = await ctx.reply(`🌊 Menganalisis Elliott Wave *${symbol}*...`, { parse_mode: 'Markdown' });

    try {
      const candles = await fetchBinanceKlines(symbol, timeframe, 200);
      const analysis = runFullAnalysis(candles, symbol, timeframe);

      await editMessage(ctx, statusMsg, `🤖 AI merumuskan wave count...`);

      const waveAnalysis = await analyzeElliottWave(analysis);

      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      await ctx.reply(waveAnalysis, { parse_mode: 'Markdown' });

    } catch (err) {
      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      await ctx.reply(`❌ *Error:* ${formatError(err)}`, { parse_mode: 'Markdown' });
    }
  });

  // ─────────────────────────────────────────────
  // /news [SYMBOL] — News analysis
  // ─────────────────────────────────────────────
  bot.command('news', async (ctx) => {
    const symbol = ctx.message?.text?.split(' ')[1]?.toUpperCase() || 'BTC';

    const statusMsg = await ctx.reply(`📰 Fetching berita *${symbol}*...`, { parse_mode: 'Markdown' });

    try {
      const [newsItems, ticker] = await Promise.all([
        fetchCryptoNews([symbol], 'hot'),
        fetchBinanceTicker(symbol),
      ]);

      if (!newsItems || newsItems.length === 0) {
        await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
        await ctx.reply(`📭 Tidak ada berita terbaru untuk *${symbol}*.\n\nCoba gunakan /news BTC atau /news ETH.`, { parse_mode: 'Markdown' });
        return;
      }

      await editMessage(ctx, statusMsg, `🤖 AI menganalisis dampak berita...`);

      const newsAnalysis = await analyzeNews(symbol, newsItems, ticker);

      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      await ctx.reply(newsAnalysis, { parse_mode: 'Markdown' });

    } catch (err) {
      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      await ctx.reply(`❌ *Error:* ${formatError(err)}\n\n_Pastikan CRYPTOCOMPARE_API_KEY sudah diset di .env (opsional)_`, { parse_mode: 'Markdown' });
    }
  });

  // ─────────────────────────────────────────────
  // /watch [SYMBOLS...] — Add to watchlist
  // ─────────────────────────────────────────────
  bot.command('watch', async (ctx) => {
    const symbols = ctx.message?.text?.split(' ').slice(1) || [];

    if (symbols.length === 0) {
      await ctx.reply(
        `📋 *Cara pakai:*\n/watch BTC ETH SOL\n\nKamu bisa tambah hingga ${process.env.MAX_WATCHLIST_PER_USER || 10} coin.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const { added, skipped } = addToWatchlist(ctx.from.id, symbols);

    let msg = '';
    if (added.length > 0) msg += `✅ *Ditambahkan:* ${added.join(', ')}\n`;
    if (skipped.length > 0) msg += `⚠️ *Dilewati:* ${skipped.join(', ')}\n`;

    const watchlist = getWatchlist(ctx.from.id);
    msg += `\n📋 *Watchlist kamu (${watchlist.length}):* ${watchlist.map(w => w.symbol).join(', ')}`;

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // ─────────────────────────────────────────────
  // /unwatch [SYMBOLS...] — Remove from watchlist
  // ─────────────────────────────────────────────
  bot.command('unwatch', async (ctx) => {
    const symbols = ctx.message?.text?.split(' ').slice(1) || [];

    if (symbols.length === 0) {
      await ctx.reply('Contoh: /unwatch BTC ETH');
      return;
    }

    const { removed, notFound } = removeFromWatchlist(ctx.from.id, symbols);

    let msg = '';
    if (removed.length > 0) msg += `🗑️ *Dihapus:* ${removed.join(', ')}\n`;
    if (notFound.length > 0) msg += `⚠️ *Tidak ditemukan:* ${notFound.join(', ')}\n`;

    await ctx.reply(msg || 'Tidak ada yang diubah.', { parse_mode: 'Markdown' });
  });

  // ─────────────────────────────────────────────
  // /list — Show watchlist
  // ─────────────────────────────────────────────
  bot.command('list', async (ctx) => {
    const watchlist = getWatchlist(ctx.from.id);

    if (watchlist.length === 0) {
      await ctx.reply(
        `📋 *Watchlist kamu kosong.*\n\nTambahkan coin dengan:\n/watch BTC ETH SOL`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const statusMsg = await ctx.reply(`📊 Mengambil data watchlist...`);

    try {
      const priceData = await Promise.allSettled(
        watchlist.map(w => fetchBinanceTicker(w.symbol))
      );

      let msg = `📋 *WATCHLIST KAMU*\n\n`;
      watchlist.forEach((w, i) => {
        const result = priceData[i];
        if (result.status === 'fulfilled') {
          const t = result.value;
          const changeEmoji = t.priceChangePct >= 0 ? '📈' : '📉';
          msg += `${changeEmoji} *${w.symbol}* — $${formatPrice(t.price)} (${t.priceChangePct > 0 ? '+' : ''}${t.priceChangePct}%)\n`;
        } else {
          msg += `⚪ *${w.symbol}* — Gagal fetch data\n`;
        }
      });

      msg += `\n_Terakhir diupdate: ${new Date().toLocaleTimeString('id-ID')}_`;

      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      await ctx.reply(msg, { parse_mode: 'Markdown' });

    } catch (err) {
      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      await ctx.reply(`❌ Error: ${formatError(err)}`, { parse_mode: 'Markdown' });
    }
  });

  // ─────────────────────────────────────────────
  // /scan — Coin discovery
  // ─────────────────────────────────────────────
  bot.command('scan', async (ctx) => {
    const statusMsg = await ctx.reply(
      `🔍 *Menjalankan Coin Discovery Scan...*\n\n` +
      `⏱️ Proses ini 30-90 detik (scan 150 coin)\n` +
      `📡 Fetching data dari CoinGecko + Binance...`,
      { parse_mode: 'Markdown' }
    );

    try {
      const result = await runCoinScan(150);

      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

      if (result.picks.length === 0) {
        await ctx.reply(
          `🔍 *Scan Selesai*\n\n` +
          `Tidak ada coin yang memenuhi kriteria ketat saat ini.\n` +
          `Market mungkin sedang sideways atau low volatility.\n\n` +
          `_Coba lagi dalam 2-4 jam._`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      await ctx.reply(result.aiAnalysis, { parse_mode: 'Markdown' });
      await ctx.reply(
        `_📊 Scan selesai dalam ${(result.duration / 1000).toFixed(1)}s | ${result.scannedCount} coin dianalisis_`,
        { parse_mode: 'Markdown' }
      );

    } catch (err) {
      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      await ctx.reply(`❌ Scan gagal: ${formatError(err)}`, { parse_mode: 'Markdown' });
    }
  });

  // ─────────────────────────────────────────────
  // /macro — Macro market overview
  // ─────────────────────────────────────────────
  bot.command('macro', async (ctx) => {
    const statusMsg = await ctx.reply(`🌍 Mengambil data makro...`, { parse_mode: 'Markdown' });

    try {
      const [fearGreed, btcGlobal, trending, btcTicker, ethTicker] = await Promise.all([
        fetchFearGreedIndex(),
        fetchBTCDominance(),
        fetchTrendingCoins(),
        fetchBinanceTicker('BTC'),
        fetchBinanceTicker('ETH'),
      ]);

      const macroData = {
        fearGreed,
        btcDominance: btcGlobal.btcDominance,
        totalMarketCap: btcGlobal.totalMarketCap,
        totalVolume24h: btcGlobal.totalVolume24h,
        marketCapChangePercent: btcGlobal.marketCapChangePercent,
        btcChange: btcTicker.priceChangePct,
        ethChange: ethTicker.priceChangePct,
        trending,
      };

      await editMessage(ctx, statusMsg, `🤖 AI menganalisis kondisi makro...`);

      const macroAnalysis = await analyzeMacro(macroData);

      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      await ctx.reply(macroAnalysis, { parse_mode: 'Markdown' });

    } catch (err) {
      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      await ctx.reply(`❌ Error: ${formatError(err)}`, { parse_mode: 'Markdown' });
    }
  });

  // ─────────────────────────────────────────────
  // /status — Bot status
  // ─────────────────────────────────────────────
  bot.command('status', async (ctx) => {
    const stats = getStats();
    const uptime = process.uptime();
    const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

    await ctx.reply(
      `🤖 *CRYPTOSENSE BOT STATUS*\n\n` +
      `✅ Status: Online\n` +
      `⏱️ Uptime: ${uptimeStr}\n` +
      `👥 Total Users: ${stats.totalUsers}\n` +
      `📋 Active Watchlists: ${stats.totalWatchlists}\n` +
      `🔍 Total Scans: ${stats.totalScans}\n` +
      `🕒 Last Scan: ${stats.lastScanAt ? new Date(stats.lastScanAt).toLocaleString('id-ID') : 'Belum ada'}\n\n` +
      `*Model AI:* ${process.env.OPENROUTER_MODEL || 'Default'}\n` +
      `*Node.js:* ${process.version}`,
      { parse_mode: 'Markdown' }
    );
  });

  // ─────────────────────────────────────────────
  // Inline keyboard callbacks
  // ─────────────────────────────────────────────
  bot.callbackQuery(/^wave_(.+)_(.+)$/, async (ctx) => {
    const [, symbol, timeframe] = ctx.match;
    await ctx.answerCallbackQuery('Menganalisis Elliott Wave...');

    try {
      const candles = await fetchBinanceKlines(symbol, timeframe, 200);
      const analysis = runFullAnalysis(candles, symbol, timeframe);
      const waveAnalysis = await analyzeElliottWave(analysis);
      await ctx.reply(waveAnalysis, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`❌ Error: ${formatError(err)}`, { parse_mode: 'Markdown' });
    }
  });

  bot.callbackQuery(/^news_(.+)$/, async (ctx) => {
    const [, symbol] = ctx.match;
    await ctx.answerCallbackQuery('Mengambil berita...');

    try {
      const [newsItems, ticker] = await Promise.all([
        fetchCryptoNews([symbol], 'hot'),
        fetchBinanceTicker(symbol),
      ]);

      if (!newsItems.length) {
        await ctx.reply(`📭 Tidak ada berita terbaru untuk ${symbol}.`);
        return;
      }

      const newsAnalysis = await analyzeNews(symbol, newsItems, ticker);
      await ctx.reply(newsAnalysis, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`❌ Error: ${formatError(err)}`, { parse_mode: 'Markdown' });
    }
  });

  // ─────────────────────────────────────────────
  // Free-text handler — natural language + smart routing
  // ─────────────────────────────────────────────
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return;

    // ── Coba detect pola "[COIN] [TIMEFRAME]" ──────
    // contoh: "hype 4h", "fartcoin 1d", "BTC 1h cocok entry?"
    const tfPattern = /\b(1m|3m|5m|15m|30m|1h|2h|4h|6h|8h|12h|1d|1w|daily|weekly)\b/i;
    const tfMatch = text.match(tfPattern);

    if (tfMatch) {
      // Ada timeframe → coba ekstrak simbol coin dari teks
      const beforeTF = text.slice(0, tfMatch.index).trim();
      // Ambil kata terakhir sebelum timeframe sebagai kandidat simbol
      const words = beforeTF.split(/\s+/);
      const candidateSymbol = words[words.length - 1].toUpperCase();

      if (candidateSymbol.length >= 2 && candidateSymbol.length <= 15) {
        // Arahkan ke /analyze pipeline dengan data real
        const timeframe = tfMatch[0].toLowerCase();
        const statusMsg = await ctx.reply(
          `🔍 Menganalisis *${candidateSymbol}* timeframe *${timeframe}*...`,
          { parse_mode: 'Markdown' }
        );
        try {
          const resolvedSymbol = resolveSymbol(candidateSymbol);
          const [candles, ticker] = await Promise.all([
            fetchBinanceKlines(resolvedSymbol, timeframe, 200),
            fetchBinanceTicker(resolvedSymbol),
          ]);
          await editMessage(ctx, statusMsg, `🤖 AI menganalisis data real ${resolvedSymbol}...`);
          const analysis = runFullAnalysis(candles, resolvedSymbol, timeframe);
          const aiResponse = await analyzeSignal(analysis, '');
          await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
          await ctx.reply(aiResponse, { parse_mode: 'Markdown' });
          return;
        } catch (err) {
          await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
          // Kalau symbol tidak valid di Binance, fall through ke freeChat
          if (!err.message.includes('Invalid symbol') && !err.message.includes('400')) {
            await ctx.reply(`❌ Error: ${formatError(err)}`, { parse_mode: 'Markdown' });
            return;
          }
          // Lanjut ke freeChat dengan pesan yang jelas
        }
      }
    }

    // ── Fallback: freeChat dengan konteks harga real ──
    // Coba dapat harga real untuk coin yang disebut
    const knownSymbols = text.toUpperCase().match(/\b([A-Z]{2,10})\b/g) || [];
    let context = '';
    for (const sym of knownSymbols.slice(0, 3)) {
      try {
        const ticker = await fetchBinanceTicker(sym);
        context += `${sym} harga: $${formatPrice(ticker.price)}, 24h: ${ticker.priceChangePct}%\n`;
      } catch (e) { /* coin tidak ada di binance, skip */ }
    }

    if (context) {
      context = `Data market real-time:\n${context}\nGUNAKAN data di atas sebagai referensi harga. JANGAN gunakan harga yang kamu ketahui dari training data.`;
    }

    const typingMsg = await ctx.reply('💭 Sedang berpikir...');
    try {
      const response = await freeChat(text, context);
      await ctx.api.deleteMessage(ctx.chat.id, typingMsg.message_id).catch(() => {});
      await ctx.reply(response, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.api.deleteMessage(ctx.chat.id, typingMsg.message_id).catch(() => {});
      await ctx.reply(`❌ Error: ${formatError(err)}`, { parse_mode: 'Markdown' });
    }
  });

  // ─────────────────────────────────────────────
  // Photo handler — analisis chart dari screenshot
  // ─────────────────────────────────────────────
  bot.on('message:photo', async (ctx) => {
    const caption = ctx.message.caption || '';
    const statusMsg = await ctx.reply(
      '🖼 Screenshot diterima! Menganalisis chart...\n_Ini membutuhkan 15-30 detik..._',
      { parse_mode: 'Markdown' }
    );

    try {
      // Ambil foto resolusi tertinggi
      const photos = ctx.message.photo;
      const bestPhoto = photos[photos.length - 1];
      const fileId = bestPhoto.file_id;

      // Download foto dari Telegram
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const fileRes = await axios.get(
        `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`,
        { timeout: 10000 }
      );
      const filePath = fileRes.data.result.file_path;
      const fileUrl  = `https://api.telegram.org/file/bot${token}/${filePath}`;

      // Download sebagai buffer lalu convert ke base64
      const imgRes = await axios.get(fileUrl, {
        responseType: 'arraybuffer',
        timeout: 20000,
      });
      const base64Image = Buffer.from(imgRes.data).toString('base64');
      const mimeType = filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

      await editMessage(ctx, statusMsg, '🤖 AI sedang membaca chart...');

      const analysis = await analyzeChartImage(base64Image, mimeType, caption);

      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      await ctx.reply(analysis, { parse_mode: 'Markdown' });

    } catch (err) {
      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

      // Vision model mungkin tidak tersedia — kasih pesan yang helpful
      if (err.message.includes('404') || err.message.includes('vision')) {
        await ctx.reply(
          '⚠️ *Model vision tidak tersedia saat ini.*\n\n' +
          'Coba kirim detail chart secara manual:\n' +
          '• Coin & timeframe (contoh: BTC 4h)\n' +
          '• Harga sekarang\n' +
          '• RSI, EMA yang kamu lihat\n\n' +
          'Atau gunakan /analyze BTC 4h untuk analisis otomatis.',
          { parse_mode: 'Markdown' }
        );
      } else {
        await ctx.reply(`❌ Error: ${formatError(err)}`, { parse_mode: 'Markdown' });
      }
    }
  });

  // ─────────────────────────────────────────────
  // Global error handler
  // ─────────────────────────────────────────────
  bot.catch((err) => {
    console.error('[Bot] Unhandled error:', err.message);
  });

  return bot;
}

// ─────────────────────────────────────────────
// Helper: edit loading message
// ─────────────────────────────────────────────
async function editMessage(ctx, msg, text) {
  try {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, text, { parse_mode: 'Markdown' });
  } catch (e) { /* message might be deleted */ }
}

// ─────────────────────────────────────────────
// Helper: format error message
// ─────────────────────────────────────────────
function formatError(err) {
  if (err.message.includes('Invalid symbol')) return 'Symbol tidak valid. Cek nama coin (contoh: BTC, ETH, SOL)';
  if (err.message.includes('Rate limit')) return 'Rate limit tercapai. Coba lagi dalam 1 menit.';
  if (err.message.includes('OPENROUTER')) return 'OpenRouter API error. Cek API key di .env';
  return err.message.slice(0, 100);
}
