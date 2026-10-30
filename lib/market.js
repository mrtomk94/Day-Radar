// Giờ thị trường chứng khoán Mỹ (giờ New York). Chưa tính ngày lễ: ngày lễ app vẫn quét nhưng không có nến mới.
'use strict';

const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false });

function ny(t = Date.now()) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map(x => [x.type, x.value]));
  const hour = +p.hour % 24, minute = +p.minute;
  return { date: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, hour, minute, mins: hour * 60 + minute };
}

const nyDate = t => ny(t).date;

// 'pre' 4:00-9:30, 'open' 9:30-16:00, 'post' 16:00-20:00, 'closed'
function session(t = Date.now()) {
  const n = ny(t);
  if (n.weekday === 'Sat' || n.weekday === 'Sun') return 'closed';
  if (n.mins >= 570 && n.mins < 960) return 'open';
  if (n.mins >= 240 && n.mins < 570) return 'pre';
  if (n.mins >= 960 && n.mins < 1200) return 'post';
  return 'closed';
}

module.exports = { ny, nyDate, session };
