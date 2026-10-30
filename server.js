// Day Radar - quét cổ phiếu Mỹ tìm sóng đẩy trong ngày, báo điểm vào lệnh hồi (Fibo/EMA). Chỉ quét và báo, không đặt lệnh.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* không có .env */ }

const S = require('./lib/strategy');
const Y = require('./lib/yahoo');
const M = require('./lib/market');
const U = require('./lib/universe');
const { DEFAULT_SETTINGS, OLD_WATCHLIST, load, save, deepMerge, file } = require('./lib/store');
const FUND = require('./lib/fundamentals');
const OPT = require('./lib/options');

const DEMO = process.env.DEMO === '1';
const SRC = DEMO ? require('./lib/demo') : Y;
const getReport = DEMO ? SRC.fundamentals : FUND.report;
const getChain = DEMO ? SRC.optionChain : OPT.fetchChain;
const PORT = +process.env.PORT || 8081;
const ONCE_MODE = process.argv.includes('--once') || process.argv.includes('--backtest');

const state = load('state.json', {});
state.settings = deepMerge(DEFAULT_SETTINGS, state.settings || {});
state.tracked = state.tracked || [];
state.alerts = state.alerts || [];
state.backtests = state.backtests || [];
state.reports = state.reports || {};
state.options = state.options || null;
state.optSent = state.optSent || {};
if (JSON.stringify(state.settings.watchlist) === JSON.stringify(OLD_WATCHLIST)) state.settings.watchlist = DEFAULT_SETTINGS.watchlist.slice();
// Bản GitHub: cài đặt lấy từ settings.json trong repo (sửa file đó trên GitHub)
if (ONCE_MODE) {
  try { state.settings = deepMerge(DEFAULT_SETTINGS, JSON.parse(fs.readFileSync(process.env.SETTINGS_FILE || path.join(__dirname, 'settings.json'), 'utf8'))); }
  catch (e) { console.log('không đọc được settings.json, dùng mặc định:', e.message); state.settings = deepMerge(DEFAULT_SETTINGS, {}); }
}
let reportsBusy = false, reportsError = null, optionsBusy = false;
let signals = [], quotes = {}, universeInfo = null;
let scanning = false, scanError = null, scanProgress = null, lastScanSession = state.lastScanSession || null;
signals = state.lastSignals || []; quotes = state.lastQuotes || {}; universeInfo = state.lastUniverse || null;
let saveTimer = null;
function persist(now = false) {
  clearTimeout(saveTimer);
  const doSave = () => {
    state.tracked = state.tracked.filter(t => !isFinal(t.status) || Date.now() - (t.closedAt || 0) < 21 * 86400e3).slice(-800);
    state.alerts = state.alerts.slice(-400);
    save('state.json', state);
  };
  if (now) doSave(); else saveTimer = setTimeout(doSave, 300);
}
const isFinal = st => ['tp', 'sl', 'eod', 'cancelled', 'expired', 'removed'].includes(st);
const uid = () => crypto.randomBytes(6).toString('hex');
const log = (...a) => console.log(new Date().toISOString(), ...a);
const fmt = p => p == null ? '-' : p >= 100 ? p.toFixed(2) : p.toFixed(p >= 1 ? 2 : 4);
const dirs = cfg => cfg.direction === 'both' ? ['long', 'short'] : [cfg.direction];

const pendingSends = [];
function telegram(text) { const p = sendTelegram(text); pendingSends.push(p); return p; }
async function sendTelegram(text) {
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat || !state.settings.telegram.enabled) return;
  try {
    await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }), signal: AbortSignal.timeout(10000),
    });
  } catch (e) { log('telegram lỗi', e.message); }
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

// ---------- Danh sách mã cần quét ----------
let indexCache = { at: 0, list: [] };
async function indexMovers(cfg, force) {
  const want = [...(cfg.sources.sp500 ? U.SP500 : []), ...(cfg.sources.nasdaq100 ? U.NASDAQ100 : [])];
  if (!want.length) return [];
  if (!force && Date.now() - indexCache.at < 30 * 60e3 && indexCache.list.length) return indexCache.list;
  const syms = [...new Set(want)];
  const stats = [];
  await pool(syms, 6, async s => { try { const st = await SRC.dayStats(s); if (st) stats.push(st); } catch { /* bỏ mã lỗi */ } if (!DEMO) await Y.sleep(40); });
  indexCache = { at: Date.now(), list: stats };
  return stats;
}

