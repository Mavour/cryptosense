/**
 * =============================================
 * CRYPTOSENSE BOT — TA Indicators Engine
 * =============================================
 * Pure functions, zero dependencies.
 * Input: array of candle objects { open, high, low, close, volume, time }
 * Output: calculated indicator values
 */

// ─────────────────────────────────────────────
// EMA — Exponential Moving Average
// ─────────────────────────────────────────────
export function calculateEMA(closes, period) {
  if (closes.length < period) return [];

  const k = 2 / (period + 1);
  const result = [];

  // Seed: SMA of first `period` candles
  let seed = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(seed);

  for (let i = period; i < closes.length; i++) {
    seed = closes[i] * k + seed * (1 - k);
    result.push(seed);
  }

  return result;
}

// ─────────────────────────────────────────────
// SMA — Simple Moving Average
// ─────────────────────────────────────────────
export function calculateSMA(closes, period) {
  if (closes.length < period) return [];
  const result = [];
  for (let i = period - 1; i < closes.length; i++) {
    const sum = closes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
    result.push(sum / period);
  }
  return result;
}

// ─────────────────────────────────────────────
// RSI — Relative Strength Index (Wilder's smoothing)
// ─────────────────────────────────────────────
export function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return [];

  const deltas = [];
  for (let i = 1; i < closes.length; i++) {
    deltas.push(closes[i] - closes[i - 1]);
  }

  let avgGain = 0;
  let avgLoss = 0;

  // First average
  for (let i = 0; i < period; i++) {
    if (deltas[i] > 0) avgGain += deltas[i];
    else avgLoss += Math.abs(deltas[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  const result = [];
  const rs = avgGain / (avgLoss || 0.0001);
  result.push(100 - 100 / (1 + rs));

  // Wilder's smoothing
  for (let i = period; i < deltas.length; i++) {
    const gain = deltas[i] > 0 ? deltas[i] : 0;
    const loss = deltas[i] < 0 ? Math.abs(deltas[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs2 = avgGain / (avgLoss || 0.0001);
    result.push(100 - 100 / (1 + rs2));
  }

  return result;
}

// ─────────────────────────────────────────────
// MACD — Moving Average Convergence Divergence
// Returns: { macd[], signal[], histogram[] }
// ─────────────────────────────────────────────
export function calculateMACD(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const emaFast = calculateEMA(closes, fastPeriod);
  const emaSlow = calculateEMA(closes, slowPeriod);

  // Align: emaSlow starts later, trim emaFast to match
  const offset = slowPeriod - fastPeriod;
  const macdLine = emaSlow.map((slow, i) => emaFast[i + offset] - slow);

  const signalLine = calculateEMA(macdLine, signalPeriod);
  const histOffset = signalPeriod - 1;
  const histogram = signalLine.map((sig, i) => macdLine[i + histOffset] - sig);

  return { macd: macdLine, signal: signalLine, histogram };
}

// ─────────────────────────────────────────────
// Bollinger Bands
// Returns: { upper[], middle[], lower[], bandwidth[] }
// ─────────────────────────────────────────────
export function calculateBollingerBands(closes, period = 20, multiplier = 2) {
  if (closes.length < period) return { upper: [], middle: [], lower: [], bandwidth: [] };

  const middle = calculateSMA(closes, period);
  const upper = [];
  const lower = [];
  const bandwidth = [];

  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const avg = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / period;
    const stdDev = Math.sqrt(variance);
    const idx = i - (period - 1);
    upper.push(middle[idx] + multiplier * stdDev);
    lower.push(middle[idx] - multiplier * stdDev);
    bandwidth.push(((upper[idx] - lower[idx]) / middle[idx]) * 100);
  }

  return { upper, middle, lower, bandwidth };
}

// ─────────────────────────────────────────────
// Volume Spike Detection
// Returns: { avgVolume, currentVolume, spikeRatio, isSpike, direction }
// ─────────────────────────────────────────────
export function detectVolumeSpike(candles, lookback = 20, threshold = 2.0) {
  if (candles.length < lookback + 1) return null;

  const volumes = candles.map(c => parseFloat(c.volume));
  const recentVolumes = volumes.slice(-lookback - 1, -1); // Exclude last candle
  const currentVol = volumes[volumes.length - 1];
  const lastCandle = candles[candles.length - 1];

  const avgVol = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
  const spikeRatio = currentVol / avgVol;

  return {
    avgVolume: avgVol,
    currentVolume: currentVol,
    spikeRatio: parseFloat(spikeRatio.toFixed(2)),
    isSpike: spikeRatio >= threshold,
    direction: parseFloat(lastCandle.close) >= parseFloat(lastCandle.open) ? 'bullish' : 'bearish',
  };
}

// ─────────────────────────────────────────────
// Swing High / Low Detection (untuk Elliott Wave & S/R)
// Returns: { swingHighs[], swingLows[] }
// ─────────────────────────────────────────────
export function detectSwings(candles, strength = 5) {
  const highs = candles.map(c => parseFloat(c.high));
  const lows = candles.map(c => parseFloat(c.low));
  const times = candles.map(c => c.time);

  const swingHighs = [];
  const swingLows = [];

  for (let i = strength; i < candles.length - strength; i++) {
    const windowHighs = highs.slice(i - strength, i + strength + 1);
    const windowLows = lows.slice(i - strength, i + strength + 1);

    if (highs[i] === Math.max(...windowHighs)) {
      swingHighs.push({ price: highs[i], time: times[i], index: i });
    }
    if (lows[i] === Math.min(...windowLows)) {
      swingLows.push({ price: lows[i], time: times[i], index: i });
    }
  }

  return { swingHighs, swingLows };
}

// ─────────────────────────────────────────────
// Support & Resistance Levels
// Returns: { supports[], resistances[] } — top 3 levels each
// ─────────────────────────────────────────────
export function calculateSupportResistance(candles, strength = 5) {
  const { swingHighs, swingLows } = detectSwings(candles, strength);
  const currentPrice = parseFloat(candles[candles.length - 1].close);

  // Get levels below price → supports
  const supports = swingLows
    .map(s => s.price)
    .filter(p => p < currentPrice)
    .sort((a, b) => b - a)  // Closest first
    .slice(0, 3);

  // Get levels above price → resistances
  const resistances = swingHighs
    .map(s => s.price)
    .filter(p => p > currentPrice)
    .sort((a, b) => a - b)  // Closest first
    .slice(0, 3);

  return { supports, resistances };
}

// ─────────────────────────────────────────────
// Fibonacci Retracement Levels
// Returns: { levels: { '23.6%': price, ... }, trend }
// ─────────────────────────────────────────────
export function calculateFibonacci(candles, lookback = 50) {
  const slice = candles.slice(-lookback);
  const highs = slice.map(c => parseFloat(c.high));
  const lows = slice.map(c => parseFloat(c.low));

  const high = Math.max(...highs);
  const low = Math.min(...lows);
  const diff = high - low;

  const ratios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

  // Determine trend direction
  const firstClose = parseFloat(slice[0].close);
  const lastClose = parseFloat(slice[slice.length - 1].close);
  const trend = lastClose > firstClose ? 'uptrend' : 'downtrend';

  const levels = {};
  ratios.forEach(r => {
    const label = `${(r * 100).toFixed(1)}%`;
    levels[label] = trend === 'uptrend'
      ? parseFloat((high - diff * r).toFixed(6))
      : parseFloat((low + diff * r).toFixed(6));
  });

  return { levels, high, low, trend };
}

// ─────────────────────────────────────────────
// ATR — Average True Range (volatility measure)
// ─────────────────────────────────────────────
export function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return [];

  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const high = parseFloat(candles[i].high);
    const low = parseFloat(candles[i].low);
    const prevClose = parseFloat(candles[i - 1].close);
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trueRanges.push(tr);
  }

  // Wilder's smoothing for ATR
  const result = [];
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(atr);

  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
    result.push(atr);
  }

  return result;
}

