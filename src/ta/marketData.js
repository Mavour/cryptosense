/**
 * =============================================
 * CRYPTOSENSE BOT — Market Data Fetcher
 * =============================================
 * Sources:
 *  - Binance Public API (OHLCV klines, no key needed)
 *  - CoinGecko API (price, market cap, trending)
 *  - CryptoCompare News API (free tier, optional key)
 *    → Sentimen berita dianalisis oleh AI (bukan vote-based)
 * Includes: in-memory caching + retry logic
 */

import axios from 'axios';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// ─────────────────────────────────────────────
// Simple in-memory cache
// ─────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = (parseInt(process.env.CACHE_TTL_MINUTES) || 5) * 60 * 1000;
const DATA_DIR = join(process.cwd(), 'data');
const WHALE_SNAPSHOT_FILE = join(DATA_DIR, 'whale-snapshots.json');
const SOLANA_NATIVE_MINT = 'So11111111111111111111111111111111111111112';

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}

function hasFreshCache(key) {
  const entry = cache.get(key);
  if (!entry) return false;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return false; }
  return true;
}

function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

// ─────────────────────────────────────────────
// Retry wrapper
// ─────────────────────────────────────────────
async function fetchWithRetry(fn, retries = 3, delayMs = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === retries;
      const status = err.response?.status;
      console.error(`[MarketData] Attempt ${attempt} failed: ${err.message}`);

      // Don't retry on 400 (bad request) — symbol probably wrong
      if (status === 400 || isLast) throw err;

      // Backoff: 1s, 2s, 4s
      await new Promise(r => setTimeout(r, delayMs * attempt));
    }
  }
}

// ─────────────────────────────────────────────
// BINANCE — Normalize symbol
// e.g. BTC → BTCUSDT, ETH/USDT → ETHUSDT
// ─────────────────────────────────────────────
function normalizeBinanceSymbol(input) {
  let sym = input.toUpperCase().replace('/', '').replace('-', '');
  // Cek apakah sudah berupa trading pair lengkap (misal ETHBTC, SOLUSDT)
  // Bukan hanya base currency tunggal (BTC, ETH, SOL)
  const hasQuoteCurrency =
    sym.endsWith('USDT') ||
    sym.endsWith('BUSD') ||
    (sym.endsWith('BTC') && sym.length > 3) ||  // ETHBTC bukan BTC
    (sym.endsWith('ETH') && sym.length > 3);    // BTCETH bukan ETH
  if (!hasQuoteCurrency) sym += 'USDT';
  return sym;
}

// ─────────────────────────────────────────────
// BINANCE — Timeframe mapping
// ─────────────────────────────────────────────
const VALID_TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w'];

function normalizeTimeframe(input) {
  const map = {
    '1': '1h', '4': '4h', 'daily': '1d', 'day': '1d',
    'd': '1d', 'w': '1w', 'week': '1w', 'weekly': '1w',
    '15': '15m', '30': '30m', '5': '5m',
  };
  const normalized = input.toLowerCase().replace(/\s/g, '');
  return map[normalized] || (VALID_TIMEFRAMES.includes(normalized) ? normalized : '1h');
}

// ─────────────────────────────────────────────
// BINANCE — Endpoint list (fallback jika satu diblok)
// api.binance.com sering diblok di Indonesia — coba alternatif dulu
// ─────────────────────────────────────────────
const BINANCE_ENDPOINTS = [
  'https://data-api.binance.vision',   // Public data API, paling stabil
  'https://api.binance.me',             // Mirror alternatif
  'https://api.binance.us',             // US mirror (bisa work dari beberapa region)
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com',
  'https://api.binance.com',
];

async function binanceGet(path, params) {
  let lastError;
  for (const base of BINANCE_ENDPOINTS) {
    try {
      const res = await axios.get(`${base}${path}`, { params, timeout: 8000 });
      return res.data;
    } catch (err) {
      lastError = err;
      // Hanya log jika bukan timeout biasa (terlalu noisy)
      if (!err.message.includes('timeout')) {
        console.warn(`[MarketData] ${base} failed (${err.message}) — trying next...`);
      }
    }
  }
  throw lastError;
}