async function buildUniverse() {
  const cfg = state.settings;
  const map = new Map();
  const add = (q, tag) => {
    const cur = map.get(q.symbol) || { ...q, tags: [] };
    if (!cur.tags.includes(tag)) cur.tags.push(tag);
    for (const k of ['price', 'changePct', 'volume', 'avgVolume', 'name']) if (cur[k] == null && q[k] != null) cur[k] = q[k];
    map.set(q.symbol, cur);
  };
  const okLiquid = q => q.price >= cfg.minPrice && (q.price * (q.volume || 0)) >= cfg.minDollarVolM * 1e6;
  const errors = [];
  if (cfg.sources.gainers) { try { (await SRC.screener('day_gainers', cfg.gainersCount)).filter(okLiquid).forEach(q => add(q, 'Top tăng')); } catch (e) { errors.push('Top tăng: ' + e.message); } }
  if (cfg.sources.actives) { try { (await SRC.screener('most_actives', cfg.gainersCount)).filter(okLiquid).forEach(q => add(q, 'Sôi động')); } catch (e) { errors.push('Sôi động: ' + e.message); } }
  if (cfg.sources.sp500 || cfg.sources.nasdaq100) {
    try {
      const st = (await indexMovers(cfg)).filter(okLiquid);
      const score = q => (cfg.direction === 'short' ? -q.changePct : cfg.direction === 'both' ? Math.abs(q.changePct) : q.changePct) * Math.min(3, (q.volume || 0) / (q.avgVolume || 1e12) + 0.5);
      st.sort((a, b) => score(b) - score(a)).slice(0, cfg.indexTopN).forEach(q => add(q, 'Chỉ số'));
    } catch (e) { errors.push('Chỉ số: ' + e.message); }
  }
  if (cfg.sources.watchlist) for (const s of cfg.watchlist) add({ symbol: s }, 'Watchlist');
  universeInfo = { count: map.size, errors, at: Date.now() };
  return [...map.values()];
}

// ---------- Quét ----------
async function scan(force = false) {
  if (scanning) return;
  const sess = M.session();
  if (!force && sess !== 'open' && lastScanSession !== 'open') return; // ngoài giờ: chỉ quét thêm 1 lần sau khi đóng cửa
  scanning = true; scanError = null;
  const cfg = state.settings;
  try {
    const uni = await buildUniverse();
    if (!uni.length) throw new Error('Không lấy được danh sách mã. ' + (universeInfo.errors.join('; ') || ''));
    quotes = Object.fromEntries(uni.map(q => [q.symbol, q]));
    const jobs = [];
    for (const q of uni) for (const tf of cfg.timeframes) jobs.push([q.symbol, tf]);
    for (const tr of state.tracked) if (!isFinal(tr.status) && !jobs.some(j => j[0] === tr.symbol && j[1] === tr.tf)) jobs.push([tr.symbol, tr.tf]);
    scanProgress = { done: 0, total: jobs.length };
    const cache = {}, sigs = [];
    let failed = 0;
    await pool(jobs, 5, async ([sym, tf]) => {
      try {
        const candles = await SRC.klines(sym, tf, { limit: cfg.waveLookback + 110 });
        if (candles.length < cfg.waveLookback + 5) { scanProgress.done++; return; }
        cache[sym + '|' + tf] = candles;
        const q = quotes[sym];
        if (q && q.price == null) q.price = candles[candles.length - 1].c;
        if (q) {
          const today = candles[candles.length - 1].d;
          for (const mode of cfg.modes) for (const dir of dirs(cfg)) {
            const sig = S.liveSignal(candles, cfg, mode, dir);
            if (sig) sigs.push({ symbol: sym, tf, tags: q.tags, name: q.name, changePct: q.changePct, volume: q.volume, avgVolume: q.avgVolume, ...sig });
            for (const st of S.recentSetups(candles, cfg, mode, dir, cfg.maxSignalAge + 1)) if (!cfg.flatAtClose || st.day === today) addTracked(sym, tf, st, q.tags);
          }
        }
      } catch (e) { failed++; if (failed < 5) log('lỗi', sym, tf, e.message); }
      scanProgress.done++;
      if (!DEMO) await Y.sleep(50);
    });
    signals = sigs.sort((a, b) => b.peakTime - a.peakTime || b.move - a.move);
    updateTracked(cache);
    state.lastScan = Date.now();
    if (failed && failed === jobs.length) throw new Error('Không tải được nến nào (Yahoo có thể đang chặn hoặc mất mạng)');
    persist();
    log(`quét xong: ${uni.length} mã, ${signals.length} tín hiệu, lỗi ${failed}/${jobs.length}`);
  } catch (e) { scanError = e.message; log('quét lỗi:', e.message); }
  finally { scanning = false; scanProgress = null; lastScanSession = sess; state.lastScanSession = sess; state.lastSignals = signals; state.lastQuotes = quotes; state.lastUniverse = universeInfo; }
}

