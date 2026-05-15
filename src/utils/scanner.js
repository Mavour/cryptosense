/**
 * =============================================
 * CRYPTOSENSE BOT — Coin Discovery Scanner (v3)
 * =============================================
 * 3 Mode:
 *  1. SAFE MODE  → mean-reversion (oversold + volume)
 *  2. HYPE MODE  → momentum breakout + trending
 *  3. EARLY MODE → pre-pump accumulation detection
 *
 * Early Engine:
 *  - Deteksi volume spike + price flat (hidden accumulation)
 *  - Bollinger Bands squeeze (volatility compression)
 *  - Funding rate negatif (short squeeze setup)
 *  - Event calendar upcoming catalyst
 *  - Multi-timeframe alignment (4H trend + 1H consolidation)
 */

import {
  fetchTopCoins,
  fetchBinanceKlines,
  fetchCryptoNews,
  fetchTrendingCoins,
  fetchTopGainers,
  fetchFundingRate,
  fetchBinanceDepth,
  scrapeCoinMarketCal,
  fetchCexSmartMoneyAccumulation,
} from '../ta/marketData.js';
import { runFullAnalysis, detectBBSqueeze } from '../ta/indicators.js';
import { scoreDiscoveredCoins } from '../ai/analyzer.js';
import { saveScanResult } from './database.js';

// ─────────────────────────────────────────────
// Filter config
// ─────────────────────────────────────────────
const FILTERS = {
  minVolume24h: 2_000_000,
  excludeStablecoins: [
    'USDT','USDC','BUSD','DAI','TUSD','USDP','FRAX','USDE','PYUSD',
    'FDUSD','USDX','BFUSD','RLUSD','USDS','CUSD','CEUR','LUSD','EURC','AUSD',
    'WBTC','WETH','STETH','WEETH','RETH','CBETH','METH',
    'XAUT','PAXG','POLYX',
  ],
  maxCandlesToFetch: 80,
};

// ─────────────────────────────────────────────
// Early Mode: Strict Pre-Pump Filters
// ─────────────────────────────────────────────
const EARLY_FILTERS = {
  maxChange24h: 8,      // Sudah naik >8% = late
  maxChange1h: 3,       // Sudah gerak >3% = late
  minVolumeSpike: 2.5,  // Smart money mulai masuk
  minVolume24h: 1_000_000,
};

// ─────────────────────────────────────────────
// Scoring: Early (0-10) — "diam-diam ramai"
// ─────────────────────────────────────────────
function scoreEarly(coin, ta, volumeSpike, bbSqueeze, fundingData, eventData, depthData, smartMoneyData) {
  let score = 0;
  const change1h = coin.price_change_percentage_1h_in_currency || 0;
  const change24h = coin.price_change_percentage_24h || 0;
  const rsi = ta?.indicators?.rsi || 50;

  // 1. Volume spike + price flat (max 3 pts) — hidden accumulation
  if (volumeSpike >= 3.0 && Math.abs(change1h) < 2.0) score += 3;
  else if (volumeSpike >= 2.5 && Math.abs(change1h) < 2.0) score += 2.5;
  else if (volumeSpike >= 2.0 && Math.abs(change1h) < 3.0) score += 1.5;

  // 2. BB Squeeze (max 2 pts) — spring loaded
  if (bbSqueeze?.isSqueeze && bbSqueeze.bandwidth < 3.0) score += 2;
  else if (bbSqueeze?.isSqueeze) score += 1.5;
  else if (bbSqueeze?.bandwidth < 5.0) score += 0.5;

  // 3. RSI 45-58 + volume expansion (max 1.5 pts)
  if (rsi >= 45 && rsi <= 58 && volumeSpike >= 2.0) score += 1.5;
  else if (rsi >= 40 && rsi <= 60 && volumeSpike >= 2.0) score += 1;

  // 4. 4H EMA20 > EMA50 (max 1.5 pts) — higher TF healthy
  if (ta?.indicators?.ema20 > ta?.indicators?.ema50) score += 1.5;

  // 5. Funding negatif + flat (max 1 pt) — short squeeze potential
  if (fundingData && fundingData.fundingRate < 0) score += 1;

  // 6. Event dalam 7 hari (max 1 pt)
  if (eventData?.hasEvent) score += 1;

  // 7. Order book bid heavy (max 0.5 pt)
  if (depthData && depthData.bidAskRatio > 1.5) score += 0.5;

  // 8. CEX smart money accumulation (max 3 pts)
  if (smartMoneyData?.trend === 'ACCUMULATION') score += Math.min(3, 1 + (smartMoneyData.score * 0.3));
  else if (smartMoneyData?.trend === 'DISTRIBUTION') score -= 3;

  return parseFloat(score.toFixed(1));
}

