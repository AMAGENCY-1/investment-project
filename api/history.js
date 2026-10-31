// Minute-by-minute Kalshi prices for one market, to back-fill the odds chart.
const { getJSON, send, num, allowGet, KALSHI, SERIES } = require('./_lib');

const pick = (o) => {
  if (!o) return null;
  if (o.close_dollars !== undefined) return num(o.close_dollars);
  if (o.close !== undefined && o.close !== null) return Number(o.close) / 100;
  return null;
};

module.exports = async (req, res) => {
  if (!allowGet(req, res)) return;
  const ticker = String((req.query && req.query.ticker) || '');
  const start = Number(req.query && req.query.start);
  if (!/^KXBTC15M-[A-Z0-9-]+$/.test(ticker) || !Number.isFinite(start)) {
    res.statusCode = 400;
    return send(res, { error: 'Pass ticker and start (unix seconds).' }, 0);
  }
  const end = Math.floor(Date.now() / 1000);
  try {
    const j = await getJSON(`${KALSHI}/series/${SERIES}/markets/${ticker}/candlesticks?start_ts=${start}&end_ts=${end}&period_interval=1`);
    const points = (j.candlesticks || []).map((c) => {
      const bid = pick(c.yes_bid), ask = pick(c.yes_ask);
      const mid = bid !== null && ask !== null ? (bid + ask) / 2 : pick(c.price);
      return { t: c.end_period_ts * 1000, bid, ask, mid };
    }).filter((p) => p.mid !== null);
    send(res, { ticker, points }, 20);
  } catch (e) {
    send(res, { ticker, points: [], error: String(e.message || e) }, 5);
  }
};