function addTracked(symbol, tf, st, tags) {
  const key = [symbol, tf, st.mode, st.dir, st.peakTime].join('|');
  if (state.tracked.some(t => t.key === key)) return;
  const tr = { id: uid(), key, symbol, tf, tags, ...st, status: 'waiting', addedAt: Date.now() };
  delete tr.createdIdx;
  state.tracked.push(tr);
  const md = st.mode === 'fibo' ? 'Fibo' : 'EMA';
  state.alerts.push({ id: uid(), time: Date.now(), type: 'new', trackedId: tr.id, symbol, tf, mode: st.mode, dir: st.dir, text: `Setup mới ${st.dir.toUpperCase()} ${md}` });
  if (state.settings.telegram.onlyTimeframes.includes(tf)) {
    telegram(`📡 <b>${symbol}</b> ${tf} ${st.dir.toUpperCase()} · ${md}\nSóng ${st.dir === 'long' ? '+' : '-'}${(st.move * 100).toFixed(1)}%\n` +
      st.entries.map((e, i) => `E${i + 1} ${e.label}: ${fmt(e.price)}`).join('\n') + `\nSL: ${fmt(st.sl)}\nTP: ${fmt(st.tp)}`);
  }
}

function updateTracked(cache) {
  const cfg = state.settings;
  const sess = M.session(), nowNy = M.ny();
  for (const tr of state.tracked) {
    if (isFinal(tr.status)) continue;
    const candles = cache[tr.symbol + '|' + tr.tf];
    if (!candles) continue;
    const idx = candles.findIndex(c => c.t === tr.createdTime);
    const before = tr.status, filledBefore = tr.entries.filter(e => e.filled).length;
    let r;
    if (idx < 0) {
      // nến tạo setup đã trôi ra ngoài dữ liệu -> đóng ở giá cuối
      r = S.forceClose(JSON.parse(JSON.stringify(tr)), candles[candles.length - 1], cfg);
    } else {
      r = S.simulate(tr, candles, idx + 1, cfg);
      const sessionOver = tr.intraday && (nowNy.date > tr.day || (nowNy.date === tr.day && sess !== 'open' && nowNy.mins >= 960));
      if (!isFinal(r.status) && sessionOver) r = S.forceClose(r, candles[candles.length - 1], cfg);
    }
    Object.assign(tr, {
      status: r.status, entries: r.entries, avg: r.avg, filledCount: r.filledCount, exitPrice: r.exitPrice, exitTime: r.exitTime,
      pnlPct: r.pnlPct, R: r.R, reason: r.reason, barsHeld: r.barsHeld, price: candles[candles.length - 1].c,
    });
    if (r.filledCount > filledBefore) state.alerts.push({ id: uid(), time: Date.now(), type: 'fill', trackedId: tr.id, symbol: tr.symbol, tf: tr.tf, mode: tr.mode, dir: tr.dir, text: `Khớp ${r.filledCount}/${tr.entries.length}` });
    if (isFinal(r.status) && !isFinal(before)) {
      tr.closedAt = Date.now();
      const label = { tp: 'Chốt TP', sl: 'Dính SL', eod: 'Đóng cuối phiên', cancelled: 'Huỷ', expired: 'Hết hạn' }[r.status];
      state.alerts.push({ id: uid(), time: Date.now(), type: r.status, trackedId: tr.id, symbol: tr.symbol, tf: tr.tf, mode: tr.mode, dir: tr.dir, text: label + (r.pnlPct != null ? ` ${r.pnlPct >= 0 ? '+' : ''}${r.pnlPct.toFixed(2)}%` : '') });
      if (r.pnlPct != null && state.settings.telegram.onlyTimeframes.includes(tr.tf)) telegram(`${r.pnlPct >= 0 ? '✅' : '🛑'} <b>${tr.symbol}</b> ${tr.tf} ${label} ${r.pnlPct >= 0 ? '+' : ''}${r.pnlPct.toFixed(2)}%`);
    }
  }
}