// ─────────────────────────────────────────────
// Scoring: Hype (0-10)
// ─────────────────────────────────────────────
function scoreHype(coin, ta, trendingRank, volumeSpike, newsScore) {
  let score = 0;
  const change1h = coin.price_change_percentage_1h_in_currency || 0;
  const change24h = coin.price_change_percentage_24h || 0;
  const rsi = ta?.indicators?.rsi || 50;

  if (trendingRank === 1) score += 3;
  else if (trendingRank === 2) score += 2.5;
  else if (trendingRank === 3) score += 2;
  else if (trendingRank && trendingRank <= 7) score += 1.5;
  else if (trendingRank && trendingRank <= 15) score += 1;

  if (change1h >= 8) score += 2;
  else if (change1h >= 4) score += 1.5;
  else if (change1h >= 2) score += 1;
  else if (change1h >= 1) score += 0.5;

  if (change24h >= 15) score += 2;
  else if (change24h >= 8) score += 1.5;
  else if (change24h >= 4) score += 1;
  else if (change24h >= 2) score += 0.5;

  if (volumeSpike >= 5) score += 2;
  else if (volumeSpike >= 3) score += 1.5;
  else if (volumeSpike >= 2) score += 1;
  else if (volumeSpike >= 1.5) score += 0.5;

  if (rsi >= 60 && rsi <= 75) score += 1;
  else if (rsi >= 75 && rsi <= 85) score += 0.5;

  score += Math.min(newsScore, 1);

  return parseFloat(score.toFixed(1));
}

// ─────────────────────────────────────────────
// Scoring: Safe (0-10)
// ─────────────────────────────────────────────
function scoreSafe(coin, ta, volumeSpike, newsScore) {
  let score = 0;
  const rsi = ta?.indicators?.rsi || 50;
  const change1h = coin.price_change_percentage_1h_in_currency || 0;

  if (volumeSpike >= 3) score += 3;
  else if (volumeSpike >= 2) score += 2;
  else if (volumeSpike >= 1.5) score += 1;

  if (rsi >= 30 && rsi <= 40) score += 3;
  else if (rsi >= 40 && rsi <= 50) score += 2;
  else if (rsi >= 50 && rsi <= 60) score += 1;

  if (change1h >= 2) score += 2;
  else if (change1h >= 0.5) score += 1;

  score += Math.min(newsScore, 2);

  return parseFloat(score.toFixed(1));
}

// ─────────────────────────────────────────────
// Breakout Detection
// ─────────────────────────────────────────────
function detectBreakout(ta, candles) {
  if (!ta || !candles || candles.length < 10) return false;
  const currentPrice = ta.currentPrice;
  const resistances = ta.supportResistance?.resistances || [];
  if (resistances.length === 0) return false;

  const nearestResistance = resistances[0];
  const prevCandle = candles[candles.length - 2];
  const prevClose = prevCandle?.close || 0;

  if (prevClose < nearestResistance && currentPrice > nearestResistance) return true;
  if (currentPrice > nearestResistance && currentPrice < nearestResistance * 1.02) return true;
  return false;
}

