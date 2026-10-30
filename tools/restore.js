// Tải dữ liệu lần chạy trước từ trang GitHub Pages về public/data (giống cách Ripple giữ events.json).
'use strict';
const fs = require('fs');
const path = require('path');
const base = (process.argv[2] || '').replace(/\/$/, '');
const dir = path.join(__dirname, '..', 'public', 'data');
fs.mkdirSync(dir, { recursive: true });
(async () => {
  if (!base) { console.log('Chưa có địa chỉ Pages, bỏ qua (lần chạy đầu)'); return; }
  const get = async name => {
    try {
      const r = await fetch(`${base}/data/${name}?t=${Date.now()}`, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) return null;
      const text = await r.text();
      JSON.parse(text); // chỉ ghi khi là JSON hợp lệ
      fs.writeFileSync(path.join(dir, name), text);
      return JSON.parse(text);
    } catch { return null; }
  };
  const state = await get('state.json');
  if (!state) { console.log('Chưa có dữ liệu cũ (lần chạy đầu)'); return; }
  for (const b of (state.backtests || []).slice(0, 8)) await get(`bt-${b.id}.json`);
  console.log(`Đã khôi phục: ${(state.tracked || []).length} setup, ${(state.backtests || []).length} backtest`);
})();