// ---------- Backtest ----------
const jobs = {};
async function runBacktest(job) {
  const p = job.params;
  const cfg = deepMerge(state.settings, { feePct: p.feePct, flatAtClose: p.flatAtClose });
  try {
    job.stage = 'Đang lấy danh sách mã';
    let symbols;
    if (p.scope === 'watchlist') symbols = state.settings.watchlist;
    else if (p.scope === 'list') symbols = p.symbols;
    else if (p.scope === 'nasdaq100') symbols = U.NASDAQ100.slice(0, p.topN);
    else if (p.scope === 'gainers') symbols = (await SRC.screener('day_gainers', p.topN)).map(q => q.symbol);
    else symbols = U.SP500.slice(0, p.topN);
    if (DEMO) { const ok = (await SRC.screener('x', 40)).map(q => q.symbol); symbols = symbols.filter(s => ok.includes(s)); if (!symbols.length) symbols = ok.slice(0, p.topN); }
    const pairs = []; for (const s of symbols) for (const tf of p.timeframes) pairs.push([s, tf]);
    const all = []; let setups = 0, cancelled = 0, done = 0;
    const dl = p.direction === 'both' ? ['long', 'short'] : [p.direction];
    await pool(pairs, 4, async ([sym, tf]) => {
      if (job.cancel) return;
      job.stage = `Đang chạy ${sym} ${tf}`;
      try {
        const days = Math.min(p.days, Y.MAX_DAYS[tf]);
        const candles = await SRC.klinesRange(sym, tf, Date.now() - days * 86400e3);
        for (const mode of p.modes) for (const dir of dl) {
          const r = S.runSeries(candles, cfg, mode, dir);
          setups += r.setups; cancelled += r.cancelled;
          for (const t of r.trades) all.push({ symbol: sym, tf, mode, dir, createdTime: t.createdTime, exitTime: t.exitTime, status: t.status, pnlPct: t.pnlPct, R: t.R, avg: t.avg, exitPrice: t.exitPrice, filled: t.filledCount, n: t.entries.length, barsHeld: t.barsHeld });
        }
      } catch (e) { job.errors.push(`${sym} ${tf}: ${e.message}`); }
      done++; job.progress = done / pairs.length;
      if (!DEMO) await Y.sleep(80);
    });
    if (job.cancel) { job.status = 'cancelled'; return; }
    const summary = S.stats(all, { setups, cancelled });
    const byTf = {}, byMode = {};
    for (const tf of p.timeframes) byTf[tf] = S.stats(all.filter(t => t.tf === tf));
    for (const m of p.modes) { byMode[m] = S.stats(all.filter(t => t.mode === m)); delete byMode[m].curve; }
    const bySymbol = symbols.map(s => { const st = S.stats(all.filter(t => t.symbol === s)); return { symbol: s, trades: st.trades, winRate: st.winRate, totalPct: st.totalPct, profitFactor: st.profitFactor }; }).filter(x => x.trades).sort((a, b) => b.totalPct - a.totalPct);
    const thin = c => c.length > 600 ? c.filter((_, i) => i % Math.ceil(c.length / 600) === 0 || i === c.length - 1) : c;
    summary.curve = thin(summary.curve); for (const k in byTf) byTf[k].curve = thin(byTf[k].curve);
    job.result = { summary, byTf, byMode, bySymbol, trades: all.sort((a, b) => b.exitTime - a.exitTime).slice(0, 300), symbolsCount: symbols.length };
    job.status = 'done'; job.progress = 1;
    save('bt-' + job.id + '.json', { id: job.id, params: p, createdAt: job.createdAt, result: job.result, errors: job.errors, demo: DEMO });
    state.backtests.unshift({ id: job.id, params: p, createdAt: job.createdAt, trades: summary.trades, totalPct: summary.totalPct, winRate: summary.winRate, demo: DEMO });
    state.backtests = state.backtests.slice(0, 30);
    persist();
  } catch (e) { job.status = 'error'; job.error = e.message; }
}