// ─────────────────────────────────────────────
// Main scanner — 3 mode
// ─────────────────────────────────────────────
export async function runCoinScan(limit = 250, mode = 'safe') {
  console.log(`[Scanner] Starting ${mode} coin scan...`);
  const scanStart = Date.now();
  const isHype = mode === 'hype';
  const isEarly = mode === 'early';
  const requireSmartMoneyAccumulation = process.env.STRICT_SMART_MONEY_ACCUMULATION !== 'false';

  // ── Fetch data sources ──────────────────────
  const [topCoins, trending, gainers] = await Promise.all([
    fetchTopCoins(limit),
    isHype ? fetchTrendingCoins() : Promise.resolve([]),
    isHype ? fetchTopGainers('24h', 100) : Promise.resolve([]),
  ]);

  const trendingMap = {};
  trending.forEach((c, i) => { trendingMap[c.symbol] = i + 1; });
  const gainerSet = new Set(gainers.map(g => g.symbol));

  // ── Fetch news ──────────────────────────────
  let allNews = [];
  try {
    allNews = await fetchCryptoNews([], isHype ? 'hot' : 'rising');
  } catch (e) {
    console.warn('[Scanner] Could not fetch news:', e.message);
  }

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
    const vol = coin.total_volume || 0;
    if (isEarly && vol < EARLY_FILTERS.minVolume24h) return false;
    if (!isEarly && vol < FILTERS.minVolume24h) return false;
    return true;
  });

  // EARLY MODE: filter strict — coin yang belum naik banyak
  if (isEarly) {
    filtered = filtered.filter(coin => {
      const change24h = Math.abs(coin.price_change_percentage_24h || 0);
      const change1h = Math.abs(coin.price_change_percentage_1h_in_currency || 0);
      return change24h < EARLY_FILTERS.maxChange24h && change1h < EARLY_FILTERS.maxChange1h;
    });
    console.log(`[Scanner] Early mode: ${filtered.length} coins after strict filter`);
  }

  // HYPE MODE: prioritaskan trending + gainers
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
  const scanLimit = isHype ? Math.min(filtered.length, 120)
    : isEarly ? Math.min(filtered.length, 100)
    : Math.min(filtered.length, 80);

  for (let i = 0; i < scanLimit; i++) {
    const coin = filtered[i];
    const symbol = coin.symbol.toUpperCase();

    try {
      // Fetch klines + full TA
      const candles = await fetchBinanceKlines(symbol, '1h', FILTERS.maxCandlesToFetch);
      let ta;
      try {
        ta = runFullAnalysis(candles, symbol, '1h');
      } catch (e) { continue; }

      const rsi = ta.indicators.rsi || 50;
      const volumeSpike = ta.indicators.volumeSpike?.spikeRatio || 1;
      const newsScore = Math.max(0, newsMap[symbol] || 0);

      // ── Early mode extra data ────────────────
      let bbSqueeze = null;
      let fundingData = null;
      let eventData = null;
      let depthData = null;
      let smartMoneyData = null;

      if (isEarly) {
        bbSqueeze = detectBBSqueeze(candles, 20, 10, 4.0);
      }

      // ── Filtering per mode ───────────────────
      let passesFilter = false;
      if (isHype) {
        const change1h = coin.price_change_percentage_1h_in_currency || 0;
        const change24h = coin.price_change_percentage_24h || 0;
        const hasMomentum = change1h >= 1.5 || change24h >= 3;
        const hasVolume = volumeSpike >= 1.5;
        const isTrending = !!trendingMap[symbol];
        passesFilter = (hasMomentum && hasVolume) || isTrending || detectBreakout(ta, candles) || (gainerSet.has(symbol) && hasVolume);
      } else if (isEarly) {
        const change1h = Math.abs(coin.price_change_percentage_1h_in_currency || 0);
        const change24h = Math.abs(coin.price_change_percentage_24h || 0);
        const hasVolume = volumeSpike >= EARLY_FILTERS.minVolumeSpike;
        const isFlat = change1h < 2.0 && change24h < EARLY_FILTERS.maxChange24h;
        const hasAccumulation = hasVolume && (isFlat || bbSqueeze?.isSqueeze);
        passesFilter = hasAccumulation;
      } else {
        const rsiOk = rsi <= 45;
        const volumeOk = volumeSpike >= 1.5;
        const change1h = coin.price_change_percentage_1h_in_currency || 0;
        passesFilter = (rsiOk && volumeOk) || (Math.abs(change1h) >= 1.0 && volumeOk);
      }

      if (!passesFilter) continue;

      // ── Scoring ──────────────────────────────
      let score = 0;
      if (isHype) {
        score = scoreHype(coin, ta, trendingMap[symbol] || null, volumeSpike, newsScore);
      } else if (isEarly) {
        score = scoreEarly(coin, ta, volumeSpike, bbSqueeze, fundingData, eventData, depthData, smartMoneyData);
      } else {
        score = scoreSafe(coin, ta, volumeSpike, newsScore);
      }

      const minScore = isEarly ? 7.0 : 2.5;
      if (score < minScore) continue;

      const candidate = {
        symbol,
        name: coin.name,
        coinId: coin.id,
        coin,
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
      };

      if (isEarly) {
        candidate.bbBandwidth = bbSqueeze?.bandwidth || null;
        candidate.bbSqueeze = bbSqueeze?.isSqueeze || false;
        candidate.fundingRate = fundingData?.fundingRate || null;
        candidate.hasEvent = eventData?.hasEvent || false;
        candidate.eventTitle = eventData?.events?.[0]?.title || null;
        candidate.bidAskRatio = depthData?.bidAskRatio || null;
        candidate.smartMoneyTrend = null;
        candidate.smartMoneyScore = null;
        candidate.smartMoneyBuyRatio = null;
        candidate.smartMoneyBuyDelta = null;
        candidate.smartMoneyVolumeRatio = null;
        candidate.smartMoneyAbsorption = null;
        candidate.smartMoneyReason = null;
      }

      if (isHype) {
        candidate.trendingRank = trendingMap[symbol] || null;
        candidate.isBreakout = detectBreakout(ta, candles);
        candidate.isGainer = gainerSet.has(symbol);
      }

      candidates.push(candidate);

      if (i % batchSize === 0 && i > 0) {
        await new Promise(r => setTimeout(r, 800));
      }
    } catch (e) {
      console.warn(`[Scanner] Skipping ${symbol}: ${e.message}`);
      continue;
    }
  }

  // ── Early mode: enrichment untuk top 20 ──────
  if (isEarly && candidates.length > 0) {
    console.log(`[Scanner] Early mode: enriching top ${Math.min(candidates.length, 20)} candidates...`);
    const topForEnrich = candidates.slice(0, 20);

    for (let i = 0; i < topForEnrich.length; i++) {
      const c = topForEnrich[i];
      try {
        const smartMoney = await fetchCexSmartMoneyAccumulation(c.symbol, '1h');

        c.smartMoneyTrend = smartMoney.trend;
        c.smartMoneyScore = smartMoney.score;
        c.smartMoneyBuyRatio = smartMoney.buyRatio ?? null;
        c.smartMoneyBuyDelta = smartMoney.buyRatioDelta ?? null;
        c.smartMoneyVolumeRatio = smartMoney.volumeRatio ?? null;
        c.smartMoneyAbsorption = smartMoney.absorption ?? false;
        c.smartMoneyReason = smartMoney.reason;

        if (smartMoney.trend === 'ACCUMULATION') c.score += Math.min(3, 1 + (smartMoney.score * 0.3));
        else if (smartMoney.trend === 'DISTRIBUTION') c.score -= 3;
        else if (smartMoney.trend === 'ERROR') c.score -= 1;
      } catch (e) { /* skip */ }

      try {
        // Funding rate (optional)
        const funding = await fetchFundingRate(c.symbol);
        if (funding) {
          c.fundingRate = funding.fundingRate;
          if (funding.fundingRate < 0) c.score += 1;
        }
      } catch (e) { /* skip */ }

      try {
        // Event calendar (optional)
        const events = await scrapeCoinMarketCal(c.symbol);
        if (events?.hasEvent) {
          c.hasEvent = true;
          c.eventTitle = events.events[0]?.title || null;
          c.score += 1;
        }
      } catch (e) { /* skip */ }

      try {
        // Depth (optional, hanya top 10)
        if (i < 10) {
          const depth = await fetchBinanceDepth(c.symbol, 50);
          if (depth) {
            c.bidAskRatio = depth.bidAskRatio;
            if (depth.bidAskRatio > 1.5) c.score += 0.5;
          }
        }
      } catch (e) { /* skip */ }

      await new Promise(r => setTimeout(r, 300));
    }

    // Re-sort setelah enrichment
    candidates.sort((a, b) => b.score - a.score);

    if (requireSmartMoneyAccumulation) {
      for (let i = candidates.length - 1; i >= 0; i--) {
        if (candidates[i].smartMoneyTrend !== 'ACCUMULATION') {
          candidates.splice(i, 1);
        }
      }
      console.log(`[Scanner] Early mode: ${candidates.length} candidates after CEX smart money accumulation gate`);
    } else {
      for (let i = candidates.length - 1; i >= 0; i--) {
        if (candidates[i].smartMoneyTrend === 'DISTRIBUTION') {
          candidates.splice(i, 1);
        }
      }
    }
  }

  // ── Sort & limit ─────────────────────────────
  candidates.sort((a, b) => b.score - a.score);
  const topCandidates = candidates.slice(0, 15);
  const maxPicks = 5;
  const finalPicks = topCandidates.slice(0, maxPicks);

  console.log(`[Scanner] Found ${finalPicks.length} candidates in ${Date.now() - scanStart}ms`);

  if (finalPicks.length === 0) {
    const msgMap = {
      safe: 'Tidak ada coin yang memenuhi kriteria scan saat ini. Market mungkin sedang sideways.',
      hype: 'Tidak ada coin hype/momentum yang terdeteksi saat ini. Market sedang tenang atau volume rendah.',
      early: 'Tidak ada jejak akumulasi smart money CEX yang terkonfirmasi saat ini. Bot sekarang menunggu taker-buy pressure, absorption, dan bid depth yang sehat sebelum memberi kandidat.',
    };
    return { picks: [], aiAnalysis: msgMap[mode] || msgMap.safe };
  }

  // ── AI scoring & narasi ───────────────────────
  let aiAnalysis;
  try {
    aiAnalysis = await scoreDiscoveredCoins(finalPicks, mode);
  } catch (e) {
    console.error('[Scanner] AI analysis failed:', e.message);
    aiAnalysis = formatFallbackScanResult(finalPicks, mode);
  }

  saveScanResult(finalPicks.map(c => c.symbol));

  return {
    picks: finalPicks,
    aiAnalysis,
    scannedCount: filtered.length,
    duration: Date.now() - scanStart,
  };
}

