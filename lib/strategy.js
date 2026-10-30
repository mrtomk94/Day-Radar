// Chiến lược Pullback: tìm sóng đẩy mạnh, đặt 3 lệnh chờ ở vùng hồi (Fibo hoặc EMA),
// SL dưới Fibo 0.618 (hoặc % dưới EMA), TP ở đỉnh sóng.
// Dùng chung cho: quét tín hiệu, theo dõi lệnh và backtest, để kết quả nhất quán.
'use strict';

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function emaSet(candles, periods) {
  const closes = candles.map(c => c.c);
  const map = {};
  for (const p of periods) map[p] = ema(closes, p);
  return map;
}

// Tìm sóng kết thúc ở nến h (đỉnh với long, đáy với short).
// Chân sóng = cực trị ngược lại trong `lookback` nến trước đó.
function waveEndingAt(candles, h, cfg, dir) {
  const lb = cfg.waveLookback;
  const from = Math.max(0, h - lb + 1);
  if (dir === 'long') {
    let l = from;
    for (let k = from; k <= h; k++) if (candles[k].l < candles[l].l) l = k;
    if (l >= h) return null;
    const H = candles[h].h, L = candles[l].l;
    const move = H / L - 1;
    return { dir, peakIdx: h, footIdx: l, H, L, move };
  } else {
    let l = from;
    for (let k = from; k <= h; k++) if (candles[k].h > candles[l].h) l = k;
    if (l >= h) return null;
    const L = candles[h].l, H = candles[l].h;
    const move = 1 - L / H;
    return { dir, peakIdx: h, footIdx: l, H, L, move };
  }
}

function minMove(cfg, dir) {
  return dir === 'long' ? cfg.minPumpPct / 100 : cfg.minDumpPct / 100;
}

// Tính các mức vào lệnh / SL / TP cho một sóng.
function levelsFor(wave, cfg, mode, emas, idx) {
  const { H, L, dir } = wave;
  const D = H - L;
  let entries, sl, labels;
  if (mode === 'fibo') {
    const rs = cfg.fibo.entries;
    labels = rs.map(r => 'Fib ' + r);
    if (dir === 'long') {
      entries = rs.map(r => H - D * r);
      sl = H - D * cfg.fibo.sl;
    } else {
      entries = rs.map(r => L + D * r);
      sl = L + D * cfg.fibo.sl;
    }
  } else {
    const ps = cfg.ema.periods;
    const vals = ps.map(p => emas[p] && emas[p][idx]).filter(v => v != null);
    if (vals.length !== ps.length) return null;
    labels = ps.map(p => 'EMA ' + p);
    entries = vals.slice();
    const slp = cfg.ema.slPct / 100;
    if (dir === 'long') {
      if (entries.some(e => e >= H)) return null;
      const lowest = Math.min(...entries);
      sl = lowest * (1 - slp);
    } else {
      if (entries.some(e => e <= L)) return null;
      const highest = Math.max(...entries);
      sl = highest * (1 + slp);
    }
    // sắp theo thứ tự gặp trước khi giá hồi
    const pairs = entries.map((e, i) => [e, labels[i]]);
    pairs.sort((a, b) => dir === 'long' ? b[0] - a[0] : a[0] - b[0]);
    entries = pairs.map(p => p[0]);
    labels = pairs.map(p => p[1]);
  }
  const tp = dir === 'long' ? H : L;
  return { entries, labels, sl, tp };
}

