/**
 * =============================================
 * TEST SCRIPT — TA Engine
 * Usage: node src/ta/test.js
 * =============================================
 * Test semua fungsi indikator + fetch data Binance
 */

import 'dotenv/config';
import { fetchBinanceKlines, fetchBinanceTicker, formatPrice } from './marketData.js';
import { runFullAnalysis } from './indicators.js';

// ─────────────────────────────────────────────
// Test config
// ─────────────────────────────────────────────
const TEST_SYMBOL = process.argv[2] || 'BTC';
const TEST_TIMEFRAME = process.argv[3] || '4h';

console.log(`\n${'═'.repeat(50)}`);
console.log(`  CryptoSense TA Engine Test`);
console.log(`  Symbol: ${TEST_SYMBOL} | Timeframe: ${TEST_TIMEFRAME}`);
console.log(`${'═'.repeat(50)}\n`);

async function runTest() {
  try {
    // ── Step 1: Fetch market data ──────────────
    console.log('📡 Fetching Binance data...');
    const [candles, ticker] = await Promise.all([
      fetchBinanceKlines(TEST_SYMBOL, TEST_TIMEFRAME, 200),
      fetchBinanceTicker(TEST_SYMBOL),
    ]);

    console.log(`✅ Got ${candles.length} candles`);
    console.log(`   Latest candle: ${new Date(candles[candles.length - 1].time).toUTCString()}`);
    console.log(`   Current price: $${formatPrice(ticker.price)}`);
    console.log(`   24h change: ${ticker.priceChangePct > 0 ? '+' : ''}${ticker.priceChangePct}%`);
    console.log(`   24h volume: $${(ticker.quoteVolume24h / 1e6).toFixed(2)}M\n`);

    // ── Step 2: Run analysis ───────────────────
    console.log('🔢 Running full TA analysis...');
    const analysis = runFullAnalysis(candles, TEST_SYMBOL, TEST_TIMEFRAME);

    // ── Step 3: Display results ────────────────
    console.log('\n' + '─'.repeat(50));
    console.log('📊 INDICATORS');
    console.log('─'.repeat(50));
    console.log(`RSI (14):          ${analysis.indicators.rsi}`);
    console.log(`EMA 20:            $${formatPrice(analysis.indicators.ema20)}`);
    console.log(`EMA 50:            $${formatPrice(analysis.indicators.ema50)}`);
    if (analysis.indicators.ema200) {
      console.log(`EMA 200:           $${formatPrice(analysis.indicators.ema200)}`);
    }
    console.log(`MACD Line:         ${analysis.indicators.macd.line}`);
    console.log(`MACD Signal:       ${analysis.indicators.macd.signal}`);
    console.log(`MACD Histogram:    ${analysis.indicators.macd.histogram}`);
    console.log(`BB Upper:          $${formatPrice(analysis.indicators.bollingerBands.upper)}`);
    console.log(`BB Middle:         $${formatPrice(analysis.indicators.bollingerBands.middle)}`);
    console.log(`BB Lower:          $${formatPrice(analysis.indicators.bollingerBands.lower)}`);
    console.log(`ATR:               ${analysis.indicators.atr}`);
    console.log(`Stoch RSI K:       ${analysis.indicators.stochRsi.k}`);
    console.log(`Stoch RSI D:       ${analysis.indicators.stochRsi.d}`);

    if (analysis.indicators.volumeSpike) {
      const vs = analysis.indicators.volumeSpike;
      console.log(`Volume Spike:      ${vs.spikeRatio}x (${vs.direction}) ${vs.isSpike ? '⚡ SPIKE!' : ''}`);
    }

    console.log('\n' + '─'.repeat(50));
    console.log('🎯 SUPPORT & RESISTANCE');
    console.log('─'.repeat(50));
    console.log(`Resistances:       ${analysis.supportResistance.resistances.map(p => `$${formatPrice(p)}`).join(' | ') || 'N/A'}`);
    console.log(`Supports:          ${analysis.supportResistance.supports.map(p => `$${formatPrice(p)}`).join(' | ') || 'N/A'}`);

    console.log('\n' + '─'.repeat(50));
    console.log('🌀 FIBONACCI');
    console.log('─'.repeat(50));
    console.log(`Trend:             ${analysis.fibonacci.trend}`);
    console.log(`High:              $${formatPrice(analysis.fibonacci.high)}`);
    console.log(`Low:               $${formatPrice(analysis.fibonacci.low)}`);
    Object.entries(analysis.fibonacci.levels).forEach(([level, price]) => {
      const marker = price <= analysis.currentPrice ? '  ←' : '';
      console.log(`${level.padEnd(8)}           $${formatPrice(price)}${marker}`);
    });

    console.log('\n' + '─'.repeat(50));
    console.log('⚡ SIGNAL');
    console.log('─'.repeat(50));
    const signalEmoji = { BUY: '🟢', SELL: '🔴', NEUTRAL: '🟡' };
    console.log(`Direction:         ${signalEmoji[analysis.signal.direction]} ${analysis.signal.direction}`);
    console.log(`Strength:          ${analysis.signal.strength}`);
    console.log(`Bullish Score:     ${analysis.signal.bullishScore}`);
    console.log(`Bearish Score:     ${analysis.signal.bearishScore}`);
    console.log(`Bullish %:         ${analysis.signal.bullishPercent}%`);
    console.log('\nSignal Details:');
    analysis.signal.details.forEach(d => console.log(`  • ${d}`));

    console.log('\n' + '─'.repeat(50));
    console.log('🛡️  RISK MANAGEMENT');
    console.log('─'.repeat(50));
    console.log(`Suggested SL:      $${formatPrice(analysis.riskManagement.suggestedSL)}`);
    console.log(`Suggested TP:      $${formatPrice(analysis.riskManagement.suggestedTP)}`);
    console.log(`R:R Ratio:         1:${analysis.riskManagement.riskRewardRatio}`);

    console.log('\n✅ Test PASSED!\n');

  } catch (err) {
    console.error('\n❌ Test FAILED:', err.message);
    if (err.response?.data) {
      console.error('API Response:', JSON.stringify(err.response.data, null, 2));
    }
    process.exit(1);
  }
}

runTest();