// ─────────────────────────────────────────────
// BINANCE — Fetch OHLCV Klines
// Returns array of candle objects
// ─────────────────────────────────────────────
export async function fetchBinanceKlines(symbol, timeframe = '1h', limit = 200) {
  const binanceSymbol = normalizeBinanceSymbol(symbol);
  const binanceTF = normalizeTimeframe(timeframe);
  const cacheKey = `klines:${binanceSymbol}:${binanceTF}:${limit}`;

  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`[MarketData] Cache hit: ${cacheKey}`);
    return cached;
  }

  const data = await binanceGet('/api/v3/klines', {
    symbol: binanceSymbol,
    interval: binanceTF,
    limit,
  });

  // Binance kline format:
  // [openTime, open, high, low, close, volume, closeTime, quoteVol, trades, takerBuyBase, takerBuyQuote, ignore]
  const candles = data.map(k => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
    quoteVolume: parseFloat(k[7]),
    trades: k[8],
  }));

  setCache(cacheKey, candles);
  return candles;
}

// ─────────────────────────────────────────────
// BINANCE — Ticker 24h stats (harga + volume + change)
// ─────────────────────────────────────────────
export async function fetchBinanceTicker(symbol) {
  const binanceSymbol = normalizeBinanceSymbol(symbol);
  const cacheKey = `ticker:${binanceSymbol}`;

  const cached = getCached(cacheKey);
  if (cached) return cached;

  const data = await binanceGet('/api/v3/ticker/24hr', { symbol: binanceSymbol });

  const result = {
    symbol: data.symbol,
    price: parseFloat(data.lastPrice),
    priceChange: parseFloat(data.priceChange),
    priceChangePct: parseFloat(data.priceChangePercent),
    volume24h: parseFloat(data.volume),
    quoteVolume24h: parseFloat(data.quoteVolume),
    high24h: parseFloat(data.highPrice),
    low24h: parseFloat(data.lowPrice),
    trades: data.count,
  };

  setCache(cacheKey, result);
  return result;
}

