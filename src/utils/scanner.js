/**
 * =============================================
 * CRYPTOSENSE BOT — Coin Discovery Scanner (v2)
 * =============================================
 * Dual Mode:
 *  1. SAFE MODE  → mean-reversion (oversold + volume)
 *  2. HYPE MODE  → momentum breakout + trending + volume anomaly
 *
 * Hype Engine prioritaskan:
 *  - CoinGecko trending coins
 *  - Top gainers 1h/24h
 *  - Volume anomaly ekstrem (>3x)
 *  - Breakout dari resistance terdekat
 *  - Social proxy: trending rank + price acceleration
 */

import {
  fetchTopCoins,
  fetchBinanceKlines,
  fetchCryptoNews,
  fetchTrendingCoins,
  fetchTopGainers,
} from '../ta/marketData.js';
import { runFullAnalysis } from '../ta/indicators.js';
import { scoreDiscoveredCoins } from '../ai/analyzer.js';
import { saveScanResult } from './database.js';

// ─────────────────────────────────────────────
// Filter config
// ─────────────────────────────────────────────
const FILTERS = {
  minVolume24h: 2_000_000,          // Min $2M volume (turun biar kecil2 ikut)
  minVolumeSpike: 1.5,              // 1.5x rata-rata = notable
  rsiOversoldMax: 45,               // SAFE MODE: RSI < 45
  rsiOverboughtMin: 55,             // HYPE MODE: RSI > 55 (momentum)
  excludeStablecoins: [
    'USDT','USDC','BUSD','DAI','TUSD','USDP','FRAX','USDE','PYUSD',
    'FDUSD','USDX','BFUSD','RLUSD','USDS','CUSD','CEUR','LUSD','EURC','AUSD',
    'WBTC','WETH','STETH','WEETH','RETH','CBETH','METH',
    'XAUT','PAXG','POLYX',
  ],
  maxCandlesToFetch: 80,
};

// ─────────────────────────────────────────────
// Hype Scoring (0-10) — lebih agresif
// ─────────────────────────────────────────────
function scoreHype(coin, ta, trendingRank, volumeSpike, newsScore) {
  let score = 0;
  const change1h = coin.price_change_percentage_1h_in_currency || 0;
  const change24h = coin.price_change_percentage_24h || 0;
  const rsi = ta?.indicators?.rsi || 50;

  // Trending rank (max 3 pts) — trending di CoinGecko = social hype proxy
  if (trendingRank === 1) score += 3;
  else if (trendingRank === 2) score += 2.5;
  else if (trendingRank === 3) score += 2;
  else if (trendingRank && trendingRank <= 7) score += 1.5;
  else if (trendingRank && trendingRank <= 15) score += 1;

  // Momentum 1h (max 2 pts) — coin hype naik cepat dalam 1 jam
  if (change1h >= 8) score += 2;
  else if (change1h >= 4) score += 1.5;
  else if (change1h >= 2) score += 1;
  else if (change1h >= 1) score += 0.5;

  // Momentum 24h (max 2 pts)
  if (change24h >= 15) score += 2;
  else if (change24h >= 8) score += 1.5;
  else if (change24h >= 4) score += 1;
  else if (change24h >= 2) score += 0.5;

  // Volume anomaly (max 2 pts)
  if (volumeSpike >= 5) score += 2;
  else if (volumeSpike >= 3) score += 1.5;
  else if (volumeSpike >= 2) score += 1;
  else if (volumeSpike >= 1.5) score += 0.5;

  // RSI momentum — hype coin sering overbought tapi masih terbang
  if (rsi >= 60 && rsi <= 75) score += 1;   // strong momentum
  else if (rsi >= 75 && rsi <= 85) score += 0.5; // very hot but risky

  // News sentiment (max 1 pt)
  score += Math.min(newsScore, 1);

  return parseFloat(score.toFixed(1));
}

// ─────────────────────────────────────────────
// Safe Scoring (0-10) — mean reversion
// ─────────────────────────────────────────────
function scoreSafe(coin, ta, volumeSpike, newsScore) {
  let score = 0;
  const rsi = ta?.indicators?.rsi || 50;
  const change1h = coin.price_change_percentage_1h_in_currency || 0;

  // Volume spike (max 3 pts)
  if (volumeSpike >= 3) score += 3;
  else if (volumeSpike >= 2) score += 2;
  else if (volumeSpike >= 1.5) score += 1;

  // RSI position (max 3 pts)
  if (rsi >= 30 && rsi <= 40) score += 3;
  else if (rsi >= 40 && rsi <= 50) score += 2;
  else if (rsi >= 50 && rsi <= 60) score += 1;

  // Price change 1h (max 2 pts) — slight recovery sign
  if (change1h >= 2) score += 2;
  else if (change1h >= 0.5) score += 1;

  // News sentiment (max 2 pts)
  score += Math.min(newsScore, 2);

  return parseFloat(score.toFixed(1));
}

