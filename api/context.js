// Slow feed (polled every ~15s): how fast BTC is moving, spot order-book depth,
// taker flow, derivatives funding / open interest, and recent liquidations.
const { getJSON, settle, num, median, send, allowGet, KALSHI, SERIES } = require('./_lib');

const rms = (a) => (a.length ? Math.sqrt(a.reduce((t, x) => t + x * x, 0) / a.length) : null);

function speedFromCandles(candles) {
  // Coinbase candles: [time, low, high, open, close, volume], newest first.
  const c = (candles || []).slice().sort((a, b) => a[0] - b[0]);
  const closes = c.map((r) => r[4]);
  const diffs = closes.slice(1).map((v, i) => v - closes[i]);
  const last = (n) => diffs.slice(-n);
  const price = closes[closes.length - 1] || null;
  // Parkinson estimator from each minute's high/low (uses intraminute range).
  const park = (n) => {
    const rows = c.slice(-n).filter((r) => r[2] > 0 && r[1] > 0);
    if (!rows.length || !price) return null;
    const v = rows.reduce((t, r) => t + Math.log(r[2] / r[1]) ** 2, 0) / rows.length / (4 * Math.log(2));
    return Math.sqrt(v) * price;
  };
  return {
    price,
    m15: rms(last(15)),
    m30: rms(last(30)),
    m60: rms(last(60)),
    m120: rms(last(120)),
    park30: park(30),
    bars: c.slice(-90).map((r) => [r[0], r[3], r[2], r[1], r[4]]), // [t, o, h, l, c]
  };
}

function depth(bids, asks, mid) {
  const bands = [0.0005, 0.001, 0.0025, 0.005];
  return bands.map((b) => {
    const lo = mid * (1 - b), hi = mid * (1 + b);
    const bid = bids.reduce((t, [p, q]) => (p >= lo ? t + q : t), 0);
    const ask = asks.reduce((t, [p, q]) => (p <= hi ? t + q : t), 0);
    return { band: b, bid, ask, imbalance: bid + ask ? (bid - ask) / (bid + ask) : 0 };
  });
}

function takerFlow(trades, nowMs) {
  // Coinbase reports the MAKER side: side "sell" means a taker bought.
  const win = (sec) => {
    let buy = 0, sell = 0;
    for (const t of trades) {
      const age = (nowMs - Date.parse(t.time)) / 1000;
      if (age > sec) continue;
      const q = Number(t.size);
      if (t.side === 'sell') buy += q; else sell += q;
    }
    return { buy, sell };
  };
  const oldest = trades.length ? (nowMs - Date.parse(trades[trades.length - 1].time)) / 1000 : 0;
  return { m1: win(60), m5: win(300), coverageSec: Math.round(oldest) };
}

function liquidations(trades, nowMs) {
  // Deribit BTC-PERPETUAL: amount is USD; `liquidation` marks which side was forced out.
  let longUsd = 0, shortUsd = 0, count = 0;
  const recent = [];
  for (const t of trades || []) {
    if (!t.liquidation) continue;
    if (nowMs - t.timestamp > 15 * 60 * 1000) continue;
    const takerBuy = t.direction === 'buy';
    const sides = [];
    if (t.liquidation.includes('T')) sides.push(takerBuy ? 'short' : 'long');
    if (t.liquidation.includes('M')) sides.push(takerBuy ? 'long' : 'short');
    for (const s of sides) {
      if (s === 'long') longUsd += t.amount; else shortUsd += t.amount;
      count += 1;
      recent.push({ t: t.timestamp, side: s, usd: t.amount, price: t.price });
    }
  }
  return { windowMin: 15, longUsd, shortUsd, count, recent: recent.slice(0, 8) };
}

// Kalshi settles on CF Benchmarks BRTI, which runs a few dollars off Coinbase.
// Each window's target is the BRTI average of the minute before it opened, so
// comparing recent targets with Coinbase's candle for that minute measures the gap.
function calibrate(markets, candles, nowMs) {
  const bars = new Map((candles || []).map((r) => [r[0], r])); // [time, low, high, open, close, volume]
  const points = [];
  for (const m of markets || []) {
    const target = num(m.floor_strike);
    const openMs = Date.parse(m.open_time);
    if (!Number.isFinite(target) || !(openMs <= nowMs)) continue;
    const r = bars.get(openMs / 1000 - 60);
    if (!r) continue;
    const avg = (r[1] + r[2] + r[3] + r[4]) / 4;
    points.push({ open: m.open_time, target, cbAvg: avg, basis: target - avg });
  }
  points.sort((a, b) => Date.parse(b.open) - Date.parse(a.open));
  const use = points.slice(0, 8);
  if (!use.length) return null;
  const basis = median(use.map((p) => p.basis));
  const spread = use.length > 1 ? Math.sqrt(use.reduce((t, p) => t + (p.basis - basis) ** 2, 0) / (use.length - 1)) : null;
  return { basis, spread, n: use.length, points: use };
}