// ─────────────────────────────────────────────
// COINGECKO — Top coins by market cap
// Used for coin discovery scan
// ─────────────────────────────────────────────
export async function fetchTopCoins(limit = 200) {
  const cacheKey = `top-coins:${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const headers = {};
  if (process.env.COINGECKO_API_KEY) {
    headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;
  }

  const data = await fetchWithRetry(async () => {
    const res = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
      params: {
        vs_currency: 'usd',
        order: 'market_cap_desc',
        per_page: limit,
        page: 1,
        sparkline: false,
        price_change_percentage: '1h,24h,7d',
      },
      headers,
      timeout: 15000,
    });
    return res.data;
  });

  setCache(cacheKey, data);
  return data;
}

// ─────────────────────────────────────────────
// COINGECKO — Fear & Greed Index proxy
// (menggunakan alternative.me API gratis)
// ─────────────────────────────────────────────
export async function fetchFearGreedIndex() {
  const cacheKey = 'fear-greed';
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const data = await fetchWithRetry(async () => {
    const res = await axios.get('https://api.alternative.me/fng/', {
      params: { limit: 1 },
      timeout: 8000,
    });
    return res.data;
  });

  const result = {
    value: parseInt(data.data[0].value),
    label: data.data[0].value_classification,
    timestamp: data.data[0].timestamp,
  };

  setCache(cacheKey, result);
  return result;
}

// ─────────────────────────────────────────────
// COINGECKO — BTC Dominance
// ─────────────────────────────────────────────
export async function fetchBTCDominance() {
  const cacheKey = 'btc-dominance';
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const data = await fetchWithRetry(async () => {
    const res = await axios.get('https://api.coingecko.com/api/v3/global', {
      timeout: 8000,
    });
    return res.data;
  });

  const result = {
    btcDominance: parseFloat(data.data.market_cap_percentage.btc.toFixed(2)),
    totalMarketCap: data.data.total_market_cap.usd,
    totalVolume24h: data.data.total_volume.usd,
    marketCapChangePercent: parseFloat(data.data.market_cap_change_percentage_24h_usd.toFixed(2)),
  };

  setCache(cacheKey, result);
  return result;
}

// ─────────────────────────────────────────────
// COINGECKO — Trending coins (hot right now)
// ─────────────────────────────────────────────
export async function fetchTrendingCoins() {
  const cacheKey = 'trending';
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const data = await fetchWithRetry(async () => {
    const res = await axios.get('https://api.coingecko.com/api/v3/search/trending', {
      timeout: 8000,
    });
    return res.data;
  });

  const result = data.coins.slice(0, 15).map(c => ({
    id: c.item.id,
    name: c.item.name,
    symbol: c.item.symbol.toUpperCase(),
    marketCapRank: c.item.market_cap_rank,
    priceBtc: c.item.price_btc,
    score: c.item.score,
  }));

  setCache(cacheKey, result);
  return result;
}

// ─────────────────────────────────────────────
// COINGECKO — Top Gainers (1h / 24h momentum)
// ─────────────────────────────────────────────
export async function fetchTopGainers(timeframe = '24h', limit = 50) {
  const cacheKey = `top-gainers:${timeframe}:${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const headers = {};
  if (process.env.COINGECKO_API_KEY) {
    headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;
  }

  const data = await fetchWithRetry(async () => {
    const res = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
      params: {
        vs_currency: 'usd',
        order: 'market_cap_desc',
        per_page: 250,
        page: 1,
        sparkline: false,
        price_change_percentage: '1h,24h,7d',
      },
      headers,
      timeout: 15000,
    });
    return res.data;
  });

  // Sort by specific timeframe change descending
  const sortKey = timeframe === '1h' ? 'price_change_percentage_1h_in_currency' : 'price_change_percentage_24h';
  const sorted = data
    .filter(c => c.total_volume > 1_000_000) // min $1M volume
    .sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0))
    .slice(0, limit);

  const result = sorted.map(c => ({
    id: c.id,
    symbol: c.symbol.toUpperCase(),
    name: c.name,
    price: c.current_price,
    change1h: c.price_change_percentage_1h_in_currency || 0,
    change24h: c.price_change_percentage_24h || 0,
    change7d: c.price_change_percentage_7d_in_currency || 0,
    volume24h: c.total_volume,
    marketCap: c.market_cap,
    marketCapRank: c.market_cap_rank,
    high24h: c.high_24h,
    low24h: c.low_24h,
  }));

  setCache(cacheKey, result);
  return result;
}

// ─────────────────────────────────────────────
// CRYPTOCOMPARE — News API (Free Tier)
// Docs: https://developers.cryptocompare.com/documentation/data-api/news_v1_article_list
// Key optional: tanpa key tetap jalan (30 req/min), dengan key lebih longgar
// Sentimen tidak tersedia di API — akan dianalisis AI di analyzer.js
// ─────────────────────────────────────────────
// On-chain Solana whale tracking.
// Builds a local time series from top token-account snapshots, then compares
// the newest holder balances with the previous scan.
function parseJsonEnv(name, fallback = {}) {
  try {
    return process.env[name] ? JSON.parse(process.env[name]) : fallback;
  } catch (e) {
    console.warn(`[MarketData] Invalid JSON in ${name}: ${e.message}`);
    return fallback;
  }
}

