// Shared helpers for the Investment Project data endpoints.
const HEADERS = { 'User-Agent': 'investment-project/1.0 (AMAGENCY)', Accept: 'application/json' };
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const SERIES = 'KXBTC15M';

async function getJSON(url, opts = {}) {
  const r = await fetch(url, {
    method: opts.method || 'GET',
    headers: { ...HEADERS, ...(opts.headers || {}) },
    body: opts.body,
    signal: AbortSignal.timeout(opts.timeout || 6000),
  });
  if (!r.ok) throw new Error(new URL(url).host + ' HTTP ' + r.status);
  return r.json();
}

// Run named promises in parallel; keep whatever succeeds and report the rest.
async function settle(named) {
  const keys = Object.keys(named);
  const results = await Promise.allSettled(keys.map((k) => named[k]));
  const out = {};
  const errors = {};
  keys.forEach((k, i) => {
    const r = results[i];
    if (r.status === 'fulfilled') out[k] = r.value;
    else { out[k] = null; errors[k] = String((r.reason && r.reason.message) || r.reason); }
  });
  return { out, errors };
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// Kalshi moved to *_dollars / *_fp fields; fall back to the older cent fields.
function dollars(m, key) {
  if (m[key + '_dollars'] !== undefined) return num(m[key + '_dollars']);
  if (m[key] !== undefined && m[key] !== null) return Number(m[key]) / 100;
  return null;
}
function fp(m, key) {
  if (m[key + '_fp'] !== undefined) return num(m[key + '_fp']);
  return num(m[key]);
}

function normMarket(m) {
  if (!m) return null;
  return {
    ticker: m.ticker,
    title: m.title,
    target: num(m.floor_strike),
    strikeType: m.strike_type,
    open: m.open_time,
    close: m.close_time,
    status: m.status,
    result: m.result || null,
    settledValue: num(m.expiration_value),
    yesBid: dollars(m, 'yes_bid'),
    yesAsk: dollars(m, 'yes_ask'),
    noBid: dollars(m, 'no_bid'),
    noAsk: dollars(m, 'no_ask'),
    yesBidSize: fp(m, 'yes_bid_size'),
    yesAskSize: fp(m, 'yes_ask_size'),
    last: dollars(m, 'last_price'),
    volume: fp(m, 'volume'),
    volume24h: fp(m, 'volume_24h'),
    openInterest: fp(m, 'open_interest'),
    rules: m.rules_primary || '',
    rulesDetail: m.rules_secondary || '',
  };
}

function median(values) {
  const a = values.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// Read-only API: reject anything but GET/HEAD.
function allowGet(req, res) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  res.statusCode = 405;
  res.setHeader('allow', 'GET, HEAD');
  res.end();
  return false;
}

function send(res, body, sMaxAge) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', `public, max-age=0, s-maxage=${sMaxAge}, stale-while-revalidate=${sMaxAge}`);
  res.end(JSON.stringify(body));
}

module.exports = { getJSON, settle, num, normMarket, median, send, allowGet, KALSHI, SERIES };