module.exports = async (req, res) => {
  if (!allowGet(req, res)) return;
  const now = Date.now();
  const { out, errors } = await settle({
    candles: getJSON('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60'),
    recent: getJSON(`${KALSHI}/markets?series_ticker=${SERIES}&min_close_ts=${Math.floor(now / 1000) - 7200}&max_close_ts=${Math.floor(now / 1000) + 1800}&limit=20`),
    cbBook: getJSON('https://api.exchange.coinbase.com/products/BTC-USD/book?level=2', { timeout: 7000 }),
    krBook: getJSON('https://api.kraken.com/0/public/Depth?pair=XBTUSD&count=500'),
    trades: getJSON('https://api.exchange.coinbase.com/products/BTC-USD/trades?limit=1000'),
    perp: getJSON('https://www.deribit.com/api/v2/public/ticker?instrument_name=BTC-PERPETUAL'),
    perpTrades: getJSON('https://www.deribit.com/api/v2/public/get_last_trades_by_instrument?instrument_name=BTC-PERPETUAL&count=1000'),
    dvol: getJSON('https://www.deribit.com/api/v2/public/get_index_price?index_name=btcdvol_usdc'),
    hl: getJSON('https://api.hyperliquid.xyz/info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    }),
  });

  const speed = out.candles ? speedFromCandles(out.candles) : null;
  const ref = (speed && speed.price) || null;

  // Spot depth: Coinbase + Kraken combined.
  let book = null;
  try {
    const bids = [], asks = [];
    if (out.cbBook) {
      out.cbBook.bids.forEach(([p, q]) => bids.push([+p, +q]));
      out.cbBook.asks.forEach(([p, q]) => asks.push([+p, +q]));
    }
    if (out.krBook && out.krBook.result) {
      const k = Object.values(out.krBook.result)[0];
      if (k) { k.bids.forEach(([p, q]) => bids.push([+p, +q])); k.asks.forEach(([p, q]) => asks.push([+p, +q])); }
    }
    const bestBid = Math.max(...bids.map((b) => b[0]));
    const bestAsk = Math.min(...asks.map((a) => a[0]));
    const mid = (bestBid + bestAsk) / 2 || ref;
    if (Number.isFinite(mid)) book = { mid, venues: [out.cbBook && 'Coinbase', out.krBook && 'Kraken'].filter(Boolean), bands: depth(bids, asks, mid) };
  } catch (e) { errors.book = String(e.message || e); }

  const flow = Array.isArray(out.trades) ? takerFlow(out.trades, now) : null;

  let deribit = null;
  if (out.perp && out.perp.result) {
    const r = out.perp.result;
    deribit = {
      funding8h: num(r.funding_8h), mark: num(r.mark_price), index: num(r.index_price),
      openInterestUsd: num(r.open_interest), volumeUsd24h: r.stats ? num(r.stats.volume_usd) : null,
    };
  }
  const liq = out.perpTrades && out.perpTrades.result ? liquidations(out.perpTrades.result.trades, now) : null;
  const dvol = out.dvol && out.dvol.result ? num(out.dvol.result.index_price) : null;

  let hyper = null;
  if (Array.isArray(out.hl) && out.hl.length === 2) {
    const i = out.hl[0].universe.findIndex((u) => u.name === 'BTC');
    const c = out.hl[1][i];
    if (c) {
      hyper = {
        fundingHourly: num(c.funding), mark: num(c.markPx), oracle: num(c.oraclePx), premium: num(c.premium),
        openInterestUsd: num(c.openInterest) * num(c.markPx), volumeUsd24h: num(c.dayNtlVlm),
      };
    }
  }

  const calib = out.candles && out.recent ? calibrate(out.recent.markets, out.candles, now) : null;

  send(res, { serverTime: now, speed, calib, dvol, book, flow, deribit, hyper, liq, errors }, 10);
};