function isLikelySolanaMint(value) {
  return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function getSolanaRpcUrl() {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  if (process.env.HELIUS_API_KEY) {
    return `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  }
  return 'https://api.mainnet-beta.solana.com';
}

async function solanaRpc(method, params = []) {
  const res = await axios.post(getSolanaRpcUrl(), {
    jsonrpc: '2.0',
    id: Date.now(),
    method,
    params,
  }, { timeout: 12000 });

  if (res.data?.error) {
    throw new Error(`Solana RPC ${method} error: ${res.data.error.message}`);
  }
  return res.data?.result;
}

function loadWhaleSnapshots() {
  mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(WHALE_SNAPSHOT_FILE)) return {};

  try {
    return JSON.parse(readFileSync(WHALE_SNAPSHOT_FILE, 'utf8'));
  } catch (e) {
    console.warn(`[MarketData] Could not read whale snapshots: ${e.message}`);
    return {};
  }
}

function saveWhaleSnapshot(snapshot) {
  const db = loadWhaleSnapshots();
  const mint = snapshot.mintAddress;
  if (!db[mint]) db[mint] = [];

  db[mint].push(snapshot);
  db[mint] = db[mint]
    .sort((a, b) => new Date(a.ts) - new Date(b.ts))
    .slice(-24);

  writeFileSync(WHALE_SNAPSHOT_FILE, JSON.stringify(db, null, 2));
}

function getPreviousWhaleSnapshot(mintAddress) {
  const db = loadWhaleSnapshots();
  const snapshots = (db[mintAddress] || [])
    .sort((a, b) => new Date(b.ts) - new Date(a.ts));
  return snapshots[0] || null;
}

export async function fetchCoinSolanaMint(coinOrSymbol) {
  const symbol = typeof coinOrSymbol === 'string'
    ? coinOrSymbol.toUpperCase()
    : coinOrSymbol?.symbol?.toUpperCase();
  const id = typeof coinOrSymbol === 'object' ? coinOrSymbol?.id : null;
  const cacheKey = `solana-mint:${id || symbol || 'unknown'}`;

  if (hasFreshCache(cacheKey)) return getCached(cacheKey);

  const overrides = {
    SOL: SOLANA_NATIVE_MINT,
    ...parseJsonEnv('SOLANA_MINT_OVERRIDES', {}),
    ...parseJsonEnv('TOKEN_MINT_OVERRIDES', {}),
  };

  if (symbol && isLikelySolanaMint(overrides[symbol])) {
    setCache(cacheKey, overrides[symbol]);
    return overrides[symbol];
  }

  const directMint = typeof coinOrSymbol === 'object'
    ? (coinOrSymbol?.platforms?.solana || coinOrSymbol?.mintAddress)
    : null;
  if (isLikelySolanaMint(directMint)) {
    setCache(cacheKey, directMint);
    return directMint;
  }

  if (!id) {
    setCache(cacheKey, null);
    return null;
  }

  const headers = {};
  if (process.env.COINGECKO_API_KEY) {
    headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;
  }

  try {
    const data = await fetchWithRetry(async () => {
      const res = await axios.get(`https://api.coingecko.com/api/v3/coins/${id}`, {
        params: {
          localization: false,
          tickers: false,
          market_data: false,
          community_data: false,
          developer_data: false,
          sparkline: false,
        },
        headers,
        timeout: 12000,
      });
      return res.data;
    }, 2, 800);

    const mint = data?.platforms?.solana || data?.detail_platforms?.solana?.contract_address || null;
    const result = isLikelySolanaMint(mint) ? mint : null;
    setCache(cacheKey, result);
    return result;
  } catch (e) {
    console.warn(`[MarketData] Could not resolve Solana mint for ${symbol || id}: ${e.message}`);
    setCache(cacheKey, null);
    return null;
  }
}