// ─────────────────────────────────────────────
// Breakout Detection — apakah harga break resistance terdekat?
// ─────────────────────────────────────────────
function detectBreakout(ta, candles) {
  if (!ta || !candles || candles.length < 10) return false;
  const currentPrice = ta.currentPrice;
  const resistances = ta.supportResistance?.resistances || [];
  if (resistances.length === 0) return false;

  const nearestResistance = resistances[0];
  const prevCandle = candles[candles.length - 2];
  const prevClose = prevCandle?.close || 0;

  // Breakout = candle sebelumnya di bawah resistance, candle sekarang di atas
  if (prevClose < nearestResistance && currentPrice > nearestResistance) {
    return true;
  }
  // Atau harga saat ini > resistance dalam range 1%
  if (currentPrice > nearestResistance && currentPrice < nearestResistance * 1.02) {
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────
// Main scanner — dual mode
// ─────────────────────────────────────────────
export async function runCoinScan(limit = 250, mode = 'safe') {
  console.log(`[Scanner] Starting ${mode} coin scan...`);
  const scanStart = Date.now();
  const isHype = mode === 'hype';

  // ── Fetch data sources in parallel ───────────
  const [topCoins, trending, gainers] = await Promise.all([
    fetchTopCoins(limit),
    isHype ? fetchTrendingCoins() : Promise.resolve([]),
    isHype ? fetchTopGainers('24h', 100) : Promise.resolve([]),
  ]);

  // Build trending rank map { SYMBOL: rank }
  const trendingMap = {};
  trending.forEach((c, i) => { trendingMap[c.symbol] = i + 1; });

  // Build gainers set for fast lookup
  const gainerSet = new Set(gainers.map(g => g.symbol));

  // ── Fetch news for context ──────────────────
  let allNews = [];
  try {
    allNews = await fetchCryptoNews([], isHype ? 'hot' : 'rising');
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

  // ── Filter coins ────────────────────────────
  let filtered = topCoins.filter(coin => {
    const sym = coin.symbol.toUpperCase();
    if (FILTERS.excludeStablecoins.includes(sym)) return false;
    if ((coin.total_volume || 0) < FILTERS.minVolume24h) return false;
    return true;
  });

  // HYPE MODE: prioritaskan trending + gainers — masukkan ke depan array
  if (isHype) {
    const prioritizedSymbols = new Set([
      ...trending.map(c => c.symbol),
      ...gainers.slice(0, 50).map(g => g.symbol),
    ]);

    const prioritized = filtered.filter(c => prioritizedSymbols.has(c.symbol.toUpperCase()));
    const rest = filtered.filter(c => !prioritizedSymbols.has(c.symbol.toUpperCase()));
    filtered = [...prioritized, ...rest];
    console.log(`[Scanner] Hype mode: ${prioritized.length} prioritized coins`);
  }

  console.log(`[Scanner] ${filtered.length} coins passed initial filter`);

  // ── Scan each coin ───────────────────────────
  const candidates = [];
  const batchSize = 8;
  const scanLimit = isHype ? Math.min(filtered.length, 120) : Math.min(filtered.length, 80);

  for (let i = 0; i < scanLimit; i++) {
    const coin = filtered[i];
    const symbol = coin.symbol.toUpperCase();

    try {
      // Fetch klines + full TA analysis
      const candles = await fetchBinanceKlines(symbol, '1h', FILTERS.maxCandlesToFetch);
      let ta;
      try {
        ta = runFullAnalysis(candles, symbol, '1h');
      } catch (e) {
        continue; // Coin baru atau data kurang
      }

      const rsi = ta.indicators.rsi || 50;
      const volumeSpike = ta.indicators.volumeSpike?.spikeRatio || 1;
      const newsScore = Math.max(0, newsMap[symbol] || 0);
      const trendingRank = trendingMap[symbol] || null;
      const isGainer = gainerSet.has(symbol);
      const isBreakout = detectBreakout(ta, candles);

      // ── Filtering per mode ────────────────────
      let passesFilter = false;
      if (isHype) {
        // Hype mode: lebih longgar — yang penting ada momentum atau trending
        const change1h = coin.price_change_percentage_1h_in_currency || 0;
        const change24h = coin.price_change_percentage_24h || 0;
        const hasMomentum = change1h >= 1.5 || change24h >= 3;
        const hasVolume = volumeSpike >= 1.5;
        const isTrending = !!trendingRank;
        const hasBreakout = isBreakout;

        passesFilter = (hasMomentum && hasVolume) || isTrending || hasBreakout || (isGainer && hasVolume);
      } else {
        // Safe mode: RSI oversold + volume
        const rsiOk = rsi <= FILTERS.rsiOversoldMax;
        const volumeOk = volumeSpike >= FILTERS.minVolumeSpike;
        const change1h = coin.price_change_percentage_1h_in_currency || 0;
        const changeOk = Math.abs(change1h) >= 1.0;
        passesFilter = (rsiOk && volumeOk) || (changeOk && volumeOk);
      }

      if (!passesFilter) continue;

      // ── Scoring ───────────────────────────────
      const score = isHype
        ? scoreHype(coin, ta, trendingRank, volumeSpike, newsScore)
        : scoreSafe(coin, ta, volumeSpike, newsScore);

      if (score < 2.5) continue;

      candidates.push({
        symbol,
        name: coin.name,
        price: coin.current_price,
        change1h: parseFloat((coin.price_change_percentage_1h_in_currency || 0).toFixed(2)),
        change24h: parseFloat((coin.price_change_percentage_24h || 0).toFixed(2)),
        change7d: parseFloat((coin.price_change_percentage_7d_in_currency || 0).toFixed(2)),
        volume24h: coin.total_volume,
        marketCap: coin.market_cap,
        rsi: parseFloat(rsi.toFixed(1)),
        volumeSpike: parseFloat(volumeSpike.toFixed(2)),
        newsScore: parseFloat(newsScore.toFixed(1)),
        score,
        mode,
        trendingRank,
        isBreakout,
        isGainer,
        // TA data
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

      // Rate limit delay per batch
      if (i % batchSize === 0 && i > 0) {
        await new Promise(r => setTimeout(r, 800));
      }
    } catch (e) {
      console.warn(`[Scanner] Skipping ${symbol}: ${e.message}`);
      continue;
    }
  }

  // ── Sort by score ────────────────────────────
  candidates.sort((a, b) => b.score - a.score);
  const topCandidates = candidates.slice(0, 15);

  console.log(`[Scanner] Found ${topCandidates.length} candidates in ${Date.now() - scanStart}ms`);

  if (topCandidates.length === 0) {
    return {
      picks: [],
      aiAnalysis: isHype
        ? 'Tidak ada coin hype/momentum yang terdeteksi saat ini. Market sedang tenang atau volume rendah.'
        : 'Tidak ada coin yang memenuhi kriteria scan saat ini. Market mungkin sedang sideways.',
    };
  }

  // ── AI scoring & narasi ───────────────────────
  let aiAnalysis;
  try {
    aiAnalysis = await scoreDiscoveredCoins(topCandidates, mode);
  } catch (e) {
    console.error('[Scanner] AI analysis failed:', e.message);
    aiAnalysis = formatFallbackScanResult(topCandidates, mode);
  }

  saveScanResult(topCandidates.slice(0, 5).map(c => c.symbol));

  return {
    picks: topCandidates,
    aiAnalysis,
    scannedCount: filtered.length,
    duration: Date.now() - scanStart,
  };
}

// ─────────────────────────────────────────────
// Fallback formatter — dual mode
// ─────────────────────────────────────────────
function fmt(price) {
  if (!price && price !== 0) return 'N/A';
  if (price >= 10000) return price.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (price >= 100)   return price.toFixed(2);
  if (price >= 1)     return price.toFixed(4);
  if (price >= 0.01)  return price.toFixed(5);
  return price.toFixed(6);
}

function formatFallbackScanResult(candidates, mode = 'safe') {
  const top5 = candidates.slice(0, 5);
  const signalEmoji = { BUY: '🟢', SELL: '🔴', NEUTRAL: '🟡' };
  const isHype = mode === 'hype';

  let text = isHype
    ? '🔥 *HYPE SCAN — TOP MOMENTUM PICKS*\n'
    : '🔍 *COIN DISCOVERY — TOP PICKS*\n';
  text += `_${new Date().toLocaleString('id-ID')}_\n\n`;

  top5.forEach((c, i) => {
    const sig = signalEmoji[c.signal] || '🟡';
    const pct24 = `${c.change24h >= 0 ? '+' : ''}${c.change24h}%`;
    const pct1h = `${c.change1h >= 0 ? '+' : ''}${c.change1h}%`;

    text += `*${i + 1}. ${c.symbol}* ${sig} — Score: *${c.score}/10*\n`;
    text += `💰 Harga: $${fmt(c.price)} | 1h: ${pct1h} | 24h: ${pct24}\n`;
    text += `📊 RSI: ${c.rsi} | Vol: ${c.volumeSpike}x rata-rata\n`;

    if (c.trendingRank) text += `🔥 Trending #${c.trendingRank} di CoinGecko\n`;
    if (c.isBreakout) text += `🚀 Breakout detected!\n`;

    if (c.sl && c.tp) {
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

  text += '_⚠️ Bukan financial advice. Selalu cek chart sebelum entry._';
  return text;
}
