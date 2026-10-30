// Quét quyền chọn bất thường, cùng cách làm với Ripple: chuỗi quyền chọn trễ ~15 phút công khai của Cboe.
// Dữ liệu chỉ cho biết có giao dịch, không cho biết ai mua hay bán, nên chỉ để tham khảo.
'use strict';
const { ny, session } = require('./market');

const DEFAULT_RULES = { minVolume: 1000, minRatio: 2, minPremium: 1_000_000, maxDte: 60, top: 40 };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const OCC = /^([A-Z.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;
function parseOcc(code) {
  const m = OCC.exec(String(code || ''));
  if (!m) return null;
  return { root: m[1], expiry: `20${m[2]}-${m[3]}-${m[4]}`, type: m[5] === 'C' ? 'call' : 'put', strike: Number(m[6]) / 1000 };
}

function parseChain(text) {
  let d;
  try { d = (typeof text === 'string' ? JSON.parse(text) : text)?.data; } catch { return null; }
  if (!d || !Array.isArray(d.options)) return null;
  const contracts = [];
  for (const o of d.options) {
    const occ = parseOcc(o.option);
    if (!occ) continue;
    const last = Number(o.last_trade_price);
    const mid = (Number(o.bid) + Number(o.ask)) / 2;
    const price = last > 0 ? last : mid > 0 ? mid : 0;
    contracts.push({ code: o.option, ...occ, volume: Number(o.volume) || 0, oi: Number(o.open_interest) || 0, price, iv: Number(o.iv) || null });
  }
  return { symbol: String(d.symbol || '').replace(/^_/, ''), price: Number(d.current_price) || null, contracts };
}

const dayNum = ymd => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / 864e5;

function flagUnusual(chain, ms, rules = DEFAULT_RULES) {
  if (!chain) return [];
  const today = dayNum(ny(ms).date);
  return chain.contracts
    .map(c => ({ c, dte: dayNum(c.expiry) - today, premium: c.volume * c.price * 100 }))
    .filter(({ c, dte, premium }) => c.volume >= rules.minVolume && c.volume > rules.minRatio * c.oi
      && premium >= rules.minPremium && dte >= 0 && dte <= rules.maxDte)
    .map(({ c, dte, premium }) => ({
      ticker: chain.symbol, contract: c.code, type: c.type, strike: c.strike, expiry: c.expiry, dte,
      volume: c.volume, oi: c.oi, ratio: c.oi ? Math.round((c.volume / c.oi) * 10) / 10 : null,
      price: c.price, iv: c.iv, premium, underlying: chain.price,
      moneyness: chain.price ? c.strike / chain.price - 1 : null,
    }))
    .sort((a, b) => b.premium - a.premium);
}

// Tóm tắt dòng tiền quyền chọn của 1 mã: tổng phí call/put trong ngày, tỉ lệ put/call
function flowSummary(chain) {
  if (!chain) return null;
  let callPrem = 0, putPrem = 0, callVol = 0, putVol = 0;
  for (const c of chain.contracts) {
    const p = c.volume * c.price * 100;
    if (c.type === 'call') { callPrem += p; callVol += c.volume; } else { putPrem += p; putVol += c.volume; }
  }
  return { callPrem, putPrem, callVol, putVol, pcRatio: callVol ? putVol / callVol : null };
}

async function fetchChain(ticker) {
  const sym = ticker.replace('-', '.');
  const res = await fetch(`https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(sym)}.json`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error('Cboe HTTP ' + res.status);
  return parseChain(await res.text());
}

async function sweep(tickers, rules = DEFAULT_RULES, { fetcher = fetchChain, now = Date.now, concurrency = 3 } = {}) {
  const list = [...new Set(tickers)];
  const flagged = [], flows = {}, errors = [];
  let scanned = 0, i = 0;
  const worker = async () => {
    while (i < list.length) {
      const t = list[i++];
      try {
        const chain = await fetcher(t);
        if (!chain) throw new Error('dữ liệu lỗi');
        flagged.push(...flagUnusual(chain, now(), rules));
        flows[t] = { ...flowSummary(chain), price: chain.price };
        scanned++;
      } catch (e) { errors.push(`${t}: ${e.message}`); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  flagged.sort((a, b) => b.premium - a.premium);
  return { at: now(), scanned, failed: errors.length, errors: errors.slice(0, 10), rules: { ...rules }, flagged: flagged.slice(0, rules.top || 40), flows };
}

// Mỗi giờ trong phiên, thêm 1 lần sau khi đóng cửa
function shouldSweep(prev, ms = Date.now()) {
  if (!prev || !Number.isFinite(prev.at)) return true;
  const s = session(ms), n = ny(ms), last = ny(prev.at);
  if (n.weekday === 'Sat' || n.weekday === 'Sun') return false;
  if (s === 'open') return ms - prev.at >= 55 * 60e3;
  if (n.mins < 960) return false;
  return last.date < n.date || last.mins < 960;
}

module.exports = { DEFAULT_RULES, parseOcc, parseChain, flagUnusual, flowSummary, fetchChain, sweep, shouldSweep };