export async function fetchSolanaWhaleAccumulation({ symbol, coin = null, mintAddress = null, priceUsd = null } = {}) {
  const upperSymbol = symbol?.toUpperCase() || coin?.symbol?.toUpperCase() || 'UNKNOWN';
  const mint = mintAddress || await fetchCoinSolanaMint(coin || upperSymbol);

  if (!mint) {
    return {
      supported: false,
      symbol: upperSymbol,
      trend: 'UNSUPPORTED',
      score: 0,
      reason: 'No Solana mint found. Add SOLANA_MINT_OVERRIDES for this symbol if it is a Solana token.',
    };
  }

  const cacheKey = `whales:${mint}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const [largestResult, supplyResult] = await Promise.all([
      solanaRpc('getTokenLargestAccounts', [mint]),
      solanaRpc('getTokenSupply', [mint]),
    ]);

    const largestAccounts = (largestResult?.value || [])
      .map(a => ({
        tokenAccount: a.address,
        balance: Number(a.uiAmountString ?? a.uiAmount ?? 0),
      }))
      .filter(a => Number.isFinite(a.balance) && a.balance > 0)
      .slice(0, 20);

    const supply = Number(supplyResult?.value?.uiAmountString ?? supplyResult?.value?.uiAmount ?? 0);
    if (!largestAccounts.length || !Number.isFinite(supply) || supply <= 0) {
      throw new Error('Token supply or largest accounts unavailable');
    }

    const accountInfo = await solanaRpc('getMultipleAccounts', [
      largestAccounts.map(a => a.tokenAccount),
      { encoding: 'jsonParsed' },
    ]);

    const byOwner = new Map();
    largestAccounts.forEach((account, i) => {
      const owner = accountInfo?.value?.[i]?.data?.parsed?.info?.owner || account.tokenAccount;
      const existing = byOwner.get(owner) || { owner, balance: 0, tokenAccounts: [] };
      existing.balance += account.balance;
      existing.tokenAccounts.push(account.tokenAccount);
      byOwner.set(owner, existing);
    });

    const holders = [...byOwner.values()]
      .map(h => ({
        ...h,
        pctSupply: Number(((h.balance / supply) * 100).toFixed(4)),
      }))
      .sort((a, b) => b.balance - a.balance)
      .slice(0, 20);

    const topBalance = holders.reduce((sum, h) => sum + h.balance, 0);
    const topPctSupply = Number(((topBalance / supply) * 100).toFixed(4));
    const previous = getPreviousWhaleSnapshot(mint);
    const snapshot = {
      ts: new Date().toISOString(),
      symbol: upperSymbol,
      mintAddress: mint,
      supply,
      topPctSupply,
      holders,
    };

    let result;
    if (!previous) {
      result = {
        supported: true,
        symbol: upperSymbol,
        mintAddress: mint,
        trend: 'BASELINE',
        score: 0,
        topPctSupply,
        netDelta: 0,
        netDeltaPctSupply: 0,
        netDeltaUsd: 0,
        accumulatingWallets: 0,
        distributingWallets: 0,
        ageMinutes: null,
        reason: 'Baseline snapshot saved. Run another scan later to detect accumulation/distribution.',
      };
    } else {
      const prevByOwner = new Map(previous.holders.map(h => [h.owner, h.balance]));
      const currByOwner = new Map(holders.map(h => [h.owner, h.balance]));
      const owners = new Set([...prevByOwner.keys(), ...currByOwner.keys()]);
      const deltas = [...owners].map(owner => {
        const current = currByOwner.get(owner) || 0;
        const prev = prevByOwner.get(owner) || 0;
        return { owner, delta: current - prev, current, previous: prev };
      });

      const minWalletDelta = Math.max(supply * 0.0002, priceUsd ? 25_000 / priceUsd : 0);
      const accumulating = deltas.filter(d => d.delta >= minWalletDelta);
      const distributing = deltas.filter(d => d.delta <= -minWalletDelta);
      const netDelta = deltas.reduce((sum, d) => sum + d.delta, 0);
      const netDeltaPctSupply = Number(((netDelta / supply) * 100).toFixed(4));
      const netDeltaUsd = priceUsd ? Number((netDelta * priceUsd).toFixed(2)) : null;
      const topPctDelta = topPctSupply - (previous.topPctSupply || 0);
      let score = 0;

      if (netDeltaPctSupply >= 0.5) score += 4;
      else if (netDeltaPctSupply >= 0.25) score += 3;
      else if (netDeltaPctSupply >= 0.1) score += 2;
      else if (netDeltaPctSupply > 0) score += 1;

      if (accumulating.length >= 5) score += 2;
      else if (accumulating.length >= 3) score += 1.5;
      else if (accumulating.length >= 1) score += 0.75;

      if (topPctDelta >= 0.5) score += 2;
      else if (topPctDelta >= 0.15) score += 1;

      if (netDeltaUsd !== null && netDeltaUsd >= 1_000_000) score += 1;
      else if (netDeltaUsd !== null && netDeltaUsd >= 250_000) score += 0.5;

      if (distributing.length >= accumulating.length && netDeltaPctSupply < 0) score -= 2;
      score = Math.max(0, Math.min(10, Number(score.toFixed(1))));

      const trend = netDeltaPctSupply <= -0.1
        ? 'DISTRIBUTION'
        : score >= 4
          ? 'ACCUMULATION'
          : 'NEUTRAL';

      result = {
        supported: true,
        symbol: upperSymbol,
        mintAddress: mint,
        trend,
        score,
        topPctSupply,
        topPctDelta: Number(topPctDelta.toFixed(4)),
        netDelta: Number(netDelta.toFixed(4)),
        netDeltaPctSupply,
        netDeltaUsd,
        accumulatingWallets: accumulating.length,
        distributingWallets: distributing.length,
        ageMinutes: Number(((Date.now() - new Date(previous.ts).getTime()) / 60000).toFixed(1)),
        reason: trend === 'ACCUMULATION'
          ? 'Top whale balances increased versus previous on-chain snapshot.'
          : trend === 'DISTRIBUTION'
            ? 'Top whale balances decreased versus previous on-chain snapshot.'
            : 'No meaningful top-holder accumulation versus previous snapshot.',
      };
    }

    saveWhaleSnapshot(snapshot);
    setCache(cacheKey, result);
    return result;
  } catch (e) {
    return {
      supported: false,
      symbol: upperSymbol,
      mintAddress: mint,
      trend: 'ERROR',
      score: 0,
      reason: e.message,
    };
  }
}

export async function fetchCryptoNews(currencies = [], filter = 'hot') {
  const cacheKey = `news:${currencies.join(',')}:${filter}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // CryptoCompare: filter 'hot'/'rising' → sortOrder popular/latest
  const sortOrder = filter === 'hot' ? 'popular' : 'latest';

  const params = {
    lang: 'EN',
    sortOrder,
  };

  // Mapping currencies ke categories CryptoCompare
  // CryptoCompare pakai nama coin sebagai category (BTC, ETH, dll)
  if (currencies.length > 0) {
    params.categories = currencies.join(',');
  }

  // API key opsional — set CRYPTOCOMPARE_API_KEY di .env untuk rate limit lebih tinggi
  const headers = {};
  if (process.env.CRYPTOCOMPARE_API_KEY) {
    headers['authorization'] = `Apikey ${process.env.CRYPTOCOMPARE_API_KEY}`;
  }

  const data = await fetchWithRetry(async () => {
    const res = await axios.get('https://min-api.cryptocompare.com/data/v2/news/', {
      params,
      headers,
      timeout: 10000,
    });
    // CryptoCompare returns { Type, Message, Data: [...] }
    if (res.data.Type === 100 || !res.data.Data) {
      throw new Error(`CryptoCompare error: ${res.data.Message || 'Unknown error'}`);
    }
    return res.data;
  });

  const rawNews = Array.isArray(data.Data) ? data.Data : [];
  const result = rawNews.slice(0, 10).map(item => ({
    title: item.title,
    url: item.url,
    source: item.source_info?.name || item.source || 'Unknown',
    publishedAt: new Date(item.published_on * 1000).toISOString(), // Unix timestamp → ISO
    // sentiment: 'pending' → akan diisi AI di analyzer.js via enrichNewsWithSentiment()
    sentiment: 'pending',
    // votes tidak tersedia di CryptoCompare — set ke null agar prompt tidak menampilkan
    votes: null,
    // categories berisi nama coin yg disebut di artikel
    currencies: item.categories
      ? item.categories.split('|').map(c => c.trim()).filter(Boolean)
      : [],
  }));

  setCache(cacheKey, result);
  return result;
}

