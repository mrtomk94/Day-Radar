// Báo cáo tự động cho từng mã: số liệu quý gần nhất, so với dự báo, dự báo quý tới, ngày báo cáo tới.
// Nguồn: Yahoo Finance quoteSummary (cần cookie + "crumb", lấy tự động). Không có phân khúc và hướng dẫn của công ty.
// Phần "đánh giá" là luật cố định dựa trên con số, không phải ý kiến chuyên gia.
'use strict';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MODULES = ['price', 'financialData', 'earnings', 'earningsHistory', 'earningsTrend', 'calendarEvents', 'defaultKeyStatistics', 'summaryDetail'];

let session = null; // { cookie, crumb, at }

async function getSession(force = false) {
  if (!force && session && Date.now() - session.at < 6 * 3600e3) return session;
  const r1 = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(15000) }).catch(() => null);
  const set = r1 && (r1.headers.getSetCookie ? r1.headers.getSetCookie() : [r1.headers.get('set-cookie')].filter(Boolean));
  const cookie = (set || []).map(c => c.split(';')[0]).join('; ');
  const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie }, signal: AbortSignal.timeout(15000) });
  const crumb = (await r2.text()).trim();
  if (!r2.ok || !crumb || crumb.length > 40 || crumb.includes('<')) throw new Error('Không lấy được mã xác thực (crumb) của Yahoo');
  session = { cookie, crumb, at: Date.now() };
  return session;
}

async function quoteSummary(symbol) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await getSession(attempt > 0);
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${MODULES.join(',')}&crumb=${encodeURIComponent(s.crumb)}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA, Cookie: s.cookie, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (res.status === 401 || res.status === 403) continue; // crumb hết hạn -> lấy lại
    const body = await res.json().catch(() => null);
    const r = body?.quoteSummary?.result?.[0];
    if (!r) throw new Error(body?.quoteSummary?.error?.description || 'Yahoo HTTP ' + res.status);
    return r;
  }
  throw new Error('Yahoo từ chối xác thực');
}

const raw = v => (v && typeof v === 'object' && 'raw' in v) ? v.raw : (typeof v === 'number' ? v : null);
const pctChange = (a, b) => (a != null && b) ? (a / Math.abs(b) - 1) * 100 : null;

