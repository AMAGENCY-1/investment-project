// Fast feed (polled every second): the open Kalshi BTC 15-minute market, its
// order book, and spot prices from four exchanges. Market metadata and spot
// prices are cached briefly in the warm instance, so a typical request makes a
// single upstream call (the order book).
const { getJSON, settle, num, normMarket, median, send, allowGet, KALSHI, SERIES } = require('./_lib');

const cache = { market: null, marketAt: 0, spot: null, spotAt: 0 };
const MARKET_TTL = 4000;
const SPOT_TTL = 1500;

function ladder(levels) {
  // Kalshi returns bids only, ascending by price: [[price, size], ...]
  return (levels || []).map(([p, s]) => [Number(p), Number(s)]).filter(([, s]) => s > 0);
}

function buildBook(ob) {
  const book = (ob && (ob.orderbook_fp || ob.orderbook)) || {};
  const centsMode = !book.yes_dollars && !!book.yes;
  const scale = centsMode ? 0.01 : 1;
  const yesBids = ladder(book.yes_dollars || book.yes).map(([p, s]) => [p * scale, s]).sort((a, b) => b[0] - a[0]);
  const noBids = ladder(book.no_dollars || book.no).map(([p, s]) => [p * scale, s]).sort((a, b) => b[0] - a[0]);
  const side = (bids, oppBids) => {
    // To buy this side you lift the opposite side's bids: ask = 1 - oppBid.
    const asks = oppBids.map(([p, s]) => [+(1 - p).toFixed(4), s]).sort((a, b) => a[0] - b[0]);
    const bestAsk = asks.length ? asks[0][0] : null;
    const bestBid = bids.length ? bids[0][0] : null;
    let depthQty = 0, depthCost = 0;
    for (const [p, s] of asks) {
      if (bestAsk !== null && p <= bestAsk + 0.05 + 1e-9) { depthQty += s; depthCost += p * s; }
    }
    const bidQty = bids.filter(([p]) => bestBid !== null && p >= bestBid - 0.05 - 1e-9).reduce((t, [, s]) => t + s, 0);
    return { bestAsk, bestBid, asks: asks.slice(0, 6), bids: bids.slice(0, 6), askDepth5c: depthQty, askDepth5cCost: depthCost, bidDepth5c: bidQty };
  };
  return { up: side(yesBids, noBids), down: side(noBids, yesBids) };
}

async function loadMarket(now) {
  const m = cache.market;
  if (m && now - cache.marketAt < MARKET_TTL && Date.parse(m.close) > now) return m;
  const j = await getJSON(`${KALSHI}/markets?series_ticker=${SERIES}&status=open&limit=10`, { timeout: 3000 });
  const open = (j.markets || [])
    .map(normMarket)
    .filter((x) => x && Date.parse(x.close) > now)
    .sort((a, b) => Date.parse(a.close) - Date.parse(b.close));
  cache.market = open[0] || null;
  cache.marketAt = now;
  return cache.market;
}

async function loadBook(ticker) {
  const t0 = Date.now();
  const ob = await getJSON(`${KALSHI}/markets/${ticker}/orderbook`, { timeout: 2500 });
  return { book: buildBook(ob), ms: Date.now() - t0 };
}

async function loadSpot(now, errors) {
  if (cache.spot && now - cache.spotAt < SPOT_TTL) return cache.spot;
  const { out, errors: e } = await settle({
    coinbase: getJSON('https://api.exchange.coinbase.com/products/BTC-USD/ticker', { timeout: 2500 }),
    kraken: getJSON('https://api.kraken.com/0/public/Ticker?pair=XBTUSD', { timeout: 2500 }),
    bitstamp: getJSON('https://www.bitstamp.net/api/v2/ticker/btcusd/', { timeout: 2500 }),
    gemini: getJSON('https://api.gemini.com/v1/pubticker/btcusd', { timeout: 2500 }),
  });
  Object.assign(errors, e);
  const venues = [];
  const add = (name, bid, ask, last) => {
    bid = num(bid); ask = num(ask); last = num(last);
    const mid = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 ? (bid + ask) / 2 : last;
    if (Number.isFinite(mid)) venues.push({ name, bid, ask, mid });
  };
  if (out.coinbase) add('Coinbase', out.coinbase.bid, out.coinbase.ask, out.coinbase.price);
  if (out.kraken && out.kraken.result) {
    const k = Object.values(out.kraken.result)[0];
    if (k) add('Kraken', k.b && k.b[0], k.a && k.a[0], k.c && k.c[0]);
  }
  if (out.bitstamp) add('Bitstamp', out.bitstamp.bid, out.bitstamp.ask, out.bitstamp.last);
  if (out.gemini) add('Gemini', out.gemini.bid, out.gemini.ask, out.gemini.last);
  const mids = venues.map((v) => v.mid);
  const spot = { composite: median(mids), venues, spread: mids.length > 1 ? Math.max(...mids) - Math.min(...mids) : 0, at: now };
  if (venues.length) { cache.spot = spot; cache.spotAt = now; }
  return spot;
}

module.exports = async (req, res) => {
  if (!allowGet(req, res)) return;
  const t0 = Date.now();
  const now = t0;
  const errors = {};

  // Start the order book for the cached market right away, in parallel with everything else.
  const known = cache.market && Date.parse(cache.market.close) > now ? cache.market : null;
  const [market, bookEarly, spot] = await Promise.all([
    loadMarket(now).catch((e) => { errors.markets = String(e.message || e); return known; }),
    known ? loadBook(known.ticker).catch((e) => { errors.orderbook = String(e.message || e); return null; }) : null,
    loadSpot(now, errors),
  ]);

  let book = bookEarly;
  if (market && (!known || known.ticker !== market.ticker)) {
    book = await loadBook(market.ticker).catch((e) => { errors.orderbook = String(e.message || e); return null; });
  }

  const total = Date.now() - t0;
  res.setHeader('server-timing', `kalshi;dur=${book ? book.ms : 0}, total;dur=${total}`);
  send(res, {
    serverTime: Date.now(),
    market,
    book: book ? book.book : null,
    spot,
    timing: { kalshiMs: book ? book.ms : null, totalMs: total },
    errors,
  }, 1);
};