// ─────────────────────────────────────────────
// Stochastic RSI
// Returns: { k[], d[] }
// ─────────────────────────────────────────────
export function calculateStochRSI(closes, rsiPeriod = 14, stochPeriod = 14, smoothK = 3, smoothD = 3) {
  const rsiValues = calculateRSI(closes, rsiPeriod);
  if (rsiValues.length < stochPeriod) return { k: [], d: [] };

  const rawK = [];
  for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
    const slice = rsiValues.slice(i - stochPeriod + 1, i + 1);
    const maxRSI = Math.max(...slice);
    const minRSI = Math.min(...slice);
    const diff = maxRSI - minRSI;
    rawK.push(diff === 0 ? 0 : ((rsiValues[i] - minRSI) / diff) * 100);
  }

  const k = calculateSMA(rawK, smoothK);
  const d = calculateSMA(k, smoothD);

  return { k, d };
}

// ─────────────────────────────────────────────
// MASTER ANALYZER — Composite signal dari semua indikator
// Returns: structured analysis object
// ─────────────────────────────────────────────
export function runFullAnalysis(candles, symbol = 'UNKNOWN', timeframe = '1h') {
  if (!candles || candles.length < 50) {
    throw new Error(`Insufficient candles: need 50+, got ${candles?.length ?? 0}`);
  }

  const closes = candles.map(c => parseFloat(c.close));
  const currentPrice = closes[closes.length - 1];

  // ── Indikator ──────────────────────────────
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const ema200 = closes.length >= 200 ? calculateEMA(closes, 200) : null;
  const rsiValues = calculateRSI(closes, 14);
  const macdData = calculateMACD(closes);
  const bbData = calculateBollingerBands(closes, 20);
  const atrValues = calculateATR(candles, 14);
  const stochRsi = calculateStochRSI(closes);
  const volumeSpike = detectVolumeSpike(candles);
  const srLevels = calculateSupportResistance(candles);
  const fibLevels = calculateFibonacci(candles);

  // ── Ambil nilai terbaru ──────────────────────
  const rsi = rsiValues[rsiValues.length - 1];
  const ema20Last = ema20[ema20.length - 1];
  const ema50Last = ema50[ema50.length - 1];
  const ema200Last = ema200 ? ema200[ema200.length - 1] : null;
  const macdLast = macdData.macd[macdData.macd.length - 1];
  const macdSignalLast = macdData.signal[macdData.signal.length - 1];
  const macdHistLast = macdData.histogram[macdData.histogram.length - 1];
  const bbUpper = bbData.upper[bbData.upper.length - 1];
  const bbMiddle = bbData.middle[bbData.middle.length - 1];
  const bbLower = bbData.lower[bbData.lower.length - 1];
  const atr = atrValues[atrValues.length - 1];
  const stochK = stochRsi.k[stochRsi.k.length - 1];
  const stochD = stochRsi.d[stochRsi.d.length - 1];

  // ── Sinyal scoring ─────────────────────────
  let bullishSignals = 0;
  let bearishSignals = 0;
  const signalDetails = [];

  // RSI
  if (rsi < 35) { bullishSignals += 2; signalDetails.push('RSI oversold (<35)'); }
  else if (rsi > 65) { bearishSignals += 2; signalDetails.push('RSI overbought (>65)'); }
  else if (rsi < 50) { bullishSignals += 1; signalDetails.push('RSI below 50'); }
  else { bearishSignals += 1; signalDetails.push('RSI above 50'); }

  // EMA Cross
  if (ema20Last > ema50Last) { bullishSignals += 2; signalDetails.push('EMA20 > EMA50 (golden cross)'); }
  else { bearishSignals += 2; signalDetails.push('EMA20 < EMA50 (death cross)'); }

  // Price vs EMA200
  if (ema200Last) {
    if (currentPrice > ema200Last) { bullishSignals += 2; signalDetails.push('Price above EMA200 (bull trend)'); }
    else { bearishSignals += 2; signalDetails.push('Price below EMA200 (bear trend)'); }
  }

  // MACD
  if (macdLast > macdSignalLast && macdHistLast > 0) {
    bullishSignals += 2; signalDetails.push('MACD bullish crossover');
  } else if (macdLast < macdSignalLast && macdHistLast < 0) {
    bearishSignals += 2; signalDetails.push('MACD bearish crossover');
  }

  // Bollinger Bands
  if (currentPrice <= bbLower) { bullishSignals += 1; signalDetails.push('Price at lower BB (potential bounce)'); }
  else if (currentPrice >= bbUpper) { bearishSignals += 1; signalDetails.push('Price at upper BB (potential reversal)'); }

  // Stoch RSI
  if (stochK !== undefined && stochD !== undefined) {
    if (stochK < 20 && stochK > stochD) { bullishSignals += 1; signalDetails.push('StochRSI oversold + K crossing D'); }
    if (stochK > 80 && stochK < stochD) { bearishSignals += 1; signalDetails.push('StochRSI overbought + K crossing D'); }
  }

  // Volume spike confirmation
  if (volumeSpike?.isSpike) {
    if (volumeSpike.direction === 'bullish') { bullishSignals += 1; signalDetails.push(`Volume spike ${volumeSpike.spikeRatio}x (bullish)`); }
    else { bearishSignals += 1; signalDetails.push(`Volume spike ${volumeSpike.spikeRatio}x (bearish)`); }
  }

  // ── Overall signal ─────────────────────────
  const totalSignals = bullishSignals + bearishSignals;
  const bullishPct = totalSignals > 0 ? (bullishSignals / totalSignals) * 100 : 50;

  let signal = 'NEUTRAL';
  let signalStrength = 'WEAK';

  if (bullishPct >= 70) { signal = 'BUY'; }
  else if (bullishPct <= 30) { signal = 'SELL'; }

  if (Math.abs(bullishPct - 50) >= 25) signalStrength = 'STRONG';
  else if (Math.abs(bullishPct - 50) >= 15) signalStrength = 'MODERATE';

  // ── SL/TP suggestion berbasis ATR ───────────
  const atrMultiplierSL = 1.5;
  const atrMultiplierTP = 2.5;
  const suggestedSL = signal === 'BUY'
    ? parseFloat((currentPrice - atr * atrMultiplierSL).toFixed(6))
    : parseFloat((currentPrice + atr * atrMultiplierSL).toFixed(6));
  const suggestedTP = signal === 'BUY'
    ? parseFloat((currentPrice + atr * atrMultiplierTP).toFixed(6))
    : parseFloat((currentPrice - atr * atrMultiplierTP).toFixed(6));
  const riskRewardRatio = parseFloat((atrMultiplierTP / atrMultiplierSL).toFixed(2));

  return {
    symbol,
    timeframe,
    timestamp: new Date().toISOString(),
    currentPrice: parseFloat(currentPrice.toFixed(6)),

    indicators: {
      rsi: parseFloat(rsi?.toFixed(2)),
      ema20: parseFloat(ema20Last?.toFixed(6)),
      ema50: parseFloat(ema50Last?.toFixed(6)),
      ema200: ema200Last ? parseFloat(ema200Last.toFixed(6)) : null,
      macd: {
        line: parseFloat(macdLast?.toFixed(6)),
        signal: parseFloat(macdSignalLast?.toFixed(6)),
        histogram: parseFloat(macdHistLast?.toFixed(6)),
      },
      bollingerBands: {
        upper: parseFloat(bbUpper?.toFixed(6)),
        middle: parseFloat(bbMiddle?.toFixed(6)),
        lower: parseFloat(bbLower?.toFixed(6)),
      },
      atr: parseFloat(atr?.toFixed(6)),
      stochRsi: {
        k: parseFloat(stochK?.toFixed(2)),
        d: parseFloat(stochD?.toFixed(2)),
      },
      volumeSpike,
    },

    supportResistance: srLevels,
    fibonacci: fibLevels,

    signal: {
      direction: signal,
      strength: signalStrength,
      bullishScore: bullishSignals,
      bearishScore: bearishSignals,
      bullishPercent: parseFloat(bullishPct.toFixed(1)),
      details: signalDetails,
    },

    riskManagement: {
      suggestedSL,
      suggestedTP,
      riskRewardRatio,
      atrBased: true,
    },
  };
}