// Chuyển dữ liệu Yahoo thành báo cáo gọn
function build(symbol, r, now = Date.now()) {
  const fd = r.financialData || {}, pr = r.price || {}, ks = r.defaultKeyStatistics || {}, sd = r.summaryDetail || {};
  const hist = (r.earningsHistory?.history || []).map(h => ({
    quarter: h.quarter?.fmt || null, period: h.period, actual: raw(h.epsActual), estimate: raw(h.epsEstimate), surprise: raw(h.surprisePercent),
  })).filter(h => h.actual != null).sort((a, b) => String(a.quarter).localeCompare(String(b.quarter)));
  const qChart = (r.earnings?.financialsChart?.quarterly || []).map(q => ({ label: q.date, revenue: raw(q.revenue), earnings: raw(q.earnings) }));
  const trend = Object.fromEntries((r.earningsTrend?.trend || []).map(t => [t.period, {
    end: t.endDate, epsAvg: raw(t.earningsEstimate?.avg), epsYearAgo: raw(t.earningsEstimate?.yearAgoEps), epsGrowth: raw(t.earningsEstimate?.growth),
    revAvg: raw(t.revenueEstimate?.avg), revYearAgo: raw(t.revenueEstimate?.yearAgoRevenue), revGrowth: raw(t.revenueEstimate?.growth),
    analysts: raw(t.earningsEstimate?.numberOfAnalysts), up30: raw(t.epsRevisions?.upLast30days), down30: raw(t.epsRevisions?.downLast30days),
  }]));
  const nextDates = (r.calendarEvents?.earnings?.earningsDate || []).map(raw).filter(Boolean).map(s => s * 1000);
  const last = hist[hist.length - 1] || null;
  const lastQ = qChart[qChart.length - 1] || null;

  const out = {
    symbol, at: now,
    name: pr.shortName || pr.longName || symbol,
    price: raw(pr.regularMarketPrice), changePct: raw(pr.regularMarketChangePercent) != null ? raw(pr.regularMarketChangePercent) * 100 : null,
    marketCap: raw(pr.marketCap),
    lastQuarter: last ? last.quarter : (lastQ && lastQ.label),
    revenueQ: lastQ ? lastQ.revenue : null, revenueQLabel: lastQ ? lastQ.label : null,
    revenueGrowth: raw(fd.revenueGrowth) != null ? raw(fd.revenueGrowth) * 100 : null,        // quý gần nhất so với cùng kỳ
    earningsGrowth: raw(fd.earningsGrowth) != null ? raw(fd.earningsGrowth) * 100 : null,
    eps: last, epsHistory: hist, revenueHistory: qChart,
    grossMargin: raw(fd.grossMargins) != null ? raw(fd.grossMargins) * 100 : null,             // 12 tháng
    operatingMargin: raw(fd.operatingMargins) != null ? raw(fd.operatingMargins) * 100 : null,
    profitMargin: raw(fd.profitMargins) != null ? raw(fd.profitMargins) * 100 : null,
    revenueTTM: raw(fd.totalRevenue), fcf: raw(fd.freeCashflow), ocf: raw(fd.operatingCashflow), cash: raw(fd.totalCash), debt: raw(fd.totalDebt),
    targetMean: raw(fd.targetMeanPrice), targetHigh: raw(fd.targetHighPrice), targetLow: raw(fd.targetLowPrice),
    recommendation: fd.recommendationKey || null, analysts: raw(fd.numberOfAnalystOpinions),
    forwardPE: raw(ks.forwardPE) ?? raw(sd.forwardPE), trailingPE: raw(sd.trailingPE),
    nextQ: trend['+1q'] || null, curQ: trend['0q'] || null, curY: trend['0y'] || null, nextY: trend['+1y'] || null,
    nextEarnings: nextDates.find(t => t > now - 86400e3) || null,
  };
  Object.assign(out, assess(out));
  return out;
}

