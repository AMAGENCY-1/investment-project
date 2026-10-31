// Shared market helpers: price speed from candles, BRTI calibration, bar shaping.
const { num, median } = require('./_lib');

const rms = (a) => (a.length ? Math.sqrt(a.reduce((t, x) => t + x * x, 0) / a.length) : null);

// Coinbase candles arrive newest first as [time, low, high, open, close, volume].
const ascending = (candles) => (candles || []).slice().sort((a, b) => a[0] - b[0]);

// Output bars as [time, open, high, low, close], oldest first.
function toBars(candles, keep) {
  return ascending(candles).slice(-keep).map((r) => [r[0], r[3], r[2], r[1], r[4]]);
}

// "Speed" = typical dollar move per minute, from 1-minute closes.
function speedFromCandles(candles) {
  const c = ascending(candles);
  const closes = c.map((r) => r[4]);
  const diffs = closes.slice(1).map((v, i) => v - closes[i]);
  const last = (n) => diffs.slice(-n);
  const price = closes[closes.length - 1] || null;
  const rows30 = c.slice(-30).filter((r) => r[2] > 0 && r[1] > 0);
  const park30 = rows30.length && price
    ? Math.sqrt(rows30.reduce((t, r) => t + Math.log(r[2] / r[1]) ** 2, 0) / rows30.length / (4 * Math.log(2))) * price
    : null;
  return { price, m15: rms(last(15)), m30: rms(last(30)), m60: rms(last(60)), m120: rms(last(120)), park30 };
}

// Kalshi settles on CF Benchmarks BRTI, which runs a few dollars off Coinbase.
// Each window's target is the BRTI average of the minute before it opened, so
// comparing recent targets with Coinbase's candle for that minute measures the gap.
function calibrate(markets, candles, nowMs) {
  const bars = new Map((candles || []).map((r) => [r[0], r]));
  const points = [];
  for (const m of markets || []) {
    const target = num(m.floor_strike);
    const openMs = Date.parse(m.open_time);
    if (!Number.isFinite(target) || !(openMs <= nowMs)) continue;
    const r = bars.get(openMs / 1000 - 60);
    if (!r) continue;
    const avg = (r[1] + r[2] + r[3] + r[4]) / 4;
    points.push({ open: m.open_time, target, basis: target - avg });
  }
  points.sort((a, b) => Date.parse(b.open) - Date.parse(a.open));
  const use = points.slice(0, 8);
  if (!use.length) return null;
  const basis = median(use.map((p) => p.basis));
  const spread = use.length > 1 ? Math.sqrt(use.reduce((t, p) => t + (p.basis - basis) ** 2, 0) / (use.length - 1)) : null;
  return { basis, spread, n: use.length };
}

module.exports = { toBars, speedFromCandles, calibrate };
