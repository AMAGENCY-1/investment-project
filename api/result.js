// Settlement lookup for logged bets: ?tickers=A,B,C
const { getJSON, settle, normMarket, send, allowGet, KALSHI } = require('./_lib');

module.exports = async (req, res) => {
  if (!allowGet(req, res)) return;
  const tickers = String((req.query && req.query.tickers) || '')
    .split(',').map((t) => t.trim()).filter((t) => /^KX[A-Z0-9]+-[A-Z0-9.-]+$/.test(t)).slice(0, 25);
  const named = {};
  tickers.forEach((t) => { named[t] = getJSON(`${KALSHI}/markets/${t}`); });
  const { out, errors } = await settle(named);
  const results = {};
  for (const t of tickers) {
    const m = out[t] && normMarket(out[t].market);
    if (m) results[t] = { status: m.status, result: m.result, target: m.target, settledValue: m.settledValue, close: m.close };
  }
  send(res, { results, errors }, 15);
};