// ---------- Báo cáo cơ bản cho watchlist ----------
async function refreshReports(force = false) {
  if (reportsBusy) return;
  reportsBusy = true; reportsError = null;
  const cfg = state.settings, errs = [];
  try {
    for (const sym of cfg.watchlist) {
      const old = state.reports[sym];
      const stale = !old || Date.now() - old.at > cfg.reportEveryHours * 3600e3;
      const justReported = old && old.nextEarnings && old.nextEarnings < Date.now() && old.at < old.nextEarnings + 6 * 3600e3;
      if (!force && !stale && !justReported) continue;
      try {
        const r = await getReport(sym);
        if (old && r.lastQuarter && old.lastQuarter && r.lastQuarter !== old.lastQuarter && cfg.telegram.earnings) {
          const e = r.eps;
          telegram(`🧾 <b>${sym}</b> vừa có kết quả ${r.lastQuarter}\n` + (e ? `EPS ${e.actual} so với dự báo ${e.estimate} (${e.surprise >= 0 ? '+' : ''}${(e.surprise * 100).toFixed(1)}%)\n` : '') +
            (r.revenueGrowth != null ? `Doanh thu ${r.revenueGrowth >= 0 ? '+' : ''}${r.revenueGrowth.toFixed(1)}% so với cùng kỳ\n` : '') + `Đánh giá: ${r.viewLabel}`);
        }
        state.reports[sym] = r;
      } catch (e) { errs.push(`${sym}: ${e.message}`); if (old) old.error = e.message; }
      if (!DEMO) await Y.sleep(400);
    }
    for (const k of Object.keys(state.reports)) if (!cfg.watchlist.includes(k)) delete state.reports[k];
    if (errs.length) reportsError = errs.slice(0, 5).join(' · ');
    persist();
  } finally { reportsBusy = false; }
}

// ---------- Quyền chọn bất thường (giống Ripple) ----------
async function sweepOptions(force = false) {
  const cfg = state.settings;
  if (optionsBusy || !cfg.options.enabled) return;
  if (!force && !OPT.shouldSweep(state.options)) return;
  optionsBusy = true;
  try {
    const rules = { minVolume: cfg.options.minVolume, minRatio: cfg.options.minRatio, minPremium: cfg.options.minPremiumM * 1e6, maxDte: cfg.options.maxDte, top: 60 };
    const res = await OPT.sweep(cfg.watchlist, rules, { fetcher: getChain });
    state.options = res;
    // báo Telegram các hợp đồng mới thấy trong ngày, tối đa 5 dòng mỗi lần
    const day = M.ny().date;
    if (state.optSent.day !== day) state.optSent = { day, keys: [] };
    const fresh = res.flagged.filter(f => !state.optSent.keys.includes(f.contract)).slice(0, 5);
    if (fresh.length && cfg.telegram.options) {
      state.optSent.keys.push(...fresh.map(f => f.contract));
      telegram('🔎 <b>Quyền chọn bất thường</b> (Cboe, trễ ~15 phút)\n' + fresh.map(f =>
        `${f.ticker} ${f.type === 'call' ? 'CALL' : 'PUT'} ${f.strike} ${f.expiry} · ${f.volume.toLocaleString('en-US')} HĐ (${f.ratio ?? '∞'}x OI) · $${(f.premium / 1e6).toFixed(1)}M`).join('\n'));
    }
    persist();
    log(`quyền chọn: ${res.flagged.length} giao dịch bất thường từ ${res.scanned} mã (${res.failed} lỗi)`);
  } catch (e) { log('quyền chọn lỗi', e.message); }
  finally { optionsBusy = false; }
}

