// Dữ liệu MẪU (giả lập) cho cổ phiếu, chỉ để thử giao diện khi DEMO=1. KHÔNG phải giá thật.
'use strict';
const { nyDate, ny } = require('./market');
const { NASDAQ100 } = require('./universe');

const SYMS = NASDAQ100.slice(0, 40);
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function hash(str) { let h = 2166136261; for (const ch of str) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

const cache = new Map();
// Nến 15m trong giờ giao dịch 9:30-16:00 NY của ~400 ngày làm việc gần nhất
function base15(symbol) {
  if (cache.has(symbol)) return cache.get(symbol);
  const r = rng(hash(symbol));
  const start = 20 + r() * 400;
  let price = start;
  const out = [];
  const now = Date.now();
  // tìm mốc 9:30 NY của từng ngày làm việc
  for (let dayBack = 560; dayBack >= 0; dayBack--) {
    const probe = now - dayBack * 86400e3;
    const n = ny(probe);
    if (n.weekday === 'Sat' || n.weekday === 'Sun') continue;
    const open = probe - (n.mins - 570) * 60e3 - (probe % 60e3);
    const openAligned = Math.floor(open / 900e3) * 900e3 + (open % 900e3 > 450e3 ? 900e3 : 0);
    price *= 1 + (r() - 0.5) * 0.02; // khoảng trống qua đêm
    let pumpLeft = 0, pump = 0;
    for (let k = 0; k < 26; k++) {
      const t = openAligned + k * 900e3;
      if (t > now) break;
      if (pumpLeft <= 0 && r() < 0.025) { pumpLeft = 2 + Math.floor(r() * 6); pump = (0.006 + r() * 0.02) * (r() < 0.75 ? 1 : -1); }
      let drift = (r() - 0.5) * 0.008 - 0.002 * Math.log(price / start);
      if (pumpLeft > 0) { drift += pump; pumpLeft--; }
      const o = price, c = o * (1 + drift);
      const h = Math.max(o, c) * (1 + r() * 0.004), l = Math.min(o, c) * (1 - r() * 0.004);
      out.push({ t, o, h, l, c, v: Math.round(2e5 * (1 + r() * 3) * (pumpLeft > 0 ? 4 : 1)), d: nyDate(t) });
      price = c;
    }
  }
  cache.set(symbol, out);
  return out;
}
function agg(c15, minutes) {
  const step = minutes * 60e3, out = [];
  for (const c of c15) {
    const off = (570 * 60e3) % step; const t = Math.floor((c.t - off) / step) * step + off; // nến giờ bắt đầu 9:30, 10:30…
    const last = out[out.length - 1];
    if (last && last.t === t && last.d === c.d) { last.h = Math.max(last.h, c.h); last.l = Math.min(last.l, c.l); last.c = c.c; last.v += c.v; }
    else out.push({ ...c, t });
  }
  return out;
}
function series(symbol, interval) {
  const b = base15(symbol);
  if (interval === '15m') return b;
  if (interval === '1h') return agg(b, 60);
  if (interval === '1d') { const out = []; for (const c of b) { const l = out[out.length - 1]; if (l && l.d === c.d) { l.h = Math.max(l.h, c.h); l.l = Math.min(l.l, c.l); l.c = c.c; l.v += c.v; } else out.push({ ...c }); } return out; }
  return b;
}
async function klines(symbol, interval, { limit = 200 } = {}) { if (!SYMS.includes(symbol)) throw Object.assign(new Error('Không có mã'), { status: 404 }); return series(symbol, interval).slice(-limit); }
async function klinesRange(symbol, interval, startTime) { return series(symbol, interval).filter(c => c.t >= startTime); }
async function dayStats(symbol) {
  if (!SYMS.includes(symbol)) return null;
  const d = series(symbol, '1d'); const l = d[d.length - 1], p = d[d.length - 2];
  return { symbol, name: symbol + ' (mẫu)', price: l.c, changePct: (l.c / p.c - 1) * 100, volume: l.v, avgVolume: d.slice(-21, -1).reduce((a, c) => a + c.v, 0) / 20 };
}
async function screener(scrId, count = 25) {
  const all = (await Promise.all(SYMS.map(dayStats))).filter(Boolean);
  if (scrId === 'most_actives') return all.sort((a, b) => b.volume - a.volume).slice(0, count);
  return all.sort((a, b) => b.changePct - a.changePct).slice(0, count);
}
module.exports = { klines, klinesRange, dayStats, screener, demo: true };

// ---- Báo cáo và quyền chọn MẪU (chỉ để thử giao diện) ----
const { assess } = require('./fundamentals');
async function fundamentals(symbol) {
  const r = rng(hash(symbol + 'f'));
  const d = series(SYMS.includes(symbol) ? symbol : SYMS[0], '1d');
  const price = d[d.length - 1].c;
  const hist = [0, 1, 2, 3].map(i => { const est = 0.5 + r() * 2; const act = est * (0.9 + r() * 0.25); return { quarter: `2026-${String(i * 3 + 1).padStart(2, "0")}-28`, actual: +act.toFixed(2), estimate: +est.toFixed(2), surprise: act / est - 1 }; });
  const rev = 1e9 * (5 + r() * 60);
  const x = {
    symbol, at: Date.now(), name: symbol + ' (mẫu)', price, changePct: (r() - 0.5) * 6, marketCap: rev * 4 * (5 + r() * 20),
    lastQuarter: '2026-09-30', revenueQ: rev, revenueQLabel: '3Q2026', revenueGrowth: (r() - 0.25) * 60, earningsGrowth: (r() - 0.3) * 80,
    eps: hist[3], epsHistory: hist, revenueHistory: [0, 1, 2, 3].map(i => ({ label: `${i + 4 > 4 ? i : 4}Q202${i ? 6 : 5}`, revenue: rev * (0.8 + i * 0.07), earnings: rev * 0.2 })),
    grossMargin: 30 + r() * 50, operatingMargin: -5 + r() * 45, profitMargin: -5 + r() * 35, revenueTTM: rev * 3.8, fcf: rev * (r() - 0.2), ocf: rev, cash: rev * 2, debt: rev * r() * 3,
    targetMean: price * (0.9 + r() * 0.4), targetHigh: price * 1.5, targetLow: price * 0.7, recommendation: 'buy', analysts: 20 + Math.floor(r() * 30), forwardPE: 10 + r() * 60, trailingPE: 15 + r() * 70,
    curQ: { end: '2026-12-31', epsAvg: 1.2, revAvg: rev * 1.1, revGrowth: (r() - 0.2) * 0.5, epsGrowth: (r() - 0.2), up30: Math.floor(r() * 8), down30: Math.floor(r() * 5), analysts: 25 },
    nextQ: { end: '2027-03-31', epsAvg: 1.3, revAvg: rev * 1.15, revGrowth: (r() - 0.2) * 0.5 }, curY: { end: '2026-12-31', epsAvg: 4.5, revAvg: rev * 4.1, revGrowth: 0.2 }, nextY: { end: '2027-12-31', epsAvg: 5.6, revAvg: rev * 4.8, revGrowth: 0.17 },
    nextEarnings: Date.now() + Math.floor(r() * 40) * 86400e3,
  };
  return Object.assign(x, assess(x));
}
async function optionChain(symbol) {
  const r = rng(hash(symbol + 'o' + new Date().toISOString().slice(0, 13)));
  const d = series(SYMS.includes(symbol) ? symbol : SYMS[0], '1d');
  const price = d[d.length - 1].c, contracts = [];
  const today = new Date();
  for (let k = 0; k < 60; k++) {
    const dte = [3, 10, 17, 31, 45, 80, 200, 450][Math.floor(r() * 8)];
    const exp = new Date(today.getTime() + dte * 86400e3).toISOString().slice(0, 10);
    const type = r() < 0.6 ? 'call' : 'put';
    const strike = Math.round(price * (0.8 + r() * 0.45));
    const oi = Math.floor(r() * 8000), volume = Math.floor(r() < 0.12 ? 3000 + r() * 20000 : r() * 2000);
    const opt = Math.max(0.05, Math.abs(price - strike) * 0.3 + price * 0.03 * Math.sqrt(dte / 30));
    contracts.push({ code: `${symbol}${exp.slice(2, 4)}${exp.slice(5, 7)}${exp.slice(8, 10)}${type === 'call' ? 'C' : 'P'}${String(strike * 1000).padStart(8, '0')}`, root: symbol, expiry: exp, type, strike, volume, oi, price: +opt.toFixed(2), iv: 0.3 + r() * 0.6 });
  }
  return { symbol, price, contracts };
}
module.exports.fundamentals = fundamentals;
module.exports.optionChain = optionChain;
