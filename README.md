# CryptoSense Bot 🤖

Telegram AI Trading Assistant — sinyal beli/jual, Elliott Wave, coin discovery otomatis.

## Stack
- **Bot Framework:** Grammy (Node.js)
- **AI:** OpenRouter (Llama 3.3 70B / Gemini Flash — Free)
- **Market Data:** Binance Public API + CoinGecko Free
- **News:** CryptoPanic API (Free)
- **Storage:** LowDB (JSON file, zero native deps)
- **Process Manager:** PM2

---

## Setup (Ubuntu VPS)

### 1. Prerequisites
```bash
# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2 globally
npm install -g pm2

# Install Git
sudo apt-get install -y git
```

### 2. Clone & Install
```bash
git clone <your-repo-url> cryptosense-bot
cd cryptosense-bot
npm install
```

### 3. Setup Environment
```bash
cp .env.example .env
nano .env
```

Isi dengan API keys kamu:
```env
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxx
OPENROUTER_MODEL=meta-llama/llama-3.3-70b-instruct:free
ADMIN_CHAT_ID=your_telegram_user_id
CRYPTOPANIC_API_KEY=your_key_here  # optional
```

**Cara dapat API Keys:**
- **Telegram Bot Token:** Chat @BotFather di Telegram → /newbot
- **OpenRouter:** https://openrouter.ai → Sign Up → API Keys
- **CryptoPanic:** https://cryptopanic.com/developers/api → Register
- **Admin Chat ID:** Kirim pesan ke @userinfobot

### 4. Test TA Engine
```bash
# Test dengan BTC
node src/ta/test.js BTC 4h

# Test dengan ETH timeframe 1 jam
node src/ta/test.js ETH 1h
```

### 5. Jalankan (Development)
```bash
npm run dev
```

### 6. Deploy dengan PM2
```bash
# Buat folder logs
mkdir -p logs

# Start dengan PM2
pm2 start ecosystem.config.cjs

# Simpan config PM2 (auto-start after reboot)
pm2 save
pm2 startup
# Jalankan command yang muncul setelah pm2 startup

# Monitor
pm2 status
pm2 logs cryptosense-bot
pm2 monit
```

---

## Commands

| Command | Deskripsi |
|---------|-----------|
| `/start` | Mulai bot |
| `/help` | Lihat semua command |
| `/analyze BTC 4h` | Analisis lengkap + sinyal AI |
| `/signal ETH` | Sinyal cepat beli/jual |
| `/wave SOL 1h` | Elliott Wave explanation |
| `/news BTC` | Analisis sentimen berita |
| `/scan` | Coin discovery scan |
| `/macro` | Macro market overview |
| `/watch BTC ETH` | Tambah watchlist |
| `/unwatch BTC` | Hapus dari watchlist |
| `/list` | Lihat watchlist + harga |
| `/status` | Status bot |

---

## Struktur Folder

```
cryptosense-bot/
├── src/
│   ├── index.js              # Entry point + cron jobs
│   ├── ta/
│   │   ├── indicators.js     # RSI, EMA, MACD, BB, ATR, Stoch RSI
│   │   ├── marketData.js     # Binance + CoinGecko + CryptoPanic fetcher
│   │   └── test.js           # TA Engine test script
│   ├── ai/
│   │   └── analyzer.js       # OpenRouter integration + prompt builder
│   ├── bot/
│   │   └── handlers.js       # Semua Telegram command handlers
│   └── utils/
│       ├── database.js       # LowDB storage layer
│       └── scanner.js        # Coin discovery engine
├── data/
│   └── db.json               # Auto-generated database
├── logs/                     # PM2 logs (auto-generated)
├── .env                      # API keys (jangan di-commit!)
├── .env.example              # Template
├── package.json
└── ecosystem.config.cjs      # PM2 config
```

---

## Model AI Gratis di OpenRouter

| Model | Speed | Quality | Limit |
|-------|-------|---------|-------|
| `meta-llama/llama-3.3-70b-instruct:free` | Fast | ⭐⭐⭐⭐ | 20 req/min |
| `google/gemini-flash-1.5` | Very Fast | ⭐⭐⭐⭐ | 15 req/min |
| `deepseek/deepseek-chat:free` | Medium | ⭐⭐⭐⭐⭐ | 10 req/min |
| `mistralai/mistral-7b-instruct:free` | Fast | ⭐⭐⭐ | 20 req/min |

Ganti di `.env`: `OPENROUTER_MODEL=google/gemini-flash-1.5`

---

## Tips Penggunaan

1. **Timeframe recommendations:**
   - Scalping (1-4 jam): gunakan `1h` atau `15m`
   - Swing trading (1-7 hari): gunakan `4h` atau `1d`

2. **Coin scan:** jalankan `/scan` saat volume market tinggi (Asia/US session open)

3. **Watchlist:** tambahkan coin yang mau kamu pantau, dapat daily digest jam 08:00 WIB

4. **Natural language:** bisa tanya langsung tanpa command, contoh:
   - "BTC kapan entry yang bagus?"
   - "SOL lagi di wave berapa?"
   - "ETH aman hold sekarang?"

---

## Disclaimer

⚠️ Bot ini adalah alat bantu analisis teknikal, **bukan financial advisor**.
Selalu lakukan riset sendiri (DYOR) dan gunakan manajemen risiko yang tepat.
Tidak ada sistem yang bisa memprediksi market dengan akurasi 100%.
