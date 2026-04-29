/**
 * =============================================
 * CRYPTOSENSE BOT — Database Layer (lowdb)
 * =============================================
 * JSON-based storage. Lightweight, zero native deps.
 * Schema: users, watchlists, scan_history
 */

import { LowSync } from 'lowdb';
import { JSONFileSync } from 'lowdb/node';
import { join } from 'path';
import { mkdirSync } from 'fs';

// ─────────────────────────────────────────────
// Init DB
// ─────────────────────────────────────────────
const DATA_DIR = join(process.cwd(), 'data');
mkdirSync(DATA_DIR, { recursive: true });

const adapter = new JSONFileSync(join(DATA_DIR, 'db.json'));
const db = new LowSync(adapter, {
  users: {},        // { chatId: { username, joinedAt, settings } }
  watchlists: {},   // { chatId: [{ symbol, addedAt }] }
  scanHistory: [],  // [{ ts, picks: [], sentTo: [] }]
  alerts: [],       // [{ chatId, symbol, condition, price, createdAt }]
});

db.read();

// ─────────────────────────────────────────────
// USER MANAGEMENT
// ─────────────────────────────────────────────
export function upsertUser(chatId, username = '') {
  db.read();
  const id = String(chatId);
  if (!db.data.users[id]) {
    db.data.users[id] = {
      username,
      chatId: id,
      joinedAt: new Date().toISOString(),
      settings: {
        defaultTimeframe: '4h',
        alertsEnabled: true,
        scanAlerts: true,
      },
    };
    db.write();
  }
}

export function getUser(chatId) {
  db.read();
  return db.data.users[String(chatId)] || null;
}

export function updateUserSettings(chatId, settings) {
  db.read();
  const id = String(chatId);
  if (db.data.users[id]) {
    db.data.users[id].settings = { ...db.data.users[id].settings, ...settings };
    db.write();
    return true;
  }
  return false;
}

export function getAllUserIds() {
  db.read();
  return Object.keys(db.data.users);
}

// ─────────────────────────────────────────────
// WATCHLIST MANAGEMENT
// ─────────────────────────────────────────────
const MAX_WATCHLIST = parseInt(process.env.MAX_WATCHLIST_PER_USER) || 10;

export function addToWatchlist(chatId, symbols) {
  db.read();
  const id = String(chatId);
  if (!db.data.watchlists[id]) db.data.watchlists[id] = [];

  const current = db.data.watchlists[id];
  const added = [];
  const skipped = [];

  for (const sym of symbols) {
    const clean = sym.toUpperCase().replace('USDT', '').replace('/USDT', '');

    if (current.length >= MAX_WATCHLIST) {
      skipped.push(`${clean} (limit ${MAX_WATCHLIST} coin)`);
      continue;
    }

    if (current.find(w => w.symbol === clean)) {
      skipped.push(`${clean} (sudah ada)`);
      continue;
    }

    current.push({ symbol: clean, addedAt: new Date().toISOString() });
    added.push(clean);
  }

  db.write();
  return { added, skipped };
}

export function removeFromWatchlist(chatId, symbols) {
  db.read();
  const id = String(chatId);
  if (!db.data.watchlists[id]) return { removed: [], notFound: symbols };

  const removed = [];
  const notFound = [];

  for (const sym of symbols) {
    const clean = sym.toUpperCase().replace('USDT', '').replace('/USDT', '');
    const idx = db.data.watchlists[id].findIndex(w => w.symbol === clean);
    if (idx !== -1) {
      db.data.watchlists[id].splice(idx, 1);
      removed.push(clean);
    } else {
      notFound.push(clean);
    }
  }

  db.write();
  return { removed, notFound };
}

export function getWatchlist(chatId) {
  db.read();
  return db.data.watchlists[String(chatId)] || [];
}

export function clearWatchlist(chatId) {
  db.read();
  db.data.watchlists[String(chatId)] = [];
  db.write();
}

// ─────────────────────────────────────────────
// SCAN HISTORY
// ─────────────────────────────────────────────
export function saveScanResult(picks, sentTo = []) {
  db.read();
  db.data.scanHistory.push({
    ts: new Date().toISOString(),
    picks,
    sentTo,
  });

  // Keep only last 50 scans
  if (db.data.scanHistory.length > 50) {
    db.data.scanHistory = db.data.scanHistory.slice(-50);
  }

  db.write();
}

export function getLastScan() {
  db.read();
  const history = db.data.scanHistory;
  return history.length > 0 ? history[history.length - 1] : null;
}

// ─────────────────────────────────────────────
// STATS (untuk /status command)
// ─────────────────────────────────────────────
export function getStats() {
  db.read();
  return {
    totalUsers: Object.keys(db.data.users).length,
    totalWatchlists: Object.keys(db.data.watchlists).length,
    totalScans: db.data.scanHistory.length,
    lastScanAt: db.data.scanHistory.at(-1)?.ts || null,
  };
}