// Luật đánh giá: cộng/trừ điểm theo từng tín hiệu, mỗi tín hiệu tạo 1 dòng lạc quan hoặc rủi ro
function assess(x) {
  const bull = [], bear = [];
  let score = 0;
  const f1 = v => v == null ? '–' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
  const e = x.eps;
  if (e && e.estimate != null) {
    const s = e.surprise != null ? e.surprise * 100 : pctChange(e.actual, e.estimate);
    if (s >= 2) { score++; bull.push(['EPS vượt dự báo', `EPS ${e.actual.toFixed(2)} so với dự báo ${e.estimate.toFixed(2)} (${f1(s)}).`]); }
    else if (s <= -2) { score--; bear.push(['EPS hụt dự báo', `EPS ${e.actual.toFixed(2)} so với dự báo ${e.estimate.toFixed(2)} (${f1(s)}).`]); }
  }
  const misses = x.epsHistory.slice(-4).filter(h => h.surprise != null && h.surprise < 0).length;
  const beats = x.epsHistory.slice(-4).filter(h => h.surprise != null && h.surprise > 0).length;
  if (x.epsHistory.length >= 4 && beats === 4) { score++; bull.push(['Vượt dự báo đều đặn', 'EPS vượt dự báo cả 4 quý gần nhất.']); }
  if (misses >= 2) { score--; bear.push(['Hay hụt dự báo', `EPS hụt dự báo ${misses} trong 4 quý gần nhất.`]); }
  if (x.revenueGrowth != null) {
    if (x.revenueGrowth >= 15) { score++; bull.push(['Doanh thu tăng nhanh', `Doanh thu quý gần nhất ${f1(x.revenueGrowth)} so với cùng kỳ.`]); }
    else if (x.revenueGrowth < 0) { score--; bear.push(['Doanh thu giảm', `Doanh thu quý gần nhất ${f1(x.revenueGrowth)} so với cùng kỳ.`]); }
  }
  if (x.operatingMargin != null) {
    if (x.operatingMargin >= 25) bull.push(['Biên lợi nhuận cao', `Biên hoạt động 12 tháng ${x.operatingMargin.toFixed(1)}%.`]);
    else if (x.operatingMargin < 0) { score--; bear.push(['Đang lỗ hoạt động', `Biên hoạt động 12 tháng ${x.operatingMargin.toFixed(1)}%.`]); }
  }
  if (x.fcf != null) {
    if (x.fcf < 0) { score--; bear.push(['Dòng tiền tự do âm', `FCF 12 tháng ${money(x.fcf)}.`]); }
    else if (x.revenueTTM && x.fcf / x.revenueTTM >= 0.15) bull.push(['Dòng tiền mạnh', `FCF 12 tháng ${money(x.fcf)} (${(x.fcf / x.revenueTTM * 100).toFixed(0)}% doanh thu).`]);
  }
  const nq = x.nextQ;
  if (nq && nq.revGrowth != null) {
    const g = nq.revGrowth * 100;
    if (g >= 15) { score++; bull.push(['Giới phân tích kỳ vọng tăng tiếp', `Dự báo doanh thu quý tới ${f1(g)} so với cùng kỳ.`]); }
    else if (g < 0) { score--; bear.push(['Dự báo quý tới đi xuống', `Giới phân tích dự báo doanh thu quý tới ${f1(g)}.`]); }
  }
  const cq = x.curQ || nq;
  if (cq && cq.up30 != null && cq.down30 != null) {
    if (cq.up30 > cq.down30 + 1) { score++; bull.push(['Dự báo đang được nâng', `30 ngày qua: ${cq.up30} lần nâng, ${cq.down30} lần hạ dự báo EPS.`]); }
    else if (cq.down30 > cq.up30 + 1) { score--; bear.push(['Dự báo đang bị hạ', `30 ngày qua: ${cq.down30} lần hạ, ${cq.up30} lần nâng dự báo EPS.`]); }
  }
  if (x.debt != null && x.cash != null && x.debt > x.cash * 2 && x.debt > 5e9) bear.push(['Nợ cao', `Nợ ${money(x.debt)} so với tiền mặt ${money(x.cash)}.`]);
  if (x.forwardPE != null && x.forwardPE > 60) bear.push(['Định giá cao', `P/E dự phóng ${x.forwardPE.toFixed(0)} lần.`]);
  if (x.targetMean && x.price) {
    const up = (x.targetMean / x.price - 1) * 100;
    if (up >= 15) bull.push(['Giá mục tiêu cao hơn', `Giá mục tiêu trung bình ${x.targetMean.toFixed(2)} (${f1(up)} so với giá hiện tại).`]);
    else if (up <= -5) bear.push(['Giá đã vượt mục tiêu', `Giá mục tiêu trung bình ${x.targetMean.toFixed(2)} (${f1(up)}).`]);
  }
  const view = score >= 3 ? 'pos' : score >= 1 ? 'mix' : score === 0 ? 'caut' : 'neg';
  const viewLabel = { pos: 'TÍCH CỰC', mix: 'LẪN LỘN', caut: 'THẬN TRỌNG', neg: 'TIÊU CỰC' }[view];
  return { score, view, viewLabel, bull: bull.slice(0, 5), bear: bear.slice(0, 4) };
}

function money(v) {
  if (v == null) return '–';
  const a = Math.abs(v), s = v < 0 ? '−$' : '$';
  if (a >= 1e12) return s + (a / 1e12).toFixed(2) + ' nghìn tỷ';
  if (a >= 1e9) return s + (a / 1e9).toFixed(2) + ' tỷ';
  if (a >= 1e6) return s + (a / 1e6).toFixed(1) + ' triệu';
  return s + a.toFixed(0);
}

async function report(symbol) { return build(symbol, await quoteSummary(symbol)); }

module.exports = { report, build, assess, quoteSummary, getSession, money };
