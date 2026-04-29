/**
 * =============================================
 * CRYPTOSENSE BOT — Coin Discovery Scanner
 * =============================================
 * Scan top-200 coin, filter berdasarkan:
 * - Volume spike
 * - RSI momentum
 * - Price change anomaly
 * - News sentiment
 * Hasilnya di-score lalu dikirim ke AI untuk narasi
 */

import { fetchTopCoins, fetchBinanceKlines, fetchCryptoNews } from '../ta/marketData.js';
import { calculateRSI, detectVolumeSpike, runFullAnalysis } from '../ta/indicators.js';
import { scoreDiscoveredCoins } from '../ai/analyzer.js';
import { saveScanResult } from './database.js';

// ─────────────────────────────────────────────
// Filter config
// ─────────────────────────────────────────────
const FILTERS = {
  minVolume24h: 5_000_000,          // Min $5M volume
  minVolumeSpike: 1.5,              // 1.5x rata-rata = notable
  rsiOversoldMax: 45,               // RSI < 45 = potential reversal
  rsiOverboughtMin: 55,             // RSI > 55 = momentum
  minPriceChange1h: 1.5,            // Min 1.5% naik dalam 1 jam
  excludeStablecoins: ['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'USDP', 'FRAX'],
  excludeCoins: ['WBTC', 'WETH', 'STETH'],
  maxCandlesToFetch: 50,
};

// ─────────────────────────────────────────────
// Score a single coin (0-10)
// ─────────────────────────────────────────────
function scoreCoin(coin, rsi, volumeSpike, newsScore) {
  let score = 0;

  // Volume spike (max 3 pts)
  if (volumeSpike >= 3) score += 3;
  else if (volumeSpike >= 2) score += 2;
  else if (volumeSpike >= 1.5) score += 1;

  // RSI position (max 3 pts)
  if (rsi >= 30 && rsi <= 40) score += 3;       // Oversold + recovering
  else if (rsi >= 40 && rsi <= 50) score += 2;  // Below midline, potential
  else if (rsi >= 50 && rsi <= 60) score += 1;  // Bullish momentum

  // Price change 1h (max 2 pts)
  const change1h = coin.price_change_percentage_1h_in_currency || 0;
  if (change1h >= 3) score += 2;
  else if (change1h >= 1.5) score += 1;

  // News sentiment (max 2 pts)
  score += Math.min(newsScore, 2);

  return parseFloat(score.toFixed(1));
}

// ─────────────────────────────────────────────
// Main scanner function
// ─────────────────────────────────────────────
export async function runCoinScan(limit = 150) {
  console.log('[Scanner] Starting coin scan...');
  const scanStart = Date.now();

  // ── Fetch top coins ──────────────────────────
  const topCoins = await fetchTopCoins(limit);

  // ── Fetch trending news for context ─────────
  let allNews = [];
  try {
    allNews = await fetchCryptoNews([], 'rising');
  } catch (e) {
    console.warn('[Scanner] Could not fetch news:', e.message);
  }

  // Build news score map { SYMBOL: score }
  const newsMap = {};
  allNews.forEach(article => {
    article.currencies.forEach(sym => {
      if (!newsMap[sym]) newsMap[sym] = 0;
      newsMap[sym] += article.sentiment === 'bullish' ? 1 : article.sentiment === 'bearish' ? -0.5 : 0;
    });
  });

  // ── Filter coins ─────────────────────────────
  const filtered = topCoins.filter(coin => {
    const sym = coin.symbol.toUpperCase();
    if (FILTERS.excludeStablecoins.includes(sym)) return false;
    if (FILTERS.excludeCoins.includes(sym)) return false;
    if ((coin.total_volume || 0) < FILTERS.minVolume24h) return false;
    return true;
  });

  console.log(`[Scanner] ${filtered.length} coins passed initial filter`);

  // ── Scan each coin ───────────────────────────
  const candidates = [];
  const batchSize = 10; // Process in batches to avoid rate limit

  for (let i = 0; i < Math.min(filtered.length, 60); i++) {
    const coin = filtered[i];
    const symbol = coin.symbol.toUpperCase();

    try {
      // Fetch klines + full TA analysis (dapat RSI, SL/TP, volume spike sekaligus)
      const candles = await fetchBinanceKlines(symbol, '1h', FILTERS.maxCandlesToFetch);
      let ta;
      try {
        ta = runFullAnalysis(candles, symbol, '1h');
      } catch (e) {
        // Candles kurang (coin baru) — skip
        continue;
      }

      const rsi = ta.indicators.rsi || 50;
      const volumeSpike = ta.indicators.volumeSpike?.spikeRatio || 1;
      const newsScore = Math.max(0, newsMap[symbol] || 0);

      // Apply RSI filter
      const rsiOk = rsi <= FILTERS.rsiOversoldMax || (rsi >= FILTERS.rsiOversoldMax && rsi <= 60);
      const volumeOk = volumeSpike >= FILTERS.minVolumeSpike;
      const change1h = coin.price_change_percentage_1h_in_currency || 0;
      const changeOk = Math.abs(change1h) >= 1.0;

      if (!rsiOk && !volumeOk && !changeOk) continue;

      const score = scoreCoin(coin, rsi, volumeSpike, newsScore);
      if (score < 3) continue;

      candidates.push({
        symbol,
        name: coin.name,
        price: coin.current_price,
        change1h: parseFloat((change1h || 0).toFixed(2)),
        change24h: parseFloat((coin.price_change_percentage_24h || 0).toFixed(2)),
        change7d: parseFloat((coin.price_change_percentage_7d_in_currency || 0).toFixed(2)),
        volume24h: coin.total_volume,
        marketCap: coin.market_cap,
        rsi: parseFloat(rsi.toFixed(1)),
        volumeSpike: parseFloat(volumeSpike.toFixed(2)),
        newsScore: parseFloat(newsScore.toFixed(1)),
        score,
        // Data TA lengkap untuk entry/exit
        // Scanner selalu cari peluang LONG — SL di bawah harga, TP di atas
        signal: ta.signal.direction,
        atr: ta.indicators.atr,
        sl: parseFloat((ta.currentPrice - ta.indicators.atr * 1.5).toFixed(6)),
        tp: parseFloat((ta.currentPrice + ta.indicators.atr * 2.5).toFixed(6)),
        rr: 1.67,
        support: ta.supportResistance.supports[0] || null,
        resistance: ta.supportResistance.resistances[0] || null,
        ema20: ta.indicators.ema20,
        ema50: ta.indicators.ema50,
      });

      // Small delay to respect rate limits
      if (i % batchSize === 0 && i > 0) {
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e) {
      // Skip coins yang gagal fetch (mungkin tidak ada di Binance)
      console.warn(`[Scanner] Skipping ${symbol}: ${e.message}`);
      continue;
    }
  }

  // ── Sort by score ────────────────────────────
  candidates.sort((a, b) => b.score - a.score);
  const topCandidates = candidates.slice(0, 15);

  console.log(`[Scanner] Found ${topCandidates.length} candidates in ${Date.now() - scanStart}ms`);

  if (topCandidates.length === 0) {
    return { picks: [], aiAnalysis: 'Tidak ada coin yang memenuhi kriteria scan saat ini. Market mungkin sedang sideways.' };
  }

  // ── AI scoring & narasi ───────────────────────
  let aiAnalysis;
  try {
    aiAnalysis = await scoreDiscoveredCoins(topCandidates);
  } catch (e) {
    console.error('[Scanner] AI analysis failed:', e.message);
    console.error('[Scanner] Using fallback formatter (check OPENROUTER_API_KEY in .env)');
    aiAnalysis = formatFallbackScanResult(topCandidates);
  }

  // Save to DB
  saveScanResult(topCandidates.slice(0, 5).map(c => c.symbol));

  return {
    picks: topCandidates,
    aiAnalysis,
    scannedCount: filtered.length,
    duration: Date.now() - scanStart,
  };
}

// ─────────────────────────────────────────────
// Fallback formatter jika AI gagal
// ─────────────────────────────────────────────
// Format harga sesuai magnitude — hindari terlalu banyak atau sedikit desimal
function fmt(price) {
  if (!price && price !== 0) return 'N/A';
  if (price >= 10000) return price.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (price >= 100)   return price.toFixed(2);
  if (price >= 1)     return price.toFixed(4);
  if (price >= 0.01)  return price.toFixed(5);
  return price.toFixed(6);
}

function formatFallbackScanResult(candidates) {
  const top5 = candidates.slice(0, 5);
  const signalEmoji = { BUY: '🟢', SELL: '🔴', NEUTRAL: '🟡' };
  let text = '🔍 *COIN DISCOVERY — TOP PICKS*\n';
  text += `_${new Date().toLocaleString('id-ID')}_\n\n`;

  top5.forEach((c, i) => {
    const sig = signalEmoji[c.signal] || '🟡';
    const pct = `${c.change24h >= 0 ? '+' : ''}${c.change24h}%`;

    text += `*${i + 1}. ${c.symbol}* ${sig} — Score: *${c.score}/10*\n`;
    text += `💰 Harga: $${fmt(c.price)} | 24h: ${pct}\n`;
    text += `📊 RSI: ${c.rsi} | Vol: ${c.volumeSpike}x rata-rata\n`;

    if (c.sl && c.tp) {
      // Entry zone: support terdekat → harga sekarang
      const entryLow  = c.support ? fmt(Math.min(c.price * 0.998, c.support * 1.003)) : fmt(c.price * 0.995);
      const entryHigh = fmt(c.price);
      const slPct  = (((c.price - c.sl) / c.price) * 100).toFixed(1);
      const tpPct  = (((c.tp - c.price) / c.price) * 100).toFixed(1);
      text += `🎯 Entry Zone: $${entryLow} – $${entryHigh}\n`;
      text += `🔴 SL: $${fmt(c.sl)} (-${slPct}%) | 🎯 TP: $${fmt(c.tp)} (+${tpPct}%)\n`;
      text += `⚖️ R:R = 1:${c.rr}\n`;
    }
    if (c.resistance) text += `🧱 Next Resistance: $${fmt(c.resistance)}\n`;
    text += '\n';
  });

  text += '_⚠️ Bukan financial advice. SL/TP berbasis ATR 1H. Selalu cek chart sebelum entry._';
  return text;
}