// ─────────────────────────────────────────────
// Helper — format harga dengan desimal yg pas
// ─────────────────────────────────────────────
export function formatPrice(price) {
  if (price >= 1000) return price.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(5);
  return price.toFixed(8);
}

// ─────────────────────────────────────────────
// BINANCE — Funding Rate (Futures) — gratis, public
// Deteksi short squeeze potential: funding negatif + harga flat
// ─────────────────────────────────────────────
export async function fetchFundingRate(symbol) {
  const binanceSymbol = normalizeBinanceSymbol(symbol);
  const cacheKey = `funding:${binanceSymbol}`;

  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const data = await binanceGet('/fapi/v1/fundingRate', {
      symbol: binanceSymbol,
      limit: 1,
    });

    if (!data || data.length === 0) return null;

    const result = {
      symbol: data[0].symbol,
      fundingRate: parseFloat(data[0].fundingRate),
      fundingTime: data[0].fundingTime,
    };

    setCache(cacheKey, result);
    return result;
  } catch (e) {
    // Coin mungkin gak ada pair futures
    return null;
  }
}

// ─────────────────────────────────────────────
// BINANCE — Order Book Depth (bid/ask ratio)
// Hanya untuk top kandidat, gak semua coin
// ─────────────────────────────────────────────
export async function fetchBinanceDepth(symbol, limit = 50) {
  const binanceSymbol = normalizeBinanceSymbol(symbol);

  try {
    const data = await binanceGet('/api/v3/depth', {
      symbol: binanceSymbol,
      limit,
    });

    const bidVol = data.bids.reduce((sum, b) => sum + parseFloat(b[1]), 0);
    const askVol = data.asks.reduce((sum, a) => sum + parseFloat(a[1]), 0);

    return {
      symbol: binanceSymbol,
      bidVolume: bidVol,
      askVolume: askVol,
      bidAskRatio: askVol > 0 ? parseFloat((bidVol / askVol).toFixed(2)) : 1,
      spreadPct: parseFloat(((parseFloat(data.asks[0][0]) - parseFloat(data.bids[0][0])) / parseFloat(data.bids[0][0]) * 100).toFixed(4)),
    };
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────
// COINMARKETCAL — Scrape event calendar (upcoming catalysts)
// Gratis, gak perlu API key. Scrape halaman search per coin.
// Cache 3 jam biar gak terlalu sering hit.
// ─────────────────────────────────────────────
export async function scrapeCoinMarketCal(symbol) {
  const cacheKey = `cmc-events:${symbol.toUpperCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const res = await axios.get('https://coinmarketcal.com/en/', {
      params: {
        form: {
          date_range: 7,
          coin: symbol.toUpperCase(),
        },
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
      timeout: 8000,
    });

    const html = res.data;
    // Simple regex extraction — cari event cards
    const eventMatches = html.match(/<article[^>]*class="[^"]*card[^"]*"[^>]*>[\s\S]*?<\/article>/gi) || [];

    const events = eventMatches.slice(0, 3).map(card => {
      const titleMatch = card.match(/<h5[^>]*>([\s\S]*?)<\/h5>/i);
      const dateMatch = card.match(/(\d{1,2}\s+\w+\s+\d{4})/i);
      const confMatch = card.match(/(\d+)%/);
      return {
        title: titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : 'Unknown event',
        date: dateMatch ? dateMatch[1] : null,
        confidence: confMatch ? parseInt(confMatch[1]) : 0,
      };
    }).filter(e => e.title !== 'Unknown event');

    const result = {
      symbol: symbol.toUpperCase(),
      events,
      hasEvent: events.length > 0,
    };

    setCache(cacheKey, result);
    return result;
  } catch (e) {
    // Scrape bisa gagal karena Cloudflare — fallback kosong
    return { symbol: symbol.toUpperCase(), events: [], hasEvent: false };
  }
}

// ─────────────────────────────────────────────
// Cache stats (untuk debugging)
// ─────────────────────────────────────────────
export function getCacheStats() {
  return { size: cache.size, keys: [...cache.keys()] };
}

export { normalizeBinanceSymbol, normalizeTimeframe };
