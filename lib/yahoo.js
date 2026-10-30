// Dữ liệu cổ phiếu Mỹ từ Yahoo Finance (miễn phí, không cần tài khoản).
// Đây là API không chính thức: Yahoo có thể giới hạn tần suất hoặc đổi định dạng. Mọi chỗ đọc dữ liệu đều kiểm tra kỹ.
'use strict';
const { nyDate, ny } = require('./market');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TF_MS = { '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3, '1d': 86400e3 };
// Yahoo giới hạn độ dài lịch sử theo khung
const MAX_DAYS = { '5m': 59, '15m': 59, '30m': 59, '1h': 729, '1d': 3650 };

let hostIdx = 0;
async function getJSON(path, tries = 3) {
  let lastErr;
  for (let a = 0; a < tries; a++) {
    const url = HOSTS[(hostIdx + a) % HOSTS.length] + path;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (res.status === 429) { lastErr = new Error('Yahoo giới hạn tần suất (429)'); await sleep(3000 * (a + 1)); continue; }
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = body && (body.chart?.error?.description || body.finance?.error?.description);
        const e = new Error(msg || 'Yahoo HTTP ' + res.status); e.status = res.status;
        if (res.status === 404 || res.status === 400) throw e;
        lastErr = e; await sleep(800 * (a + 1)); continue;
      }
      return body;
    } catch (e) {
      if (e.status === 404 || e.status === 400) throw e;
      lastErr = e; hostIdx++; await sleep(800 * (a + 1));
    }
  }
  throw lastErr;
}

function parseChart(body, interval) {
  const r = body && body.chart && body.chart.result && body.chart.result[0];
  if (!r) throw new Error('Không có dữ liệu');
  const ts = r.timestamp || [];
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue; // bỏ nến rỗng
    const t = ts[i] * 1000;
    if (interval !== '1d') { const m = ny(t).mins; if (m < 570 || m >= 960) continue; } // bỏ nến 16:00 rỗng và ngoài giờ
    out.push({ t, o, h, l, c, v: q.volume?.[i] || 0, d: nyDate(t) });
  }
  const m = r.meta || {};
  return {
    candles: out,
    meta: { symbol: m.symbol, price: m.regularMarketPrice, prevClose: m.previousClose ?? m.chartPreviousClose, currency: m.currency, exchange: m.exchangeName, name: m.shortName || m.longName },
  };
}

async function chart(symbol, interval, { days, period1, period2 } = {}) {
  const q = new URLSearchParams({ interval, includePrePost: 'false', events: '' });
  if (period1) { q.set('period1', String(Math.floor(period1 / 1000))); q.set('period2', String(Math.floor((period2 || Date.now()) / 1000))); }
  else q.set('range', Math.min(days || 5, MAX_DAYS[interval]) + 'd');
  return parseChart(await getJSON(`/v8/finance/chart/${encodeURIComponent(symbol)}?${q}`), interval);
}

async function klines(symbol, interval, { limit = 200 } = {}) {
  const barsPerDay = { '5m': 78, '15m': 26, '30m': 13, '1h': 7, '1d': 1 }[interval] || 26;
  const days = Math.ceil(limit / barsPerDay * 1.5) + 4; // dư ra cho cuối tuần
  const { candles } = await chart(symbol, interval, { days });
  return candles.slice(-limit);
}

async function klinesRange(symbol, interval, startTime) {
  const maxStart = Date.now() - MAX_DAYS[interval] * 86400e3;
  const { candles } = await chart(symbol, interval, { period1: Math.max(startTime, maxStart) });
  return candles;
}

// Danh sách có sẵn của Yahoo: day_gainers, most_actives, small_cap_gainers, day_losers
async function screener(scrId, count = 50) {
  const body = await getJSON(`/v1/finance/screener/predefined/saved?scrIds=${scrId}&count=${count}&formatted=false`);
  const quotes = body?.finance?.result?.[0]?.quotes || [];
  return quotes.map(x => ({
    symbol: x.symbol, name: x.shortName || x.longName || '',
    price: num(x.regularMarketPrice), changePct: num(x.regularMarketChangePercent),
    volume: num(x.regularMarketVolume), avgVolume: num(x.averageDailyVolume3Month || x.averageDailyVolume10Day),
  })).filter(x => x.symbol && x.price);
}
const num = v => (v && typeof v === 'object' && 'raw' in v) ? v.raw : (typeof v === 'number' ? v : null);

// Thông tin trong ngày của 1 mã (dùng để lọc danh sách chỉ số lớn)
async function dayStats(symbol) {
  const { candles, meta } = await chart(symbol, '1d', { days: 30 });
  if (candles.length < 2) return null;
  const last = candles[candles.length - 1], prev = candles[candles.length - 2];
  const vols = candles.slice(0, -1).slice(-20).map(c => c.v).filter(Boolean);
  const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
  return { symbol, name: meta.name, price: last.c, changePct: (last.c / prev.c - 1) * 100, volume: last.v, avgVolume: avgVol };
}

module.exports = { parseChart, chart, klines, klinesRange, screener, dayStats, TF_MS, MAX_DAYS, sleep };