// Ở nến i (đã đóng), kiểm tra đỉnh/đáy ở nến i-confirm vừa được xác nhận.
function setupAt(candles, i, cfg, mode, dir, emas) {
  const conf = Math.max(1, cfg.confirmBars | 0);
  const h = i - conf;
  if (h < cfg.waveLookback) return null;
  const from = Math.max(0, h - cfg.waveLookback + 1);
  if (dir === 'long') {
    const H = candles[h].h;
    for (let k = from; k <= i; k++) if (k !== h && candles[k].h >= H && k > h) return null;
    for (let k = from; k < h; k++) if (candles[k].h > H) return null;
  } else {
    const L = candles[h].l;
    for (let k = from; k <= i; k++) if (k !== h && candles[k].l <= L && k > h) return null;
    for (let k = from; k < h; k++) if (candles[k].l < L) return null;
  }
  const wave = waveEndingAt(candles, h, cfg, dir);
  if (!wave || wave.move < minMove(cfg, dir)) return null;
  const lv = levelsFor(wave, cfg, mode, emas, i);
  if (!lv) return null;
  // nếu giá đã thủng SL trong lúc chờ xác nhận thì bỏ
  for (let k = h + 1; k <= i; k++) {
    if (dir === 'long' && candles[k].l <= lv.sl) return null;
    if (dir === 'short' && candles[k].h >= lv.sl) return null;
  }
  return {
    mode, dir,
    createdIdx: i,
    createdTime: candles[i].t,
    day: candles[i].d || null,
    intraday: !!cfg.flatAtClose && !!candles[i].d,
    peakTime: candles[h].t,
    footTime: candles[wave.footIdx].t,
    H: wave.H, L: wave.L, move: wave.move,
    entries: lv.entries.map((p, k) => ({ label: lv.labels[k], price: p, filled: false, fillPrice: null, fillTime: null })),
    sl: lv.sl, tp: lv.tp,
  };
}

// Mô phỏng một setup trên các nến từ startIdx trở đi. Trả về trạng thái hiện tại.
// Quy ước thận trọng: cùng một nến vừa chạm SL vừa chạm TP thì tính SL;
// nến vừa khớp lệnh thì không tính TP trong chính nến đó.
function simulate(setup, candles, startIdx, cfg) {
  const s = JSON.parse(JSON.stringify(setup));
  s.status = 'waiting';
  const long = s.dir === 'long';
  const fee = (cfg.feePct || 0) / 100;
  let barsWaiting = 0, firstFillIdx = null;
  for (let j = startIdx; j < candles.length; j++) {
    const b = candles[j];
    // day trade: sang phiên mới thì đóng lệnh ở giá đóng cửa phiên trước, huỷ lệnh chưa khớp
    if (s.intraday && b.d !== s.day) {
      const prev = candles[j - 1];
      if (s.entries.some(e => e.filled)) {
        s.status = 'eod'; s.exitPrice = prev.c; s.exitTime = prev.t; s.exitIdx = j - 1;
        s.barsHeld = j - firstFillIdx;
      } else { s.status = 'expired'; s.reason = 'Hết phiên chưa khớp'; s.exitTime = prev.t; s.exitIdx = j - 1; }
      return finalize(s, fee);
    }
    const anyFilled = s.entries.some(e => e.filled);
    if (!anyFilled) {
      // sóng kéo dài -> huỷ setup cũ
      if ((long && b.h > s.tp) || (!long && b.l < s.tp)) {
        // trừ khi nến mở cửa đã nằm dưới E1 (khớp trước rồi mới vượt) - coi như huỷ cho thận trọng
        s.status = 'cancelled'; s.reason = 'Sóng kéo dài'; s.exitTime = b.t; s.exitIdx = j;
        return finalize(s, fee);
      }
      barsWaiting++;
      if (barsWaiting > cfg.expiryBars) {
        s.status = 'expired'; s.reason = 'Quá hạn chờ khớp'; s.exitTime = b.t; s.exitIdx = j;
        return finalize(s, fee);
      }
    }
    let filledNow = false;
    for (const e of s.entries) {
      if (e.filled) continue;
      if (long ? b.l <= e.price : b.h >= e.price) {
        e.filled = true;
        e.fillPrice = long ? Math.min(e.price, b.o) : Math.max(e.price, b.o);
        e.fillTime = b.t;
        filledNow = true;
        if (firstFillIdx == null) firstFillIdx = j;
      }
    }
    if (!s.entries.some(e => e.filled)) continue;
    s.status = 'open';
    const hitSL = long ? b.l <= s.sl : b.h >= s.sl;
    if (hitSL) {
      s.status = 'sl';
      s.exitPrice = long ? Math.min(s.sl, b.o) : Math.max(s.sl, b.o);
      s.exitTime = b.t; s.exitIdx = j;
      s.barsHeld = j - firstFillIdx + 1;
      return finalize(s, fee);
    }
    const hitTP = long ? b.h >= s.tp : b.l <= s.tp;
    if (hitTP && !filledNow) {
      s.status = 'tp';
      s.exitPrice = long ? Math.max(s.tp, b.o) : Math.min(s.tp, b.o);
      s.exitTime = b.t; s.exitIdx = j;
      s.barsHeld = j - firstFillIdx + 1;
      return finalize(s, fee);
    }
  }
  if (firstFillIdx != null) s.barsHeld = candles.length - firstFillIdx;
  return finalize(s, fee);
}