// ---------- HTTP ----------
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
function readBody(req) { return new Promise((ok, bad) => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); }); req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch (e) { bad(e); } }); }); }
function authed(req) {
  const pw = process.env.APP_PASSWORD; if (!pw) return true;
  const b64 = (req.headers.authorization || '').split(' ')[1]; if (!b64) return false;
  return Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') === pw;
}
const cleanSym = s => String(s).toUpperCase().trim().replace(/[^A-Z0-9.\-^=]/g, '').replace('.', '-');

function apiState() {
  return {
    demo: DEMO, static: ONCE_MODE, now: Date.now(), market: M.session(), settings: state.settings, lastScan: state.lastScan, scanning, scanProgress, scanError, universe: universeInfo,
    signals, quotes, tracked: state.tracked.filter(t => t.status !== 'removed').slice(-500), alerts: state.alerts.slice(-200).reverse(),
    backtests: state.backtests, reports: state.reports, reportsBusy, reportsError, options: state.options, optionsBusy, telegramReady: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
  };
}

const server = http.createServer(async (req, res) => {
  if (!authed(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Day Radar"' }); return res.end('Cần mật khẩu'); }
  const p = new URL(req.url, 'http://x').pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8'), 'text/html');
    if (p === '/api/state') return send(res, 200, apiState());
    if (false) return send(res, 200, {
      demo: DEMO, now: Date.now(), market: M.session(), settings: state.settings, lastScan: state.lastScan, scanning, scanProgress, scanError, universe: universeInfo,
      signals, quotes, tracked: state.tracked.filter(t => t.status !== 'removed').slice(-500), alerts: state.alerts.slice(-200).reverse(),
      backtests: state.backtests, reports: state.reports, reportsBusy, reportsError, options: state.options, optionsBusy, telegramReady: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    });
    if (p === '/api/scan' && req.method === 'POST') { indexCache.at = 0; scan(true); return send(res, 200, { ok: true }); }
    if (p === '/api/settings' && req.method === 'POST') {
      const next = deepMerge(state.settings, await readBody(req));
      next.watchlist = [...new Set((next.watchlist || []).map(cleanSym).filter(Boolean))].slice(0, 200);
      next.timeframes = next.timeframes.filter(t => Y.TF_MS[t]);
      next.options.maxDte = Math.max(0, Math.min(1000, +next.options.maxDte || 60));
      state.settings = next; persist(); scheduleScan();
      refreshReports(false);
      return send(res, 200, { ok: true, settings: next });
    }
    if (p === '/api/backtest' && req.method === 'POST') {
      if (Object.values(jobs).some(j => j.status === 'running')) return send(res, 409, { error: 'Đang có backtest chạy' });
      const b = await readBody(req);
      const params = {
        scope: ['watchlist', 'list', 'nasdaq100', 'sp500', 'gainers'].includes(b.scope) ? b.scope : 'watchlist',
        topN: Math.max(1, Math.min(500, +b.topN || 30)), symbols: (b.symbols || []).map(cleanSym).filter(Boolean),
        timeframes: (b.timeframes || []).filter(t => Y.TF_MS[t]), modes: (b.modes || []).filter(m => m === 'fibo' || m === 'ema'),
        direction: ['long', 'short', 'both'].includes(b.direction) ? b.direction : 'long',
        days: Math.max(5, Math.min(729, +b.days || 59)), feePct: Math.max(0, Math.min(1, +b.feePct || 0)), flatAtClose: b.flatAtClose !== false,
      };
      if (!params.timeframes.length || !params.modes.length) return send(res, 400, { error: 'Chọn ít nhất 1 khung và 1 chế độ' });
      if (params.scope === 'list' && !params.symbols.length) return send(res, 400, { error: 'Nhập ít nhất 1 mã' });
      const job = { id: uid(), params, status: 'running', progress: 0, stage: 'Bắt đầu', errors: [], createdAt: Date.now() };
      jobs[job.id] = job; runBacktest(job);
      return send(res, 200, { id: job.id });
    }
    let m;
    if ((m = p.match(/^\/api\/backtest\/(\w+)$/))) {
      const job = jobs[m[1]];
      if (req.method === 'DELETE') {
        if (job) job.cancel = true;
        state.backtests = state.backtests.filter(b => b.id !== m[1]); persist();
        try { fs.unlinkSync(file('bt-' + m[1] + '.json')); } catch { /* */ }
        return send(res, 200, { ok: true });
      }
      if (job && job.status !== 'done') return send(res, 200, { id: job.id, status: job.status, progress: job.progress, stage: job.stage, error: job.error, params: job.params });
      const saved = load('bt-' + m[1] + '.json', null);
      return saved ? send(res, 200, { ...saved, status: 'done', progress: 1 }) : send(res, 404, { error: 'Không tìm thấy' });
    }
    if ((m = p.match(/^\/api\/tracked\/(\w+)\/remove$/)) && req.method === 'POST') { const t = state.tracked.find(x => x.id === m[1]); if (t) t.status = 'removed'; persist(); return send(res, 200, { ok: true }); }
    if (p === '/api/reports/refresh' && req.method === 'POST') { refreshReports(true); return send(res, 200, { ok: true }); }
    if (p === '/api/options/sweep' && req.method === 'POST') { sweepOptions(true); return send(res, 200, { ok: true }); }
    if (p === '/api/test-telegram' && req.method === 'POST') { await telegram('✅ Day Radar đã kết nối Telegram'); return send(res, 200, { ok: true }); }
    send(res, 404, { error: 'Không có' });
  } catch (e) { send(res, 500, { error: e.message }); }
});

let scanTimer;
function scheduleScan() { clearInterval(scanTimer); scanTimer = setInterval(() => scan(false), Math.max(1, state.settings.scanEveryMin) * 60e3); }

async function runOnce() {
  // Chế độ GitHub Actions: chạy 1 lượt rồi thoát; kết quả ghi vào DATA_DIR (public/data) để GitHub Pages hiển thị
  const t0 = Date.now();
  if (process.argv.includes('--backtest')) {
    const b = JSON.parse(process.env.BT_PARAMS || '{}');
    const params = {
      scope: ['watchlist', 'list', 'nasdaq100', 'sp500', 'gainers'].includes(b.scope) ? b.scope : 'watchlist',
      topN: Math.max(1, Math.min(500, +b.topN || 30)), symbols: String(b.symbols || '').split(/[\s,]+/).map(cleanSym).filter(Boolean),
      timeframes: String(b.timeframes || '15m,1h').split(/[\s,]+/).filter(t => Y.TF_MS[t]), modes: String(b.modes || 'fibo,ema').split(/[\s,]+/).filter(m => m === 'fibo' || m === 'ema'),
      direction: ['long', 'short', 'both'].includes(b.direction) ? b.direction : 'long',
      days: Math.max(5, Math.min(729, +b.days || 59)), feePct: Math.max(0, +b.feePct || 0), flatAtClose: b.flatAtClose !== 'false',
    };
    const job = { id: uid(), params, status: 'running', progress: 0, stage: '', errors: [], createdAt: Date.now() };
    await runBacktest(job);
    log('backtest:', job.status, job.error || '', job.result ? job.result.summary.trades + ' lệnh' : '');
    state.backtests = state.backtests.slice(0, 8); // giữ gọn cho GitHub Pages
  } else {
    await scan(process.argv.includes('--force'));
    await refreshReports(false);
    await sweepOptions(process.argv.includes('--force'));
  }
  persist(true);
  save('view.json', apiState());
  await Promise.allSettled(pendingSends);
  log(`xong trong ${((Date.now() - t0) / 1000).toFixed(0)} giây`);
  process.exit(0);
}

if (ONCE_MODE) runOnce().catch(e => { console.error(e); process.exit(1); });
else {
server.listen(PORT, () => {
  log(`Day Radar chạy tại http://localhost:${PORT}${DEMO ? '  (DỮ LIỆU MẪU)' : ''} · thị trường: ${M.session()}`);
  scheduleScan();
  scan(true);
  setTimeout(() => refreshReports(false), 3000);
  setTimeout(() => sweepOptions(false), 6000);
});
setInterval(() => refreshReports(false), 30 * 60e3);
setInterval(() => sweepOptions(false), 5 * 60e3);
}