// ─────────────────────────────────────────────
// Fallback formatter — 3 mode
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

  let text = '';
  if (mode === 'early') text = '🕵️ *CEX SMART MONEY — EARLY ACCUMULATION*\n';
  else if (mode === 'hype') text = '🔥 *HYPE SCAN — TOP MOMENTUM PICKS*\n';
  else text = '🔍 *COIN DISCOVERY — TOP PICKS*\n';

  text += `_${new Date().toLocaleString('id-ID')}_\n\n`;

  top5.forEach((c, i) => {
    const sig = signalEmoji[c.signal] || '🟡';
    const pct24 = `${c.change24h >= 0 ? '+' : ''}${c.change24h}%`;
    const pct1h = `${c.change1h >= 0 ? '+' : ''}${c.change1h}%`;

    text += `*${i + 1}. ${c.symbol}* ${sig} — Score: *${c.score}/10*\n`;
    text += `💰 Harga: $${fmt(c.price)} | 1h: ${pct1h} | 24h: ${pct24}\n`;
    text += `📊 RSI: ${c.rsi} | Vol: ${c.volumeSpike}x rata-rata\n`;

    if (mode === 'early') {
      if (c.smartMoneyTrend) {
        text += `🐋 CEX Smart Money: ${c.smartMoneyTrend} | Buy: ${c.smartMoneyBuyRatio ?? 'N/A'}% | Vol: ${c.smartMoneyVolumeRatio ?? 'N/A'}x\n`;
      }
      if (c.bbSqueeze) text += `🌀 BB Squeeze detected!\n`;
      if (c.fundingRate !== null && c.fundingRate < 0) text += `📉 Funding negatif: ${(c.fundingRate * 100).toFixed(4)}%\n`;
      if (c.hasEvent) text += `📅 Event: ${c.eventTitle}\n`;
      if (c.bidAskRatio) text += `⚖️ Bid/Ask: ${c.bidAskRatio}\n`;
    }

    if (mode === 'hype') {
      if (c.trendingRank) text += `🔥 Trending #${c.trendingRank} di CoinGecko\n`;
      if (c.isBreakout) text += `🚀 Breakout detected!\n`;
    }

    if (c.sl && c.tp) {
      const entryLow = c.support ? fmt(Math.min(c.price * 0.998, c.support * 1.003)) : fmt(c.price * 0.995);
      const entryHigh = fmt(c.price);
      const slPct = (((c.price - c.sl) / c.price) * 100).toFixed(1);
      const tpPct = (((c.tp - c.price) / c.price) * 100).toFixed(1);
      text += `🎯 Entry Zone: $${entryLow} – $${entryHigh}\n`;
      text += `🔴 SL: $${fmt(c.sl)} (-${slPct}%) | 🎯 TP: $${fmt(c.tp)} (+${tpPct}%)\n`;
      text += `⚖️ R:R = 1:${c.rr}\n`;
    }
    if (c.resistance) text += `🧱 Next Resistance: $${fmt(c.resistance)}\n`;
    text += '\n';
  });

  if (mode === 'early') {
    text += '_⚠️ DETEKSI DINI — Bukan sinyal masuk langsung. Bisa flat 1-3 hari. Gunakan limit order._';
  } else {
    text += '_⚠️ Bukan financial advice. Selalu cek chart sebelum entry._';
  }
  return text;
}