function avgEntry(s) {
  const f = s.entries.filter(e => e.filled);
  if (!f.length) return null;
  return f.reduce((a, e) => a + e.fillPrice, 0) / f.length; // khối lượng bằng nhau mỗi mức (theo USD)
}

function finalize(s, fee) {
  s.avg = avgEntry(s);
  s.filledCount = s.entries.filter(e => e.filled).length;
  if (s.avg != null && (s.status === 'tp' || s.status === 'sl' || s.status === 'eod')) {
    const gross = s.dir === 'long' ? s.exitPrice / s.avg - 1 : 1 - s.exitPrice / s.avg;
    s.pnlPct = (gross - 2 * fee) * 100;
    const risk = Math.abs(s.avg - s.sl) / s.avg;
    s.R = risk > 0 ? (gross - 2 * fee) / risk : 0;
  }
  return s;
}

// Chạy chiến lược trên toàn bộ chuỗi nến (backtest). Không nhìn trước tương lai.
function runSeries(candles, cfg, mode, dir) {
  const emas = mode === 'ema' ? emaSet(candles, cfg.ema.periods) : null;
  const trades = [];
  let cancelled = 0, setups = 0;
  let i = cfg.waveLookback + 2;
  while (i < candles.length - 1) {
    const st = setupAt(candles, i, cfg, mode, dir, emas);
    if (!st) { i++; continue; }
    setups++;
    const r = simulate(st, candles, i + 1, cfg);
    if (r.status === 'tp' || r.status === 'sl' || r.status === 'eod') {
      trades.push(r);
      i = r.exitIdx + 1;
    } else if (r.status === 'cancelled' || r.status === 'expired') {
      cancelled++;
      i = r.exitIdx; // cho phép setup mới hình thành ngay tại nến đó
      if (i <= st.createdIdx) i = st.createdIdx + 1;
    } else {
      break; // còn mở ở cuối dữ liệu
    }
  }
  return { trades, setups, cancelled };
}

// Tín hiệu "đang diễn ra" để hiển thị ở tab Tín hiệu (bao gồm sóng chưa xác nhận đỉnh).
function liveSignal(candles, cfg, mode, dir) {
  const n = candles.length;
  if (n < cfg.waveLookback + 5) return null;
  const from = n - cfg.waveLookback;
  let h = from;
  for (let k = from; k < n; k++) {
    if (dir === 'long' ? candles[k].h >= candles[h].h : candles[k].l <= candles[h].l) h = k;
  }
  const age = n - 1 - h;
  if (age > cfg.maxSignalAge) return null;
  if (cfg.flatAtClose && candles[h].d && candles[h].d !== candles[n - 1].d) return null; // đỉnh của phiên trước
  const wave = waveEndingAt(candles, h, cfg, dir);
  if (!wave || wave.move < minMove(cfg, dir)) return null;
  const emas = mode === 'ema' ? emaSet(candles, cfg.ema.periods) : null;
  const lv = levelsFor(wave, cfg, mode, emas, n - 1);
  if (!lv) return null;
  let ext = dir === 'long' ? Infinity : -Infinity;
  for (let k = h + 1; k < n; k++) ext = dir === 'long' ? Math.min(ext, candles[k].l) : Math.max(ext, candles[k].h);
  const touched = p => dir === 'long' ? ext <= p : ext >= p;
  if (h < n - 1 && touched(lv.sl)) return null; // đã thủng SL -> hỏng
  const price = candles[n - 1].c;
  let phase;
  if (age === 0) phase = 'Đang đẩy';
  else if (touched(lv.entries[0])) phase = 'Đang hồi';
  else phase = 'Chờ hồi';
  return {
    mode, dir, phase, age, price,
    peakTime: candles[h].t, footTime: candles[wave.footIdx].t,
    H: wave.H, L: wave.L, move: wave.move,
    entries: lv.entries.map((p, k) => ({ label: lv.labels[k], price: p, touched: h < n - 1 && touched(p) })),
    sl: lv.sl, tp: lv.tp,
    barsFromFoot: n - 1 - wave.footIdx,
  };
}

