// Liquidity feed (polled every ~15s): spot order-book depth, taker flow,
// derivatives funding / open interest, implied volatility and recent liquidations.
// Cached briefly in the warm instance so several viewers share one fetch.
const { getJSON, settle, num, send, allowGet } = require('./_lib');

const cache = { data: null, at: 0 };
const TTL = 6000;

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

module.exports = async (req, res) => {
  if (!allowGet(req, res)) return;
  const now = Date.now();
  if (cache.data && now - cache.at < TTL) return send(res, { ...cache.data, serverTime: now }, 10);
  const { out, errors } = await settle({
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

  const ref = out.perp && out.perp.result ? num(out.perp.result.index_price) : null;

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

  const data = { serverTime: now, dvol, book, flow, deribit, hyper, liq, errors };
  if (book || deribit) { cache.data = data; cache.at = now; }
  send(res, data, 10);
};
