// Health check: latency of every upstream, including the Coinbase WebSocket
// stream the browser uses. Open /api/health to see what's up.
const { getJSON, allowGet, send, KALSHI, SERIES } = require('./_lib');

async function timed(name, fn) {
  const t0 = Date.now();
  try { const detail = await fn(); return { name, ok: true, ms: Date.now() - t0, detail }; }
  catch (e) { return { name, ok: false, ms: Date.now() - t0, error: String((e && e.message) || e) }; }
}

function streamCheck() {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket === 'undefined') return reject(new Error('WebSocket not available in this runtime'));
    const ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('no ticker within 4s')); }, 4000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['ticker'] }));
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'ticker' && m.product_id === 'BTC-USD') {
        clearTimeout(timer); try { ws.close(); } catch {}
        resolve({ price: m.price, best_bid: m.best_bid, best_ask: m.best_ask });
      } else if (m.type === 'error') { clearTimeout(timer); reject(new Error(m.message || 'stream error')); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('connection failed')); };
  });
}

module.exports = async (req, res) => {
  if (!allowGet(req, res)) return;
  const checks = await Promise.all([
    timed('Kalshi', async () => { const j = await getJSON(`${KALSHI}/markets?series_ticker=${SERIES}&status=open&limit=1`); return (j.markets || []).length + ' open'; }),
    timed('Coinbase REST', async () => (await getJSON('https://api.exchange.coinbase.com/products/BTC-USD/ticker')).price),
    timed('Coinbase stream', streamCheck),
    timed('Kraken', async () => Object.values((await getJSON('https://api.kraken.com/0/public/Ticker?pair=XBTUSD')).result)[0].c[0]),
    timed('Bitstamp', async () => (await getJSON('https://www.bitstamp.net/api/v2/ticker/btcusd/')).last),
    timed('Gemini', async () => (await getJSON('https://api.gemini.com/v1/pubticker/btcusd')).last),
    timed('Deribit', async () => (await getJSON('https://www.deribit.com/api/v2/public/ticker?instrument_name=BTC-PERPETUAL')).result.index_price),
    timed('Hyperliquid', async () => { const r = await getJSON('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'allMids' }) }); return r.BTC; }),
  ]);
  send(res, { ok: checks.every((c) => c.ok), region: process.env.VERCEL_REGION || null, checks }, 15);
};