// Setup đã xác nhận gần đây (để đưa vào danh sách Theo dõi).
function recentSetups(candles, cfg, mode, dir, withinBars) {
  const emas = mode === 'ema' ? emaSet(candles, cfg.ema.periods) : null;
  const out = [];
  const closedN = candles.length - 1; // nến cuối đang chạy, không dùng để xác nhận
  for (let i = Math.max(cfg.waveLookback + 2, closedN - withinBars); i < closedN; i++) {
    const st = setupAt(candles, i, cfg, mode, dir, emas);
    if (st) out.push(st);
  }
  return out;
}

function stats(trades, extra = {}) {
  const n = trades.length;
  const wins = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct <= 0);
  const sum = a => a.reduce((x, t) => x + t.pnlPct, 0);
  const grossW = sum(wins), grossL = -sum(losses);
  const sorted = trades.slice().sort((a, b) => a.exitTime - b.exitTime);
  let cum = 0, peak = 0, mdd = 0, streak = 0, maxStreak = 0;
  const curve = [];
  for (const t of sorted) {
    cum += t.pnlPct;
    peak = Math.max(peak, cum);
    mdd = Math.min(mdd, cum - peak);
    if (t.pnlPct <= 0) { streak++; maxStreak = Math.max(maxStreak, streak); } else streak = 0;
    curve.push([t.exitTime, +cum.toFixed(2)]);
  }
  return {
    trades: n,
    tp: trades.filter(t => t.status === 'tp').length,
    sl: trades.filter(t => t.status === 'sl').length,
    eod: trades.filter(t => t.status === 'eod').length,
    wins: wins.length, losses: losses.length,
    winRate: n ? wins.length / n * 100 : 0,
    avgPct: n ? sum(trades) / n : 0,
    avgWin: wins.length ? grossW / wins.length : 0,
    avgLoss: losses.length ? -grossL / losses.length : 0,
    profitFactor: grossL > 0 ? grossW / grossL : (grossW > 0 ? Infinity : 0),
    totalPct: cum,
    maxDD: mdd,
    maxLosingStreak: maxStreak,
    avgR: n ? trades.reduce((a, t) => a + (t.R || 0), 0) / n : 0,
    avgBars: n ? trades.reduce((a, t) => a + (t.barsHeld || 0), 0) / n : 0,
    curve,
    ...extra,
  };
}

// Đóng cưỡng bức ở giá cuối (dùng khi phiên đã kết thúc mà chưa có nến phiên sau)
function forceClose(s, last, cfg) {
  const fee = (cfg.feePct || 0) / 100;
  if (s.entries.some(e => e.filled)) { s.status = 'eod'; s.exitPrice = last.c; s.exitTime = last.t; }
  else { s.status = 'expired'; s.reason = 'Hết phiên chưa khớp'; s.exitTime = last.t; }
  return finalize(s, fee);
}

module.exports = { forceClose, ema, emaSet, setupAt, simulate, runSeries, liveSignal, recentSetups, stats, avgEntry };
