'use strict';
const fs = require('fs');
const path = require('path');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DIR, { recursive: true });

const DEFAULT_SETTINGS = {
  sources: { gainers: true, actives: true, sp500: true, nasdaq100: true, watchlist: true },
  watchlist: ['AAPL', 'NVDA', 'TSLA', 'AMD', 'META', 'PLTR', 'SOFI', 'MARA', 'MU', 'SPCX', 'GOOGL', 'NFLX', 'MSFT', 'AMZN'],
  gainersCount: 25,           // lấy bao nhiêu mã từ danh sách top tăng / giao dịch nhiều của Yahoo
  indexTopN: 25,              // từ S&P 500 + Nasdaq 100 chọn N mã biến động mạnh nhất hôm nay
  minPrice: 2,                // bỏ cổ phiếu dưới 2$
  minDollarVolM: 5,           // giá trị giao dịch hôm nay tối thiểu (triệu $)
  timeframes: ['15m', '1h'],
  modes: ['fibo', 'ema'],
  direction: 'long',
  waveLookback: 40,
  confirmBars: 1,
  minPumpPct: 4,
  minDumpPct: 4,
  maxSignalAge: 4,
  expiryBars: 12,
  feePct: 0,                  // phí mỗi chiều (%), đa số broker Mỹ 0$
  flatAtClose: true,          // day trade: đóng mọi lệnh cuối phiên
  fibo: { entries: [0.236, 0.382, 0.5], sl: 0.618 },
  ema: { periods: [9, 20], slPct: 1.5 },
  scanEveryMin: 15,
  scanPremarket: false,
  telegram: { enabled: true, onlyTimeframes: ['15m', '1h'], options: true, earnings: true },
  reportEveryHours: 6,        // làm mới báo cáo cơ bản của watchlist
  options: { enabled: true, minVolume: 1000, minRatio: 2, minPremiumM: 1, maxDte: 60 }, // giống luật của Ripple
};

function file(name) { return path.join(DIR, name); }
function load(name, fallback) { try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; } }
function save(name, data) { const tmp = file(name + '.tmp'); fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, file(name)); }

function deepMerge(base, patch) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const k of Object.keys(patch || {})) {
    if (!(k in base)) continue;
    out[k] = (typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])) ? deepMerge(base[k], patch[k]) : patch[k];
  }
  return out;
}

const OLD_WATCHLIST = ['AAPL', 'NVDA', 'TSLA', 'AMD', 'META', 'PLTR', 'SOFI', 'MARA'];
module.exports = { OLD_WATCHLIST, DEFAULT_SETTINGS, load, save, deepMerge, file, DIR };
