/* Status page: server-side health of every upstream, plus this device's own connection. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const ROLES = {
    'Kalshi': 'Market, order book, targets, settlement',
    'Coinbase REST': 'Price fallback, candles, order book, trades',
    'Coinbase stream': 'Tick-by-tick BTC price',
    'Kraken': 'Price and order book',
    'Bitstamp': 'Price cross-check',
    'Gemini': 'Price cross-check',
    'Deribit': 'Funding, open interest, liquidations, implied volatility',
    'Hyperliquid': 'Funding and open interest',
  };
  const et = (ms) => new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit' }) + ' ET';

  function row(name, role, ok, ms, err) {
    const li = document.createElement('li'); li.className = 'check';
    const n = document.createElement('span'); n.className = 'check-name'; n.textContent = name;
    const r = document.createElement('span'); r.className = 'check-role'; r.textContent = ok || !err ? role : err;
    const st = document.createElement('span'); st.className = 'check-state';
    const chip = document.createElement('span');
    if (ok === null) { chip.className = 'chip'; chip.textContent = 'Checking'; }
    else { chip.className = 'chip ' + (ok ? 'ok' : 'bad'); chip.textContent = ok ? '✓ Operational' : '✕ Down'; }
    st.appendChild(chip);
    if (Number.isFinite(ms)) {
      const lat = document.createElement('span'); lat.className = 'lat';
      const bar = document.createElement('span'); bar.className = 'lat-bar'; bar.setAttribute('aria-hidden', 'true');
      const fill = document.createElement('i'); fill.style.width = Math.min(100, (ms / 600) * 100).toFixed(0) + '%';
      bar.appendChild(fill);
      const t = document.createElement('span'); t.textContent = Math.round(ms) + ' ms';
      lat.append(bar, t);
      st.appendChild(lat);
    }
    li.append(n, st, r);
    return li;
  }

  async function serverChecks() {
    const list = $('checks');
    $('recheck').disabled = true;
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      const j = await r.json();
      list.textContent = '';
      j.checks.forEach((c) => list.appendChild(row(c.name, ROLES[c.name] || '', c.ok, c.ms, c.error)));
      const down = j.checks.filter((c) => !c.ok);
      const banner = $('banner');
      banner.dataset.state = down.length ? 'bad' : 'ok';
      $('bannerIcon').textContent = down.length ? '!' : '✓';
      $('bannerTitle').textContent = down.length ? `${down.length} source${down.length > 1 ? 's' : ''} down` : 'All systems operational';
      $('bannerSub').textContent = down.length
        ? `${down.map((d) => d.name).join(', ')} not responding. The desk keeps running on the other sources.`
        : `${j.checks.length} data sources responding from ${j.region === 'iad1' ? 'US-East (iad1)' : j.region || 'Vercel'}.`;
      $('checkedAt').textContent = 'Checked ' + et(Date.now());
    } catch (e) {
      $('banner').dataset.state = 'bad';
      $('bannerIcon').textContent = '!';
      $('bannerTitle').textContent = 'Can’t reach the server';
      $('bannerSub').textContent = 'Check your connection, or sign in to Vercel again.';
    } finally {
      $('recheck').disabled = false;
    }
  }

  async function deviceChecks() {
    const list = $('deviceChecks');
    const rows = { server: row('Server round trip', 'This device to the Investment Project server', null), stream: row('Coinbase stream', 'This device to the live price stream', null) };
    list.textContent = ''; list.append(rows.server, rows.stream);
    try {
      const t0 = performance.now();
      const r = await fetch('/api/live', { cache: 'no-store' });
      const j = await r.json();
      const ms = performance.now() - t0;
      rows.server.replaceWith(rows.server = row('Server round trip', 'This device to the Investment Project server', r.ok, ms));
      if (j.market) {
        const fmt = (iso) => new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
        $('mWindow').textContent = `${fmt(j.market.open)} → ${fmt(j.market.close)} ET`;
        $('mTarget').textContent = Number.isFinite(j.market.target) ? '$' + j.market.target.toLocaleString('en-US', { minimumFractionDigits: 2 }) : 'Sets at open';
        $('mTicker').textContent = j.market.ticker;
      }
      $('mServer').textContent = et(j.serverTime);
    } catch (e) {
      rows.server.replaceWith(rows.server = row('Server round trip', 'This device to the Investment Project server', false, NaN, 'Not reachable'));
    }
    const streamResult = await new Promise((resolve) => {
      let ws; const t0 = performance.now();
      const done = (ok, err) => { try { ws && ws.close(); } catch (e) { /* closed */ } resolve({ ok, ms: performance.now() - t0, err }); };
      const timer = setTimeout(() => done(false, 'No price within 6 seconds'), 6000);
      try {
        ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
        ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['ticker'] }));
        ws.onmessage = (e) => { try { const m = JSON.parse(e.data); if (m.type === 'ticker') { clearTimeout(timer); done(true); } } catch (x) { /* ignore */ } };
        ws.onerror = () => { clearTimeout(timer); done(false, 'Blocked by this network'); };
      } catch (e) { clearTimeout(timer); done(false, 'Not supported on this browser'); }
    });
    rows.stream.replaceWith(row('Coinbase stream', 'This device to the live price stream', streamResult.ok, streamResult.ok ? streamResult.ms : NaN, streamResult.err));
  }

  $('recheck').addEventListener('click', () => { serverChecks(); deviceChecks(); });
  serverChecks();
  deviceChecks();
  setInterval(() => { if (!document.hidden) serverChecks(); }, 30000);
})();
