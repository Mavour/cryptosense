/**
 * =============================================
 * CRYPTOSENSE BOT — AI Analyzer (OpenRouter)
 * =============================================
 * Menggunakan OpenRouter API dengan model gratis.
 * Membangun prompt terstruktur dari data TA,
 * lalu parse output AI menjadi response Telegram.
 */

import axios from 'axios';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

// ─────────────────────────────────────────────
// Model fallback list — dicoba urut dari atas
// Semua gratis di OpenRouter free tier
// ─────────────────────────────────────────────
const MODEL_FALLBACKS = [
  process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemini-flash-1.5',
  'deepseek/deepseek-chat:free',
  'mistralai/mistral-7b-instruct:free',
];

// ─────────────────────────────────────────────
// Simple queue — cegah concurrent AI calls
// yang menyebabkan rate limit
// ─────────────────────────────────────────────
let _aiQueueRunning = false;
const _aiQueue = [];

function enqueueAI(fn) {
  return new Promise((resolve, reject) => {
    _aiQueue.push({ fn, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (_aiQueueRunning || _aiQueue.length === 0) return;
  _aiQueueRunning = true;
  const { fn, resolve, reject } = _aiQueue.shift();
  try {
    resolve(await fn());
  } catch (e) {
    reject(e);
  } finally {
    _aiQueueRunning = false;
    // Jeda 1.5 detik antar request — cegah burst rate limit
    setTimeout(processQueue, 1500);
  }
}

// ─────────────────────────────────────────────
// Core AI Request — retry + model fallback
// ─────────────────────────────────────────────
async function callAI(messages, maxTokens = 800) {
  return enqueueAI(() => callAIInner(messages, maxTokens));
}

async function callAIInner(messages, maxTokens, modelIndex = 0) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set in .env');

  const model = MODEL_FALLBACKS[modelIndex] || MODEL_FALLBACKS[0];

  try {
    const res = await axios.post(
      `${OPENROUTER_BASE}/chat/completions`,
      {
        model,
        messages,
        max_tokens: maxTokens,
        temperature: 0.3,
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/cryptosense-bot',
          'X-Title': 'CryptoSense Trading Bot',
        },
        timeout: 45000,
      }
    );

    const content = res.data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty response from AI');
    return content;

  } catch (err) {
    const status = err.response?.status;

    // Rate limit (429) — tunggu lalu coba model berikutnya
    if (status === 429) {
      const nextModel = MODEL_FALLBACKS[modelIndex + 1];
      if (nextModel) {
        console.warn(`[AI] Rate limit on ${model}, switching to ${nextModel}...`);
        await new Promise(r => setTimeout(r, 3000));
        return callAIInner(messages, maxTokens, modelIndex + 1);
      }
      // Semua model kena rate limit — tunggu 30 detik lalu retry dari awal
      console.warn('[AI] All models rate limited, waiting 30s...');
      await new Promise(r => setTimeout(r, 30000));
      return callAIInner(messages, maxTokens, 0);
    }

    if (status === 402) throw new Error('Credit habis di OpenRouter. Cek akun kamu.');

    // Error lain — coba model berikutnya
    if (modelIndex < MODEL_FALLBACKS.length - 1) {
      console.warn(`[AI] Error on ${model} (${err.message}), trying next model...`);
      await new Promise(r => setTimeout(r, 1000));
      return callAIInner(messages, maxTokens, modelIndex + 1);
    }

    throw new Error(`AI Error: ${err.message}`);
  }
}

// ─────────────────────────────────────────────
// SYSTEM PROMPT — identitas dan format output
// ─────────────────────────────────────────────
const SYSTEM_PROMPT = `Kamu adalah CryptoSense, AI Trading Analyst expert dalam:
- Technical Analysis: Elliott Wave, Smart Money Concept (SMC), EMA/RSI/MACD
- Identifikasi Order Block, Fair Value Gap (FVG), liquidity zone
- Risk management berbasis ATR
- Analisis makro crypto

ATURAN PENTING:
1. Selalu berikan analisis FAKTUAL berdasarkan data yang diberikan
2. Sebutkan level harga yang SPESIFIK (bukan "sekitar" atau "kira-kira")
3. Format output menggunakan emoji untuk keterbacaan di Telegram
4. Selalu sertakan DISCLAIMER di akhir
5. Gunakan Bahasa Indonesia yang natural tapi profesional
6. Jika sinyal TIDAK JELAS, katakan "WAIT/SIDEWAYS" dengan jujur
7. Jangan pernah guarantee profit — ini adalah analisis probabilitas`;

// ─────────────────────────────────────────────
// PROMPT BUILDER — Signal Analysis
// ─────────────────────────────────────────────
function buildSignalPrompt(analysis, newsContext = '') {
  const { symbol, timeframe, currentPrice, indicators, signal, riskManagement, supportResistance, fibonacci } = analysis;
  const ind = indicators;

  const newsSection = newsContext
    ? `\n📰 KONTEKS BERITA TERKINI:\n${newsContext}\n`
    : '';

  return `Analisis trading untuk ${symbol} timeframe ${timeframe}:

💰 HARGA SAAT INI: $${currentPrice}

📊 INDIKATOR TEKNIKAL:
• RSI (14): ${ind.rsi} ${ind.rsi < 30 ? '🔴 Oversold' : ind.rsi > 70 ? '🔴 Overbought' : ind.rsi < 45 ? '🟡 Lemah' : '🟢 Kuat'}
• EMA 20: $${ind.ema20} | EMA 50: $${ind.ema50}${ind.ema200 ? ` | EMA 200: $${ind.ema200}` : ''}
• MACD Line: ${ind.macd.line} | Signal: ${ind.macd.signal} | Histogram: ${ind.macd.histogram}
• Bollinger Bands: Upper $${ind.bollingerBands.upper} | Mid $${ind.bollingerBands.middle} | Lower $${ind.bollingerBands.lower}
• Stoch RSI: K=${ind.stochRsi.k} D=${ind.stochRsi.d}
• ATR: ${ind.atr}
${ind.volumeSpike ? `• Volume Spike: ${ind.volumeSpike.spikeRatio}x rata-rata (${ind.volumeSpike.direction})` : ''}

📐 SUPPORT & RESISTANCE:
• Resistances: ${supportResistance.resistances.join(' | ') || 'Tidak terdeteksi'}
• Supports: ${supportResistance.supports.join(' | ') || 'Tidak terdeteksi'}

🌀 FIBONACCI (${fibonacci.trend}):
• High: $${fibonacci.high} | Low: $${fibonacci.low}
• 38.2%: $${fibonacci.levels['38.2%']} | 50%: $${fibonacci.levels['50.0%']} | 61.8%: $${fibonacci.levels['61.8%']}

⚡ SINYAL TERDETEKSI: ${signal.direction} (${signal.strength}) — ${signal.bullishPercent}% bullish
• ${signal.details.join('\n• ')}

🛡️ RISK MANAGEMENT (ATR-based):
• Suggested SL: $${riskManagement.suggestedSL}
• Suggested TP: $${riskManagement.suggestedTP}
• R:R Ratio: 1:${riskManagement.riskRewardRatio}
${newsSection}
---
Berikan analisis komprehensif dengan format:

**📊 ANALISIS ${symbol} ${timeframe.toUpperCase()}**

**Kondisi Market:**
[narasi kondisi trend saat ini, apakah bull/bear/sideways, posisi terhadap EMA]

**Sinyal Teknikal:**
[interpretasi RSI, MACD, BB, volume]

**Smart Money View:**
[identifikasi Order Block, FVG, atau liquidity zone yang relevan dari data S/R dan Fibonacci]

**🎯 Rekomendasi Aksi:**
• Action: BUY / SELL / WAIT
• Entry: $[level spesifik]
• Stop Loss: $[level] ([persentase]%)
• Target 1: $[level] ([persentase]%)
• Target 2: $[level] ([persentase]%)
• Confidence: [Tinggi/Sedang/Rendah] — [alasan singkat]

**⚠️ Disclaimer:** Ini bukan financial advice. Selalu lakukan riset sendiri dan manage risiko.`;
}

// ─────────────────────────────────────────────
// PROMPT BUILDER — Elliott Wave Explanation
// ─────────────────────────────────────────────
function buildWavePrompt(analysis) {
  const { symbol, timeframe, currentPrice, supportResistance, fibonacci } = analysis;

  return `Jelaskan struktur Elliott Wave untuk ${symbol} di timeframe ${timeframe}:

Data harga:
• Current Price: $${currentPrice}
• Recent Swing Highs (Resistance): ${supportResistance.resistances.join(', ') || 'N/A'}
• Recent Swing Lows (Support): ${supportResistance.supports.join(', ') || 'N/A'}
• Fibonacci High: $${fibonacci.high}
• Fibonacci Low: $${fibonacci.low}
• Trend: ${fibonacci.trend}
• Key Fib Levels: 
  - 23.6%: $${fibonacci.levels['23.6%']}
  - 38.2%: $${fibonacci.levels['38.2%']}
  - 50.0%: $${fibonacci.levels['50.0%']}
  - 61.8%: $${fibonacci.levels['61.8%']}
  - 78.6%: $${fibonacci.levels['78.6%']}

Berikan penjelasan dengan format:

**🌊 ELLIOTT WAVE ANALYSIS — ${symbol} ${timeframe.toUpperCase()}**

**Identifikasi Wave Saat Ini:**
[Berdasarkan data swing dan harga, tebak/identifikasi kita sedang di wave mana. Jelaskan reasoning-nya berdasarkan level Fibonacci dan posisi harga terhadap swing high/low]

**Skenario Bullish (Impulsive):**
[Jika ini wave koreksi, jelaskan target wave naik berikutnya]

**Skenario Bearish (Corrective):**
[Jika ini wave naik, jelaskan potensi koreksi ke mana]

**Invalidation Level:**
[Level harga yang membatalkan analisis wave ini]

**Catatan:** Elliott Wave bersifat subjektif. Gunakan sebagai guidance, bukan kepastian.`;
}

// ─────────────────────────────────────────────
// SENTIMENT ENRICHER — Analisis sentimen judul berita via AI
// Dipanggil sebelum buildNewsPrompt karena CryptoCompare
// tidak menyediakan skor sentimen (berbeda dari sumber berbayar).
// Menggunakan callAI dengan token minimal (hemat kuota).
// Output: array newsItems dengan field sentiment terisi.
// ─────────────────────────────────────────────
async function enrichNewsWithSentiment(newsItems) {
  if (!newsItems || newsItems.length === 0) return newsItems;

  // Kalau semua sudah punya sentiment (bukan 'pending'), skip AI call
  const needsEnrichment = newsItems.some(n => n.sentiment === 'pending' || !n.sentiment);
  if (!needsEnrichment) return newsItems;

  const titles = newsItems
    .map((n, i) => `${i + 1}. ${n.title}`)
    .join('\n');

  const prompt = `Classify the sentiment of each crypto news headline as "bullish", "bearish", or "neutral".
Reply ONLY with a compact JSON array. No explanation, no markdown, no extra text.
Format: [{"i":1,"s":"bullish"},{"i":2,"s":"neutral"},...]

Headlines:
${titles}`;

  try {
    const raw = await callAI([{ role: 'user', content: prompt }], 250);

    // Strip markdown fences jika AI nekat tambahkan
    const clean = raw.replace(/```json|```/gi, '').trim();
    const parsed = JSON.parse(clean);

    return newsItems.map((item, idx) => {
      const found = parsed.find(s => s.i === idx + 1);
      const sentiment = ['bullish', 'bearish', 'neutral'].includes(found?.s)
        ? found.s
        : 'neutral';
      return { ...item, sentiment };
    });

  } catch (e) {
    // Fallback: semua neutral jika AI gagal parse — tetap tidak crash
    console.warn('[Analyzer] Sentiment enrichment fallback:', e.message);
    return newsItems.map(item => ({ ...item, sentiment: item.sentiment === 'pending' ? 'neutral' : item.sentiment }));
  }
}

// ─────────────────────────────────────────────
// PROMPT BUILDER — News Impact Analysis
// ─────────────────────────────────────────────
function buildNewsPrompt(symbol, newsItems, ticker) {
  // CryptoCompare tidak punya votes — format tanpa kolom 👍👎
  const newsText = newsItems
    .map((n, i) => `${i + 1}. [${n.sentiment.toUpperCase()}] "${n.title}" — ${n.source}`)
    .join('\n');

  return `Analisis dampak berita terhadap ${symbol}:

Harga saat ini: $${ticker.price}
Perubahan 24h: ${ticker.priceChangePct > 0 ? '+' : ''}${ticker.priceChangePct}%
Volume 24h: $${(ticker.quoteVolume24h / 1e6).toFixed(2)}M

BERITA TERKINI:
${newsText}

Berikan analisis dengan format:

**📰 ANALISIS BERITA — ${symbol}**

**Ringkasan Sentimen:**
[Apakah berita secara keseluruhan bullish, bearish, atau mixed]

**Dampak Jangka Pendek (1-24 jam):**
[Prediksi dampak ke harga berdasarkan berita]

**Dampak Jangka Menengah (1-7 hari):**
[Apakah ada catalyst besar yang bisa menggerakkan harga signifikan]

**Berita Paling Signifikan:**
[Highlight 1-2 berita yang paling impactful dan alasannya]

**Rekomendasi:**
[Apakah berita ini mengubah atau mengkonfirmasi analisis teknikal]

⚠️ Disclaimer: Sentimen berita sangat volatile dan bisa berubah cepat.`;
}

// ─────────────────────────────────────────────
// PROMPT BUILDER — Coin Discovery Scoring
// ─────────────────────────────────────────────
function buildDiscoveryPrompt(coinData) {
  const coinList = coinData.map(c =>
    `• ${c.symbol} | Price: $${c.price} | 24h: ${c.change24h}% | Volume spike: ${c.volumeSpike}x | RSI: ${c.rsi} | News: ${c.newsScore}`
  ).join('\n');

  return `Kamu adalah coin screener expert. Dari daftar berikut, pilih 3-5 coin yang paling berpotensi untuk SCALPING SPOT dalam 24-48 jam ke depan:

${coinList}

Kriteria seleksi:
- Volume spike tinggi (>2x) dengan arah bullish
- RSI bounce dari oversold (20-45) atau momentum RSI naik
- Sentimen berita positif
- Tidak sedang dalam downtrend berat (tidak di bawah EMA200 jauh)

Format output:

**🔍 COIN DISCOVERY — TOP PICKS**

Untuk setiap coin yang dipilih:
**[RANK]. [SYMBOL] — [SCORE]/10**
• Alasan: [kenapa coin ini menarik]
• Setup: [kondisi teknikal spesifik]
• Entry Zone: $[range]
• Target: $[level] (+[%])
• Risk: [HIGH/MEDIUM/LOW] — [alasan]

**📊 Summary:** [1-2 kalimat overview market condition]

⚠️ Disclaimer: Rekomendasi berdasarkan data snapshot. Selalu cek chart sendiri sebelum entry.`;
}

// ─────────────────────────────────────────────
// PROMPT BUILDER — Macro Overview
// ─────────────────────────────────────────────
function buildMacroPrompt(macroData) {
  return `Berikan ringkasan kondisi makro crypto berdasarkan data berikut:

Fear & Greed Index: ${macroData.fearGreed.value} (${macroData.fearGreed.label})
BTC Dominance: ${macroData.btcDominance}%
Total Market Cap: $${(macroData.totalMarketCap / 1e12).toFixed(2)}T
Market Cap Change 24h: ${macroData.marketCapChangePercent}%
Total Volume 24h: $${(macroData.totalVolume24h / 1e9).toFixed(2)}B

BTC 24h Change: ${macroData.btcChange}%
ETH 24h Change: ${macroData.ethChange}%

Trending Coins: ${macroData.trending.map(c => c.symbol).join(', ')}

Format output:

**🌍 MACRO OVERVIEW**

**Kondisi Market Saat Ini:**
[Apakah risk-on atau risk-off, bagaimana sentimen keseluruhan]

**BTC Dominance Analysis:**
[Apa arti dominance level ini — apakah altcoin season atau BTC season]

**Fear & Greed Interpretation:**
[Apa artinya untuk trader jangka pendek]

**Strategi Umum:**
[Berdasarkan makro, bagaimana pendekatan trading yang direkomendasikan]

**Coins to Watch:**
[Dari trending coins, mana yang menarik secara teknikal]`;
}

// ─────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────
export async function analyzeSignal(analysis, newsContext = '') {
  const prompt = buildSignalPrompt(analysis, newsContext);
  return await callAI([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ], 900);
}

export async function analyzeElliottWave(analysis) {
  const prompt = buildWavePrompt(analysis);
  return await callAI([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ], 800);
}

export async function analyzeNews(symbol, newsItems, ticker) {
  // Step 1: Enrichment sentimen via AI (karena CryptoCompare tidak punya skor sentimen)
  // Ini 1 AI call kecil (max 250 token) sebelum analisis utama
  const enriched = await enrichNewsWithSentiment(newsItems);

  // Step 2: Analisis dampak berita dengan data yang sudah ada sentimennya
  const prompt = buildNewsPrompt(symbol, enriched, ticker);
  return await callAI([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ], 700);
}

export async function scoreDiscoveredCoins(coinData) {
  const prompt = buildDiscoveryPrompt(coinData);
  return await callAI([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ], 1000);
}

export async function analyzeMacro(macroData) {
  const prompt = buildMacroPrompt(macroData);
  return await callAI([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ], 700);
}

// Free-form chat (untuk pertanyaan ad-hoc)
export async function freeChat(userMessage, context = '') {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];

  if (context) {
    messages.push({ role: 'system', content: `Konteks market saat ini:\n${context}` });
  }

  messages.push({ role: 'user', content: userMessage });

  return await callAI(messages, 600);
}
