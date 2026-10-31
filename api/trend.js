// Trend feed (polled every 30s, small and fast): 1-minute and 5-minute BTC
// candles, price speed, index calibration, and the last 24 hours of Kalshi
// 15-minute results. Cached briefly in the warm instance.
const { getJSON, settle, normMarket, send, allowGet, KALSHI, SERIES } = require('./_lib');
const { toBars, speedFromCandles, calibrate } = require('./_market');

const cache = { data: null, at: 0 };
const TTL = 8000;

module.exports = async (req, res) => {
  if (!allowGet(req, res)) return;
  const now = Date.now();
  if (cache.data && now - cache.at < TTL) return send(res, { ...cache.data, serverTime: now }, 10);

  const nowS = Math.floor(now / 1000);
  const { out, errors } = await settle({
    c1: getJSON('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60', { timeout: 4000 }),
    c5: getJSON('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=300', { timeout: 4000 }),
    rounds: getJSON(`${KALSHI}/markets?series_ticker=${SERIES}&min_close_ts=${nowS - 86400}&max_close_ts=${nowS + 1800}&limit=200`, { timeout: 4000 }),
  });

  const markets = (out.rounds && out.rounds.markets) || [];
  const rounds = markets
    .map(normMarket)
    .filter((m) => m && (m.result === 'yes' || m.result === 'no'))
    .sort((a, b) => Date.parse(b.close) - Date.parse(a.close))
    .slice(0, 96)
    .map((m) => ({ open: m.open, close: m.close, target: m.target, settle: m.settledValue, result: m.result }));

  const data = {
    serverTime: now,
    speed: out.c1 ? speedFromCandles(out.c1) : null,
    calib: out.c1 ? calibrate(markets, out.c1, now) : null,
    bars: out.c1 ? toBars(out.c1, 300) : [],
    bars5: out.c5 ? toBars(out.c5, 288) : [],
    rounds,
    errors,
  };
  if (data.speed) { cache.data = data; cache.at = now; }
  send(res, data, 10);
};
