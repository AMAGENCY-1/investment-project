/* Investment Project client: streams Coinbase ticks over WebSocket, polls
   /api/live (1s), /api/trend (30s) and /api/context (15s), prices the
   Kalshi BTC 15-minute market with a random-walk model of the settlement
   average, and shows where our odds and Kalshi's price disagree. */
(() => {
  'use strict';

  const LIVE_MS = 1000;
  const STREAM_URL = 'wss://ws-feed.exchange.coinbase.com';
  const CONTEXT_MS = 15000;
  const TREND_MS = 30000;
  const RESULT_MS = 30000;
  const AVG_WINDOW = 60; // Kalshi settles on a 60-second average of BRTI
  const $ = (id) => document.getElementById(id);

  // ---------- storage (per-device convenience only) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
    keys() { try { return Object.keys(localStorage); } catch { return []; } },
  };

  // ---------- math ----------
  function erf(x) {
    const s = Math.sign(x); x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }
  const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
  function invPhi(p) {
    if (!(p > 0 && p < 1)) return NaN;
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const lo = 0.02425;
    if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - lo) return -invPhi(1 - p);
    const q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const mean = (a) => (a.length ? a.reduce((t, x) => t + x, 0) / a.length : null);
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);

  // Settlement value = average of the index over the final 60 seconds.
  // For a random walk with speed s ($ per sqrt-minute):
  //   more than 60s left: mean = now, variance = s^2/60 * (T - 40s)
  //   inside the final minute: part of the average is already known.
  function forecast(price, secsLeft, speed, knownAvg) {
    const vps = (speed * speed) / 60;
    if (secsLeft >= AVG_WINDOW) return { mean: price, sd: Math.sqrt(vps * (secsLeft - (2 * AVG_WINDOW) / 3)) };
    if (secsLeft <= 0) return { mean: finite(knownAvg) ? knownAvg : price, sd: 0 };
    const done = AVG_WINDOW - secsLeft;
    const known = finite(knownAvg) ? knownAvg : price;
    return { mean: (known * done + price * secsLeft) / AVG_WINDOW, sd: Math.sqrt((vps * secsLeft ** 3) / (3 * AVG_WINDOW * AVG_WINDOW)) };
  }
  function probUp(f, target) {
    if (!(f.sd > 0)) return f.mean >= target ? 0.999 : 0.001;
    return clamp(Phi((f.mean - target) / f.sd), 0.001, 0.999);
  }
  const feeFor = (p, rate) => (finite(p) ? rate * p * (1 - p) : 0);

  // ---------- formatting ----------
  const MINUS = '−';
  const usd = (v, d = 2) => (finite(v) ? '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–');
  const sUsd = (v, d = 2) => (finite(v) ? (v >= 0 ? '+' : MINUS) + usd(v, d) : '–');
  const money = (v) => (finite(v) ? (v < 0 ? MINUS : '') + usd(v) : '–');
  const compact = (v, d = 1) => (finite(v) ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: d }).format(v) : '–');
  const pct = (p, d = 1) => (finite(p) ? (p * 100).toFixed(d) + '%' : '–');
  const pts = (e) => (finite(e) ? (e >= 0 ? '+' : MINUS) + Math.abs(e * 100).toFixed(1) + ' pts' : '–');
  const cents = (p) => {
    if (!finite(p)) return '–';
    const c = p * 100;
    return (c < 10 || c > 90 ? (Math.round(c * 10) / 10).toString() : Math.round(c).toString()) + '¢';
  };
  const mult = (c) => (finite(c) && c > 0 ? (c < 0.01 ? '>100x' : (1 / c).toFixed(2) + 'x') : '–');
  const odds = (p) => pct(p, p > 0.99 || p < 0.01 ? 1 : 0);
  const et = (ms, opts = {}) => new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', ...opts });
  const mmss = (s) => { s = Math.max(0, Math.floor(s)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  const signClass = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  function setText(id, text, cls) {
    const el = $(id); if (!el) return;
    el.textContent = text;
    if (cls !== undefined) { el.classList.remove('pos', 'neg', 'dim'); if (cls) el.classList.add(cls); }
  }

  // ---------- settings ----------
  const DEFAULTS = { bank: 10, kelly: 0.25, cap: 20, minEdge: 5, fee: 0.07, speedSrc: 'blend', manual: 15 };
  const settings = { ...DEFAULTS, ...store.get('ed.settings', {}) };
  const fields = { bank: 'sBank', kelly: 'sKelly', cap: 'sCap', minEdge: 'sMinEdge', fee: 'sFee', speedSrc: 'sSpeedSrc', manual: 'sManual' };
  function bindSettings() {
    for (const [k, id] of Object.entries(fields)) {
      const el = $(id);
      el.value = settings[k];
      el.addEventListener('change', () => {
        const v = k === 'speedSrc' ? el.value : Number(el.value);
        if (k !== 'speedSrc' && !finite(v)) { el.value = settings[k]; return; }
        settings[k] = v;
        store.set('ed.settings', settings);
        render();
      });
    }
  }

  // ---------- state ----------
  const state = {
    live: null, ctx: null, trend: null, offset: 0, lastOk: 0, everOk: false,
    ticker: null, series: [], history: [], view: null,
  };
  // Paint charts instantly on reopen with the last trend data (refreshed right after).
  (() => {
    const cached = store.get('ip.trend', null);
    if (cached && Date.now() - cached.serverTime < 20 * 60 * 1000) state.trend = cached;
  })();
  const serverNow = () => Date.now() + state.offset;

  function kalshiMid(live) {
    const m = live.market, b = live.book;
    const bid = b && finite(b.up.bestBid) ? b.up.bestBid : m.yesBid;
    const ask = b && finite(b.up.bestAsk) ? b.up.bestAsk : m.yesAsk;
    if (finite(bid) && finite(ask) && ask > 0) return (bid + ask) / 2;
    return finite(ask) ? ask : finite(bid) ? bid : null;
  }

  // Best guess at CF Benchmarks BRTI: Coinbase plus the measured gap.
  function indexEstimate(live) {
    const spot = live && live.spot;
    if (!spot) return { price: null };
    const cal = state.trend && state.trend.calib;
    const cb = spot.venues.find((x) => x.name === 'Coinbase');
    if (cal && finite(cal.basis)) {
      const base = streamFresh() ? stream.price : cb ? cb.mid : spot.composite;
      return { price: base + cal.basis, basis: cal.basis, n: cal.n, spread: cal.spread, calibrated: true };
    }
    return { price: streamFresh() ? stream.price : spot.composite, calibrated: false };
  }

  function chooseSpeed() {
    const s = state.trend && state.trend.speed;
    const price = state.live && state.live.spot && state.live.spot.composite;
    const blend = () => {
      const v = s ? [s.m15, s.m30, s.m60].filter(finite) : [];
      return v.length ? { v: mean(v), label: 'measured, 15/30/60 min blend' } : null;
    };
    const src = settings.speedSrc;
    if (src === 'manual' && settings.manual > 0) return { v: settings.manual, label: 'manual setting' };
    if (src === 'dvol' && state.ctx && finite(state.ctx.dvol) && price) return { v: (state.ctx.dvol / 100) * price / Math.sqrt(525600), label: 'implied by Deribit DVOL' };
    if (/^m(15|30|60)$/.test(src) && s && finite(s[src])) return { v: s[src], label: 'measured, last ' + src.slice(1) + ' min' };
    return blend();
  }

  function knownAverage(closeMs, nowMs) {
    const pts2 = state.series.filter((p) => p.t >= closeMs - AVG_WINDOW * 1000 && p.t <= nowMs && finite(p.price));
    return pts2.length ? mean(pts2.map((p) => p.price)) : null;
  }

  // ---------- live stream (Coinbase ticker over WebSocket) ----------
  const stream = { price: null, t: 0, open: false, retries: 0, ws: null, paused: false };
  const streamFresh = () => stream.open && Date.now() - stream.t < 5000 && finite(stream.price);
  function connectStream() {
    if (!('WebSocket' in window)) return;
    let ws;
    try { ws = new WebSocket(STREAM_URL); } catch (e) { return retryStream(); }
    stream.ws = ws;
    ws.onopen = () => {
      stream.open = true; stream.retries = 0;
      ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['ticker'] }));
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type !== 'ticker' || m.product_id !== 'BTC-USD') return;
      const bid = Number(m.best_bid), ask = Number(m.best_ask);
      const px = bid > 0 && ask > 0 ? (bid + ask) / 2 : Number(m.price);
      if (!finite(px)) return;
      stream.price = px; stream.t = Date.now();
      scheduleFast();
    };
    ws.onclose = () => { stream.open = false; if (stream.ws === ws && !stream.paused) retryStream(); };
    ws.onerror = () => { try { ws.close(); } catch { /* already closed */ } };
  }
  function retryStream() {
    const wait = Math.min(30000, 1000 * 2 ** stream.retries++);
    setTimeout(() => { if (!stream.paused) connectStream(); }, wait);
  }
  function pauseStream() {
    stream.paused = true;
    if (stream.ws) { try { stream.ws.close(); } catch { /* closed */ } }
  }
  function resumeStream() {
    if (!stream.paused) return;
    stream.paused = false; stream.retries = 0;
    connectStream();
  }

  // Ticks arrive many times a second; repaint the numbers at most 4x/second.
  let fastQueued = false, lastFast = 0;
  function scheduleFast() {
    if (fastQueued) return;
    fastQueued = true;
    const wait = Math.max(0, 250 - (Date.now() - lastFast));
    setTimeout(() => requestAnimationFrame(() => { fastQueued = false; lastFast = Date.now(); renderFast(); }), wait);
  }

  // ---------- data ----------
  let livePending = false;
  async function pollLive() {
    if (livePending) return;
    livePending = true;
    const t0 = Date.now();
    try {
      const r = await fetch('/api/live', { cache: 'no-store', redirect: 'manual' });
      if (r.type === 'opaqueredirect' || r.status === 401 || r.status === 403) { $('authBanner').hidden = false; throw new Error('signed out'); }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      $('authBanner').hidden = true;
      const j = await r.json();
      const rtt = Date.now() - t0;
      state.rtt = rtt;
      state.offset = j.serverTime + rtt / 2 - Date.now();
      state.live = j; state.lastOk = Date.now(); state.everOk = true;
      onLive(j);
    } catch (e) {
      /* status pill shows the outage */
    } finally {
      livePending = false;
    }
  }

  async function pollTrend() {
    try {
      const r = await fetch('/api/trend', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      state.trend = await r.json();
      store.set('ip.trend', state.trend);
      render();
    } catch (e) { /* keep last trend */ }
  }

  async function pollContext() {
    try {
      const r = await fetch('/api/context', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      state.ctx = await r.json();
      render();
    } catch (e) { /* keep last context */ }
  }

  async function loadHistory(m) {
    try {
      const start = Math.floor(Date.parse(m.open) / 1000);
      const r = await fetch(`/api/history?ticker=${encodeURIComponent(m.ticker)}&start=${start}`, { cache: 'no-store' });
      const j = await r.json();
      if (state.ticker === m.ticker && Array.isArray(j.points)) { state.history = j.points; render(); }
    } catch (e) { /* chart falls back to live samples */ }
  }

  function onLive(j) {
    const m = j.market;
    if (m && m.ticker !== state.ticker) {
      // New window: drop old samples, restore any saved for this one.
      store.keys().filter((k) => k.startsWith('ed.series.') && k !== 'ed.series.' + m.ticker).forEach((k) => store.del(k));
      state.ticker = m.ticker;
      state.series = store.get('ed.series.' + m.ticker, []);
      state.history = [];
      loadHistory(m);
    }
    const est = indexEstimate(j);
    if (m && finite(est.price)) {
      const pMkt = kalshiMid(j);
      state.series.push({ t: j.serverTime, price: est.price, pMkt, pModel: null });
      if (state.series.length > 1100) state.series.splice(0, state.series.length - 1100);
    }
    const last = state.series[state.series.length - 1];
    const v = compute();
    if (last && v && finite(v.pUp) && last.t === j.serverTime) last.pModel = v.pUp;
    render();
    if (state.ticker && state.series.length % 10 === 0) store.set('ed.series.' + state.ticker, state.series);
  }

  // ---------- compute ----------
  function compute() {
    const live = state.live;
    if (!live || !live.market) return null;
    const m = live.market;
    const now = serverNow();
    const openMs = Date.parse(m.open), closeMs = Date.parse(m.close);
    const secsLeft = Math.max(0, (closeMs - now) / 1000);
    const est = indexEstimate(live);
    const price = est.price;
    const target = m.target;
    const speed = chooseSpeed();
    const v = { m, now, openMs, closeMs, secsLeft, price, target, speed, est };
    const b = live.book;
    v.upAsk = b && finite(b.up.bestAsk) ? b.up.bestAsk : m.yesAsk;
    v.dnAsk = b && finite(b.down.bestAsk) ? b.down.bestAsk : m.noAsk;
    v.upBid = b && finite(b.up.bestBid) ? b.up.bestBid : m.yesBid;
    v.mid = kalshiMid(live);
    if (!finite(price) || !finite(target) || !speed || !(speed.v > 0)) return v;

    v.f = forecast(price, secsLeft, speed.v, secsLeft < AVG_WINDOW ? knownAverage(closeMs, now) : null);
    // Add the uncertainty in our index estimate itself (it is not the real BRTI).
    const calErr = est.calibrated ? Math.max(2, finite(est.spread) ? est.spread : 3) : 8;
    v.f.sd = Math.sqrt(v.f.sd * v.f.sd + calErr * calErr);
    v.pUp = probUp(v.f, target);
    const side = (p, ask) => {
      if (!finite(ask) || ask <= 0 || ask >= 1) return { p, ask: null };
      const fee = feeFor(ask, settings.fee);
      const cost = ask + fee;
      const edge = p - cost;
      const kelly = edge > 0 ? edge / (1 - cost) : 0;
      const stake = Math.min(settings.bank * settings.kelly * kelly, settings.bank * settings.cap / 100);
      const qty = Math.floor(stake / cost);
      return { p, ask, fee, cost, edge, kelly, stake: qty * cost, qty, fair: 1 / p };
    };
    v.up = side(v.pUp, v.upAsk);
    v.dn = side(1 - v.pUp, v.dnAsk);
    // A huge gap between us and Kalshi almost always means bad data, not a real chance.
    v.dataGap = finite(v.mid) && Math.abs(v.pUp - v.mid) > 0.25;

    // Speed Kalshi's price implies (only meaningful away from 50/50 and the final minute).
    if (finite(v.mid) && v.mid > 0.03 && v.mid < 0.97 && secsLeft > 90) {
      const z = invPhi(v.mid);
      const gap = price - target;
      const tEff = (secsLeft - 40) / 60;
      if (Math.abs(z) > 0.08 && Math.sign(z) === Math.sign(gap)) v.implied = Math.abs(gap) / (Math.abs(z) * Math.sqrt(tEff));
      else if (Math.abs(z) > 0.08) v.impliedNote = 'leans against price';
    }
    return v;
  }

  // ---------- render ----------
  const isPro = () => document.documentElement.dataset.view === 'pro';

  function render() {
    const v = compute();
    state.view = v;
    renderHero(v);
    renderMetrics(v);
    renderValue(v);
    renderEvidence(v);
    renderRounds();
    if (isPro()) { renderOdds(v); renderLadders(); renderContext(v); }
    renderCharts(v);
    renderRules();
    renderSources();
    renderLogButtons(v);
  }

  function renderFast() {
    if (!state.live) return;
    const v = compute();
    state.view = v;
    renderHero(v);
    renderMetrics(v);
    renderValue(v);
    if (isPro()) renderOdds(v);
    renderLogButtons(v);
  }

  // ---------- "Is the price right?" ----------
  function renderValue(v) {
    const box = $('valueRows');
    box.textContent = '';
    if (!v || !v.f) {
      const p = document.createElement('p'); p.className = 'value-empty';
      p.textContent = 'Appears once the window has a target and live prices.';
      box.appendChild(p);
      return;
    }
    const min = settings.minEdge / 100;
    for (const [key, s, name] of [['up', v.up, 'Up'], ['down', v.dn, 'Down']]) {
      const row = document.createElement('div'); row.className = 'vrow';
      const head = document.createElement('div'); head.className = 'vhead';
      const side = document.createElement('span'); side.className = 'vside ' + (key === 'up' ? 'up-h' : 'down-h'); side.textContent = name;
      const chip = document.createElement('span');
      if (s.ask === null) { chip.className = 'chip fair'; chip.textContent = 'No offers'; }
      else if (v.dataGap) { chip.className = 'chip fair'; chip.textContent = 'Check data'; }
      else if (s.edge >= min) { chip.className = 'chip ok'; chip.textContent = 'Good value · ' + pts(s.edge); }
      else if (s.edge <= -min) { chip.className = 'chip bad'; chip.textContent = 'Overpriced · ' + pts(s.edge); }
      else { chip.className = 'chip fair'; chip.textContent = 'About fair · ' + pts(s.edge); }
      head.append(side, chip);
      const bar = (label, frac, cls, text) => {
        const r = document.createElement('div'); r.className = 'vbar';
        const l = document.createElement('span'); l.className = 'vlab'; l.textContent = label;
        const t = document.createElement('span'); t.className = 'track'; t.setAttribute('aria-hidden', 'true');
        const f = document.createElement('i'); f.className = cls; f.style.width = (clamp(frac, 0, 1) * 100).toFixed(1) + '%';
        t.appendChild(f);
        const n = document.createElement('span'); n.className = 'vnum'; n.textContent = text;
        r.append(l, t, n);
        return r;
      };
      row.append(head, bar('Our chance', s.p, key === 'up' ? 'ours-up' : 'ours-down', odds(s.p)));
      if (s.ask !== null) row.appendChild(bar('Kalshi price', s.cost, 'price', cents(s.ask)));
      box.appendChild(row);
    }
  }

  // One or two plain sentences: where BTC is, what we think, what Kalshi charges.
  function plainWhy(v, best, buying) {
    const gap = v.price - v.target;
    const where = Math.abs(gap) < 1 ? 'right at' : `${usd(Math.abs(gap), 0)} ${gap > 0 ? 'above' : 'below'}`;
    const left = v.secsLeft >= 90 ? `${Math.round(v.secsLeft / 60)} min left` : `${Math.round(v.secsLeft)} sec left`;
    const lead = `BTC is ${where} the target with ${left}.`;
    if (!best) return lead + ' Kalshi has no offers right now.';
    const [key, s] = best;
    const name = key === 'up' ? 'Up' : 'Down';
    if (buying) return `${lead} We give ${name} ${odds(s.p)} and Kalshi charges ${cents(s.ask)}: ${pts(s.edge)} in your favor.`;
    if (s.edge >= settings.minEdge / 100) return `${lead} ${name} is good value, but one contract costs more than your bankroll allows.`;
    const fav = v.up.p >= v.dn.p ? v.up : v.dn;
    const favName = fav === v.up ? 'Up' : 'Down';
    if (fav.ask === null) return `${lead} We give ${favName} ${odds(fav.p)}, but Kalshi has no offers for it.`;
    return `${lead} We give ${favName} ${odds(fav.p)} and Kalshi charges ${cents(fav.ask)}, so neither side is a bargain.`;
  }

  let lastSpoken = null;
  function renderHero(v) {
    const verdict = $('verdict');
    if (!v) {
      setText('windowLabel', state.everOk ? 'Between windows' : 'Finding the live window…');
      verdict.dataset.state = 'wait';
      setText('verdictWord', 'Wait');
      setText('verdictSub', state.everOk ? 'The next 15-minute window opens shortly.' : 'Loading live prices…');
      ['tStake', 'tQty', 'tPays', 'tEdge'].forEach((id) => setText(id, '–', ''));
      return;
    }
    setText('windowLabel', `${et(v.openMs)} → ${et(v.closeMs)} ET`);
    if (!v.f) {
      verdict.dataset.state = 'wait';
      setText('verdictWord', 'Wait');
      setText('verdictSub', !finite(v.target) ? 'Target sets when the window opens.' : 'Measuring how fast BTC is moving…');
      ['tStake', 'tQty', 'tPays', 'tEdge'].forEach((id) => setText(id, '–', ''));
      return;
    }
    const min = settings.minEdge / 100;
    const cands = [['up', v.up], ['down', v.dn]].filter(([, s]) => s.ask !== null);
    cands.sort((a, b) => b[1].edge - a[1].edge);
    const best = cands[0];
    let stateName = 'skip', word = 'No bet', sub;
    if (v.secsLeft <= 5) {
      word = 'Settling'; stateName = 'wait'; sub = 'This window is closing. The next one opens at ' + et(v.closeMs) + '.';
    } else if (v.dataGap) {
      word = 'Check data';
      sub = `Our chance and Kalshi's price are ${Math.abs((v.pUp - v.mid) * 100).toFixed(0)} points apart. Kalshi sees the real index, so this is more likely a data gap than a real chance.`;
    } else if (best && best[1].edge >= min && best[1].qty >= 1) {
      stateName = best[0]; word = best[0] === 'up' ? 'Buy Up' : 'Buy Down';
      sub = plainWhy(v, best, true);
    } else {
      sub = plainWhy(v, best, false);
    }
    verdict.dataset.state = stateName;
    setText('verdictWord', word);
    setText('verdictSub', sub);
    if (word !== lastSpoken) {
      const wasBuy = /^Buy/.test(lastSpoken || '');
      lastSpoken = word;
      setText('announce', `Call: ${word}. ${sub || ''}`);
      if (/^Buy/.test(word) && !wasBuy) notifyBuy(word);
      document.title = /^Buy/.test(word) ? `● ${word} · Investment Project` : 'Investment Project';
    }
    const s = stateName === 'up' ? v.up : stateName === 'down' ? v.dn : null;
    setText('tStake', s ? usd(s.stake) : '$0', '');
    setText('tQty', s ? String(s.qty) : '0', '');
    setText('tPays', s ? usd(s.qty) : '–', '');
    const showEdge = best && !v.dataGap && v.secsLeft > 5;
    setText('tEdge', showEdge ? pts(best[1].edge) : '–', showEdge ? signClass(best[1].edge) : '');
    syncStakeInput(s);
  }

  function renderMetrics(v) {
    const live = state.live;
    if (!v) { ['mTarget', 'mNow', 'mGap', 'mSpeed'].forEach((id) => setText(id, '–')); return; }
    setText('mTarget', finite(v.target) ? usd(v.target) : 'At open');
    setText('mNow', usd(v.price));
    const gap = finite(v.price) && finite(v.target) ? v.price - v.target : null;
    setText('mGap', sUsd(gap), signClass(gap));
    setText('mGapNote', finite(gap) ? (gap >= 0 ? 'above target · Up winning' : 'below target · Down winning') : 'now vs target');
    setText('mSpeed', v.speed ? '±' + usd(v.speed.v, 0) : '–');
    setText('mSpeedNote', 'per minute, recently');
    if (v.est && v.est.calibrated) setText('mNowNote', 'live, matched to Kalshi\u2019s index');
    else if (live && live.spot) setText('mNowNote', 'live price');
  }

  function renderOdds(v) {
    const ids = ['oUpP', 'oDnP', 'oUpAsk', 'oDnAsk', 'oUpFee', 'oDnFee', 'oUpEdge', 'oDnEdge', 'oUpPay', 'oDnPay', 'oUpFair', 'oDnFair', 'oUpDepth', 'oDnDepth'];
    if (!v || !v.f) { ids.forEach((id) => setText(id, '–', '')); return; }
    const b = state.live.book;
    const row = (s, k, depth) => {
      setText('o' + k + 'P', pct(s.p));
      setText('o' + k + 'Ask', s.ask !== null ? cents(s.ask) : 'none');
      setText('o' + k + 'Fee', s.ask !== null ? cents(s.fee) : '–');
      setText('o' + k + 'Edge', s.ask !== null ? pts(s.edge) : '–', s.ask !== null ? signClass(s.edge) : '');
      setText('o' + k + 'Pay', s.ask !== null ? mult(s.cost) : '–');
      setText('o' + k + 'Fair', mult(s.p));
      const dc = $('o' + k + 'Depth');
      dc.textContent = depth ? compact(depth.askDepth5c, 1) : '–';
      if (depth) { const sm = document.createElement('small'); sm.textContent = usd(depth.askDepth5cCost, 0); dc.appendChild(sm); }
    };
    row(v.up, 'Up', b && b.up);
    row(v.dn, 'Dn', b && b.down);
  }

  function renderLadders() {
    const live = state.live;
    const fill = (id, side) => {
      const ol = $(id);
      ol.textContent = '';
      const asks = side ? side.asks : [];
      if (!asks.length) { const li = document.createElement('li'); li.className = 'none'; li.textContent = 'No offers'; ol.appendChild(li); return; }
      const max = Math.max(...asks.map((a) => a[1]));
      asks.forEach(([p, q], i) => {
        const li = document.createElement('li');
        if (i === 0) li.classList.add('best');
        const bar = document.createElement('i'); bar.className = 'fill'; bar.style.width = (100 * q / max).toFixed(1) + '%';
        bar.setAttribute('aria-hidden', 'true');
        const a = document.createElement('span'); a.textContent = cents(p);
        const b = document.createElement('span'); b.textContent = compact(q, 1);
        const unit = document.createElement('span'); unit.className = 'sr-only'; unit.textContent = ' contracts';
        b.appendChild(unit);
        li.append(bar, a, b);
        ol.appendChild(li);
      });
    };
    const b = live && live.book;
    fill('ladUp', b && b.up);
    fill('ladDn', b && b.down);
    const m = live && live.market;
    const v = state.view;
    setText('kSpread', m && v && finite(v.upAsk) && finite(v.upBid) ? cents(v.upAsk - v.upBid) : '–');
    setText('kVol', m ? compact(m.volume) + ' contracts' : '–');
    setText('kOI', m ? compact(m.openInterest) : '–');
    if (v && finite(v.implied)) {
      const mine = v.speed && v.speed.v;
      const el = $('kImplied');
      el.textContent = usd(v.implied, 0) + '/min';
      const small = document.createElement('small');
      small.textContent = mine ? (v.implied > mine * 1.15 ? 'faster than measured: underdog priced rich' : v.implied < mine * 0.87 ? 'slower than measured: favorite priced rich' : 'close to measured') : '';
      el.appendChild(small);
    } else setText('kImplied', v && v.impliedNote ? v.impliedNote : '–');
  }

  function splitHead(left, right) {
    const h = document.createElement('div'); h.className = 'dhead';
    const sp = document.createElement('span');
    const d = document.createElement('div');
    const a = document.createElement('span'); a.textContent = left;
    const b = document.createElement('span'); b.textContent = right;
    d.append(a, b); h.append(sp, d);
    return h;
  }
  function splitRow(label, left, right) {
    const tot = left + right;
    const lp = tot ? (100 * left) / tot : 50;
    const row = document.createElement('div'); row.className = 'drow';
    const band = document.createElement('span'); band.className = 'band'; band.textContent = label;
    const sp = document.createElement('div'); sp.className = 'split';
    const bar = document.createElement('div'); bar.className = 'bar2';
    const bi = document.createElement('i'); bi.className = 'b'; bi.style.width = lp.toFixed(1) + '%';
    const ai = document.createElement('i'); ai.className = 'a'; ai.style.width = (100 - lp).toFixed(1) + '%';
    bar.append(bi, ai);
    const nums = document.createElement('div'); nums.className = 'nums';
    const fmt = (q) => (q >= 100 ? q.toFixed(0) : q >= 10 ? q.toFixed(1) : q.toFixed(2));
    const l = document.createElement('span'); l.textContent = `${fmt(left)} · ${lp.toFixed(0)}%`;
    const r = document.createElement('span'); r.textContent = `${(100 - lp).toFixed(0)}% · ${fmt(right)}`;
    nums.append(l, r);
    sp.append(bar, nums);
    row.append(band, sp);
    return row;
  }

  function renderContext(v) {
    const c = state.ctx;
    const depthEl = $('depthRows'), flowEl = $('flowRows');
    depthEl.textContent = ''; flowEl.textContent = '';
    if (!c) { depthEl.textContent = 'Loading…'; return; }
    if (c.book) {
      depthEl.appendChild(splitHead('Bids · BTC', 'Asks · BTC'));
      c.book.bands.forEach((b) => depthEl.appendChild(splitRow('±' + (b.band * 100).toFixed(2) + '%', b.bid, b.ask)));
    } else depthEl.textContent = 'Order book unavailable.';
    if (c.flow) {
      flowEl.appendChild(splitHead('Buys · BTC', 'Sells · BTC'));
      flowEl.appendChild(splitRow('1 min', c.flow.m1.buy, c.flow.m1.sell));
      flowEl.appendChild(splitRow('5 min', c.flow.m5.buy, c.flow.m5.sell));
    } else flowEl.textContent = 'Trade flow unavailable.';

    const s = state.trend && state.trend.speed;
    setText('pSpeed', s ? [s.m15, s.m30, s.m60].map((x) => usd(x, 0)).join(' · ') : '–');
    const price = state.live && state.live.spot.composite;
    setText('pDvol', finite(c.dvol) && price ? `${c.dvol.toFixed(1)} → ${usd((c.dvol / 100) * price / Math.sqrt(525600), 0)}/min` : '–');
    const d = c.deribit, h = c.hyper;
    const fpct = (x) => (finite(x) ? (x >= 0 ? '+' : MINUS) + Math.abs(x * 100).toFixed(4) + '%' : '–');
    setText('pFundD', d ? fpct(d.funding8h) : '–', d ? signClass(d.funding8h) : '');
    setText('pFundH', h ? fpct(h.fundingHourly * 8) : '–', h ? signClass(h.fundingHourly) : '');
    const oi = $('pOI'); oi.textContent = d ? 'Deribit $' + compact(d.openInterestUsd) : h ? '' : '–';
    if (h) { const sm = document.createElement('small'); sm.textContent = 'Hyperliquid $' + compact(h.openInterestUsd); oi.appendChild(sm); }
    setText('pPrem', d && finite(d.mark) && finite(d.index) ? sUsd(d.mark - d.index) + ' Deribit' : '–');
    if (c.liq) {
      const el = $('pLiq');
      el.textContent = `$${compact(c.liq.longUsd)} / $${compact(c.liq.shortUsd)}`;
      const sm = document.createElement('small'); sm.textContent = `longs / shorts · ${c.liq.count} on Deribit perp`; el.appendChild(sm);
    } else setText('pLiq', '–');
    if (v && v.f && finite(v.mid)) {
      const gap = v.pUp - v.mid;
      const el = $('pCheck');
      el.textContent = `${Math.abs(gap * 100).toFixed(0)} pts apart`;
      const sm = document.createElement('small');
      sm.textContent = `Ours ${odds(v.pUp)} · Kalshi ${pct(v.mid, 0)}` + (Math.abs(gap) > 0.15 ? '. Big gap: double-check before betting.' : '');
      el.appendChild(sm);
    } else setText('pCheck', '–');
    const cal = state.trend && state.trend.calib;
    if (cal && finite(cal.basis)) {
      const el = $('pCal');
      el.textContent = `Coinbase ${sUsd(cal.basis)}`;
      const sm = document.createElement('small');
      sm.textContent = `from the last ${cal.n} Kalshi targets` + (finite(cal.spread) ? `, ±${usd(cal.spread)}` : '');
      el.appendChild(sm);
    } else setText('pCal', 'not calibrated yet');
    const spot = state.live && state.live.spot;
    setText('pSpread', spot ? `${usd(spot.spread)} across ${spot.venues.length}` : '–');
    const ven = $('venues'); ven.textContent = '';
    if (spot) spot.venues.forEach((x) => {
      const row = document.createElement('div');
      const a = document.createElement('span'); a.textContent = x.name;
      const b = document.createElement('span'); b.textContent = usd(x.mid);
      const d2 = document.createElement('span'); d2.textContent = sUsd(x.mid - spot.composite);
      row.append(a, b, d2); ven.appendChild(row);
    });
  }

  function renderRules() {
    const m = state.live && state.live.market;
    if (m && m.rules) setText('rulesText', m.rules);
  }

  const SOURCE_NAMES = {
    markets: 'Kalshi markets', orderbook: 'Kalshi book', coinbase: 'Coinbase', kraken: 'Kraken', bitstamp: 'Bitstamp', gemini: 'Gemini',
    c1: 'Coinbase candles', c5: 'Coinbase 5-min candles', rounds: 'Kalshi history', cbBook: 'Coinbase book', krBook: 'Kraken book', trades: 'Coinbase trades', perp: 'Deribit perp',
    perpTrades: 'Deribit trades', dvol: 'Deribit DVOL', hl: 'Hyperliquid',
  };
  function renderSources() {
    const el = $('sources'); el.textContent = '';
    const sc = document.createElement('li');
    sc.textContent = (streamFresh() ? '✓ ' : '✕ ') + 'Coinbase stream';
    if (!streamFresh()) { sc.classList.add('bad'); sc.title = 'Using 1-second polling instead'; }
    el.appendChild(sc);
    const errs = { ...((state.live && state.live.errors) || {}), ...((state.ctx && state.ctx.errors) || {}), ...((state.trend && state.trend.errors) || {}) };
    Object.entries(SOURCE_NAMES).forEach(([k, name]) => {
      const s = document.createElement('li');
      const bad = k in errs;
      s.textContent = (bad ? '✕ ' : '✓ ') + name;
      if (bad) { s.classList.add('bad'); s.title = errs[k]; }
      el.appendChild(s);
    });
  }

  // ---------- clock + status ----------
  function tick() {
    const v = state.view;
    if (v && v.m) {
      const now = serverNow();
      const left = Math.max(0, (v.closeMs - now) / 1000);
      setText('clock', mmss(left));
      setText('clockNote', left > 0 ? 'until close' : 'settling');
      const span = v.closeMs - v.openMs;
      $('progress').style.width = clamp(100 * (now - v.openMs) / span, 0, 100).toFixed(2) + '%';
    } else setText('clock', '--:--');
    const st = $('status');
    const age = (Date.now() - state.lastOk) / 1000;
    if (!state.everOk) { st.dataset.state = 'connecting'; setText('statusText', 'Connecting'); }
    else if (age < 6) {
      st.dataset.state = 'live';
      const ms = finite(state.rtt) ? ` · ${Math.round(state.rtt)} ms` : '';
      setText('statusText', (streamFresh() ? 'Streaming' : 'Live') + ms);
    }
    else if (age < 20) { st.dataset.state = 'stale'; setText('statusText', `Delayed ${Math.round(age)}s`); }
    else { st.dataset.state = 'error'; setText('statusText', 'Offline'); }
  }

  // ---------- charts ----------
  const NS = 'http://www.w3.org/2000/svg';
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function frame(container, height) {
    container.textContent = '';
    const w = Math.max(260, Math.floor(container.clientWidth));
    const svg = el('svg', { viewBox: `0 0 ${w} ${height}`, width: w, height });
    container.appendChild(svg);
    return { svg, w, h: height };
  }
  function empty(container, msg) {
    container.textContent = '';
    container.__move = null;
    const loading = !state.everOk || !state.trend;
    const p = document.createElement('p');
    p.className = loading ? 'skeleton' : 'chart-empty';
    p.textContent = loading ? 'Loading live data…' : msg;
    container.appendChild(p);
  }
  const tip = $('tip');
  // lines: [[part, ...], ...]; part = 'text' | { b: 'bold' } | { sw: color }
  function showTip(evt, lines) {
    tip.textContent = '';
    for (const parts of lines) {
      const row = document.createElement('div');
      for (const p of parts) {
        if (typeof p === 'string') row.append(p);
        else if (p.b !== undefined) { const b = document.createElement('b'); b.textContent = p.b; row.append(b); }
        else if (p.sw) { const k = document.createElement('i'); k.className = 'k'; k.style.background = p.sw; row.append(k); }
      }
      tip.appendChild(row);
    }
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let x = evt.clientX + 14, y = evt.clientY - r.height - 12;
    if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - 14;
    if (y < 8) y = evt.clientY + 16;
    tip.style.left = Math.max(8, x) + 'px';
    tip.style.top = y + 'px';
  }
  const hideTip = () => { tip.hidden = true; };
  let pointer = null; // last pointer position over a chart, replayed after each re-render
  function hover(svg, onMove, cleanup) {
    const box = svg.parentNode;
    const move = (e) => { pointer = { id: box.id, clientX: e.clientX, clientY: e.clientY }; onMove(e); };
    box.__move = onMove;
    svg.style.touchAction = 'pan-y';
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerdown', move);
    svg.addEventListener('pointerleave', () => { pointer = null; hideTip(); cleanup(); });
  }

  // Draw a chart only when it's shown and near the screen; catch up when it scrolls in.
  const chartSeen = {};
  const chartObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        chartSeen[e.target.id] = e.isIntersecting;
        if (e.isIntersecting && state.view && e.target.offsetParent !== null) CHARTS[e.target.id](state.view);
      }
    }, { rootMargin: '240px 0px' })
    : null;
  function renderCharts(v) {
    for (const id of Object.keys(CHARTS)) {
      const box = $(id);
      if (box.offsetParent === null || chartSeen[id] === false) continue;
      CHARTS[id](v);
    }
    if (pointer) {
      const box = $(pointer.id);
      if (box && box.__move && box.querySelector('svg')) box.__move(pointer); else hideTip();
    }
  }

  function renderLanding(v) {
    const box = $('landChart');
    if (!v || !v.f || !(v.f.sd > 0)) { empty(box, v && v.secsLeft <= 0 ? 'Window closed. Waiting for the next one.' : 'Forecast appears once the target and speed are known.'); return; }
    const { mean: mu, sd } = v.f;
    const T = v.target;
    let lo = Math.min(mu - 3.5 * sd, T - 0.4 * sd), hi = Math.max(mu + 3.5 * sd, T + 0.4 * sd);
    lo = Math.max(lo, mu - 6 * sd); hi = Math.min(hi, mu + 6 * sd);
    const { svg, w, h } = frame(box, 214);
    const P = { l: 12, r: 12, t: 50, b: 28 };
    const x = (p) => P.l + ((p - lo) / (hi - lo)) * (w - P.l - P.r);
    const pdf = (p) => Math.exp(-0.5 * ((p - mu) / sd) ** 2);
    const y = (d) => h - P.b - d * (h - P.t - P.b);
    const N = 140;
    const pts2 = [];
    for (let i = 0; i <= N; i++) { const p = lo + ((hi - lo) * i) / N; pts2.push([p, pdf(p)]); }
    const area = (from, to, color) => {
      const seg = pts2.filter(([p]) => p >= from && p <= to);
      if (seg.length < 2) return;
      const d = `M${x(seg[0][0])},${y(0)} ` + seg.map(([p, dd]) => `L${x(p).toFixed(1)},${y(dd).toFixed(1)}`).join(' ') + ` L${x(seg[seg.length - 1][0])},${y(0)} Z`;
      el('path', { d, fill: color, 'fill-opacity': 0.42 }, svg);
    };
    const Tc = clamp(T, lo, hi);
    area(lo, Tc, css('--down'));
    area(Tc, hi, css('--up'));
    // 2px surface gap at the target between the two fills
    el('line', { x1: x(Tc), x2: x(Tc), y1: y(0), y2: P.t - 6, stroke: css('--surface'), 'stroke-width': 2 }, svg);
    el('path', { d: 'M' + pts2.map(([p, dd]) => `${x(p).toFixed(1)},${y(dd).toFixed(1)}`).join(' L'), fill: 'none', stroke: css('--ink-2'), 'stroke-width': 1.5 }, svg);
    el('line', { x1: P.l, x2: w - P.r, y1: y(0), y2: y(0), stroke: css('--line') }, svg);
    // target marker
    if (T >= lo && T <= hi) {
      el('line', { x1: x(T), x2: x(T), y1: y(0), y2: P.t - 6, stroke: css('--ink'), 'stroke-width': 1, 'stroke-dasharray': '3 3' }, svg);
      const tl = el('text', { x: x(T), y: P.t - 12, 'text-anchor': x(T) < 90 ? 'start' : x(T) > w - 90 ? 'end' : 'middle', class: 'lbl-strong' }, svg);
      tl.textContent = 'Target ' + usd(T);
    } else {
      const right = T > hi;
      const tl = el('text', { x: right ? w - P.r : P.l, y: P.t - 12, 'text-anchor': right ? 'end' : 'start', class: 'lbl-strong' }, svg);
      tl.textContent = (right ? '' : '← ') + 'Target ' + usd(T) + (right ? ' →' : '');
    }
    // now marker
    el('line', { x1: x(mu), x2: x(mu), y1: y(0), y2: y(0) + 5, stroke: css('--ink-2'), 'stroke-width': 1.5 }, svg);
    const nl = el('text', { x: x(mu), y: h - 8, 'text-anchor': 'middle', class: 'lbl' }, svg);
    nl.textContent = 'Expected ' + usd(mu, 0);
    // probability labels
    const dl = el('text', { x: P.l, y: 14, class: 'lbl-strong' }, svg); dl.textContent = 'Down ' + pct(1 - v.pUp, 0);
    const ul = el('text', { x: w - P.r, y: 14, 'text-anchor': 'end', class: 'lbl-strong' }, svg); ul.textContent = 'Up ' + pct(v.pUp, 0);
    box.setAttribute('aria-label', `Forecast: ${pct(v.pUp, 0)} chance BTC settles at or above ${usd(T)}.`);
    const cross = el('line', { y1: P.t - 6, y2: y(0), stroke: css('--gold'), 'stroke-width': 1, visibility: 'hidden' }, svg);
    hover(svg, (e) => {
      const r = svg.getBoundingClientRect();
      const px = clamp(e.clientX - r.left, P.l, w - P.r);
      const price = lo + ((px - P.l) / (w - P.l - P.r)) * (hi - lo);
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
      showTip(e, [['Settles at or above ', { b: usd(price, 0) }], [pct(1 - Phi((price - mu) / sd), 0) + ' chance']]);
    }, () => cross.setAttribute('visibility', 'hidden'));
  }

  function windowPoints(v) {
    // Model and Kalshi odds through the window: back-filled per minute, then live samples.
    const live = state.series.filter((p) => p.t >= v.openMs && p.t <= v.closeMs);
    const firstLive = live.length ? live[0].t : Infinity;
    const model = [], kal = [];
    const bars = (state.trend && state.trend.bars) || [];
    if (v.speed && finite(v.target)) {
      const basis = (v.est && v.est.calibrated && v.est.basis) || 0;
      for (const [t, , , , c0] of bars) {
        const c = c0 + basis;
        const te = (t + 60) * 1000;
        if (te <= v.openMs || te >= firstLive || te > v.closeMs) continue;
        const f = forecast(c, (v.closeMs - te) / 1000, v.speed.v, null);
        model.push([te, probUp(f, v.target)]);
      }
    }
    for (const h of state.history) if (h.t > v.openMs && h.t < firstLive && finite(h.mid)) kal.push([h.t, h.mid]);
    for (const p of live) {
      if (finite(p.pModel)) model.push([p.t, p.pModel]);
      if (finite(p.pMkt)) kal.push([p.t, p.pMkt]);
    }
    return { model, kal };
  }

  function nearest(arr, t) {
    let best = null, d = Infinity;
    for (const p of arr) { const dd = Math.abs(p[0] - t); if (dd < d) { d = dd; best = p; } }
    return best;
  }

  function renderOddsChart(v) {
    const box = $('oddsChart');
    if (!v || !v.m) { empty(box, 'Waiting for the live window.'); return; }
    const { model, kal } = windowPoints(v);
    if (model.length + kal.length < 2) { empty(box, 'Collecting odds. The chart fills in as the window runs.'); return; }
    const { svg, w, h } = frame(box, 210);
    const P = { l: 38, r: 84, t: 10, b: 24 };
    const x = (t) => P.l + ((t - v.openMs) / (v.closeMs - v.openMs)) * (w - P.l - P.r);
    const y = (p) => P.t + (1 - p) * (h - P.t - P.b);
    [0, 0.25, 0.5, 0.75, 1].forEach((g) => {
      el('line', { x1: P.l, x2: w - P.r, y1: y(g), y2: y(g), stroke: css('--line'), 'stroke-width': g === 0.5 ? 1.25 : 1, 'stroke-dasharray': g === 0.5 ? '' : '2 4' }, svg);
      const t = el('text', { x: P.l - 8, y: y(g) + 4, 'text-anchor': 'end' }, svg); t.textContent = Math.round(g * 100) + '%';
    });
    [[v.openMs, 'start'], [v.closeMs, 'end']].forEach(([t, a]) => { const tx = el('text', { x: x(t), y: h - 6, 'text-anchor': a }, svg); tx.textContent = et(t); });
    const line = (pts3, color) => {
      if (pts3.length < 1) return;
      const d = 'M' + pts3.map(([t, p]) => `${x(t).toFixed(1)},${y(p).toFixed(1)}`).join(' L');
      el('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    };
    const mc = css('--model'), kc = css('--kalshi');
    line(kal, kc);
    line(model, mc);
    // end dots + direct labels, nudged apart if they collide
    const ends = [];
    if (model.length) ends.push({ p: model[model.length - 1], c: mc, name: 'Ours' });
    if (kal.length) ends.push({ p: kal[kal.length - 1], c: kc, name: 'Kalshi' });
    ends.forEach((e) => { e.y = y(e.p[1]); });
    if (ends.length === 2 && Math.abs(ends[0].y - ends[1].y) < 16) {
      const mid = (ends[0].y + ends[1].y) / 2, up = ends[0].y <= ends[1].y ? 0 : 1;
      ends[up].ly = mid - 8; ends[1 - up].ly = mid + 8;
    }
    ends.forEach((e) => {
      el('circle', { cx: x(e.p[0]), cy: e.y, r: 4, fill: e.c, stroke: css('--surface'), 'stroke-width': 2 }, svg);
      const t = el('text', { x: w - P.r + 8, y: (e.ly !== undefined ? e.ly : e.y) + 4, class: 'lbl-strong' }, svg);
      t.textContent = `${e.name} ${pct(e.p[1], 0)}`;
    });
    box.setAttribute('aria-label', `Chance of Up: ours ${model.length ? pct(model[model.length - 1][1], 0) : 'n/a'}, Kalshi ${kal.length ? pct(kal[kal.length - 1][1], 0) : 'n/a'}.`);
    const cross = el('line', { y1: P.t, y2: h - P.b, stroke: css('--gold'), 'stroke-width': 1, visibility: 'hidden' }, svg);
    hover(svg, (e) => {
      const r = svg.getBoundingClientRect();
      const px = clamp(e.clientX - r.left, P.l, w - P.r);
      const t = v.openMs + ((px - P.l) / (w - P.l - P.r)) * (v.closeMs - v.openMs);
      const a = nearest(model, t), b = nearest(kal, t);
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
      showTip(e, [[et(t, { second: '2-digit' })], [{ sw: mc }, 'Ours ', { b: a ? pct(a[1], 0) : '–' }], [{ sw: kc }, 'Kalshi ', { b: b ? pct(b[1], 0) : '–' }]]);
    }, () => cross.setAttribute('visibility', 'hidden'));
  }

  function renderPriceChart(v) {
    const box = $('priceChart');
    if (!v || !v.m || !finite(v.target)) { empty(box, 'Waiting for the target price.'); return; }
    const live = state.series.filter((p) => p.t >= v.openMs && p.t <= v.closeMs && finite(p.price)).map((p) => [p.t, p.price]);
    const firstLive = live.length ? live[0][0] : Infinity;
    const bars = (state.trend && state.trend.bars) || [];
    const basis = (v.est && v.est.calibrated && v.est.basis) || 0;
    const back = bars.map(([t, , , , c]) => [(t + 60) * 1000, c + basis]).filter(([t]) => t > v.openMs && t < firstLive);
    const pts3 = back.concat(live);
    if (pts3.length < 2) { empty(box, 'Collecting prices. The chart fills in as the window runs.'); return; }
    const { svg, w, h } = frame(box, 200);
    const P = { l: 56, r: 16, t: 14, b: 24 };
    const vals = pts3.map((p) => p[1]).concat([v.target]);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = Math.max((hi - lo) * 0.15, 5); lo -= pad; hi += pad;
    const x = (t) => P.l + ((t - v.openMs) / (v.closeMs - v.openMs)) * (w - P.l - P.r);
    const y = (p) => P.t + ((hi - p) / (hi - lo)) * (h - P.t - P.b);
    const step = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((s) => (hi - lo) / s <= 5) || 1000;
    for (let g = Math.ceil(lo / step) * step; g <= hi; g += step) {
      el('line', { x1: P.l, x2: w - P.r, y1: y(g), y2: y(g), stroke: css('--line'), 'stroke-dasharray': '2 4' }, svg);
      const t = el('text', { x: P.l - 8, y: y(g) + 4, 'text-anchor': 'end' }, svg); t.textContent = g.toLocaleString('en-US');
    }
    [[v.openMs, 'start'], [v.closeMs, 'end']].forEach(([t, a]) => { const tx = el('text', { x: x(t), y: h - 6, 'text-anchor': a }, svg); tx.textContent = et(t); });
    el('line', { x1: P.l, x2: w - P.r, y1: y(v.target), y2: y(v.target), stroke: css('--gold'), 'stroke-width': 1.25, 'stroke-dasharray': '5 4' }, svg);
    const tl = el('text', { x: w - P.r, y: y(v.target) - 6, 'text-anchor': 'end', class: 'lbl' }, svg); tl.textContent = 'Target';
    // 60-second settlement band
    const bandX = x(v.closeMs - AVG_WINDOW * 1000);
    el('rect', { x: bandX, y: P.t, width: Math.max(0, x(v.closeMs) - bandX), height: h - P.t - P.b, fill: css('--gold'), 'fill-opacity': 0.07 }, svg);
    const d = 'M' + pts3.map(([t, p]) => `${x(t).toFixed(1)},${y(p).toFixed(1)}`).join(' L');
    el('path', { d, fill: 'none', stroke: css('--ink'), 'stroke-width': 2, 'stroke-linejoin': 'round' }, svg);
    const last = pts3[pts3.length - 1];
    el('circle', { cx: x(last[0]), cy: y(last[1]), r: 4.5, fill: last[1] >= v.target ? css('--up') : css('--down'), stroke: css('--surface'), 'stroke-width': 2 }, svg);
    setText('priceHint', 'Shaded: the final 60 seconds Kalshi averages');
    const cross = el('line', { y1: P.t, y2: h - P.b, stroke: css('--gold'), 'stroke-width': 1, visibility: 'hidden' }, svg);
    hover(svg, (e) => {
      const r = svg.getBoundingClientRect();
      const px = clamp(e.clientX - r.left, P.l, w - P.r);
      const t = v.openMs + ((px - P.l) / (w - P.l - P.r)) * (v.closeMs - v.openMs);
      const a = nearest(pts3, t);
      if (!a) return;
      cross.setAttribute('x1', x(a[0])); cross.setAttribute('x2', x(a[0])); cross.setAttribute('visibility', 'visible');
      showTip(e, [[et(a[0], { second: '2-digit' })], [{ b: usd(a[1]) }], [sUsd(a[1] - v.target) + ' vs target']]);
    }, () => cross.setAttribute('visibility', 'hidden'));
  }

  // ---------- evidence: what is pushing BTC right now ----------
  const WEIGHT = { strong: 2, moderate: 1, weak: 0.5 };
  function evidenceList(v) {
    const items = [];
    const add = (title, dir, strength, text, context) => items.push({ title, dir, strength, text, context });
    const T = state.trend, c = state.ctx;
    const basis = (v.est && v.est.calibrated && v.est.basis) || 0;
    const speed = v.speed ? v.speed.v : null;
    const bars = (T && T.bars) || [];

    const gap = v.price - v.target;
    const z = Math.abs(v.f.mean - v.target) / v.f.sd;
    const left = v.secsLeft >= 90 ? `${Math.round(v.secsLeft / 60)} min` : `${Math.round(v.secsLeft)} sec`;
    const fav = v.pUp >= 0.5 ? 'Up' : 'Down';
    if (Math.abs(gap) < 0.5) add('Distance to target', 'flat', 'weak', `BTC is right at the target with ${left} left, so it's close to a coin flip.`);
    else add('Distance to target', gap > 0 ? 'up' : 'down', z >= 1 ? 'strong' : z >= 0.4 ? 'moderate' : 'weak',
      `BTC is ${usd(Math.abs(gap), 0)} ${gap > 0 ? 'above' : 'below'} the target with ${left} left. On distance and speed alone, ${fav} wins about ${odds(Math.max(v.pUp, 1 - v.pUp))} of the time.`);

    if (bars.length > 6 && speed) {
      const d = v.price - (bars[bars.length - 6][4] + basis);
      const th = speed * Math.sqrt(5);
      const quiet = Math.abs(d) < th * 0.35;
      add('Momentum · 5 min', quiet ? 'flat' : d > 0 ? 'up' : 'down', Math.abs(d) >= th ? 'moderate' : 'weak',
        `${d >= 0 ? 'Up' : 'Down'} ${usd(Math.abs(d), 0)} in the last 5 minutes${quiet ? ', which is ordinary noise' : d > 0 ? ', so buyers have the short-term push' : ', so sellers have the short-term push'}.`);
    }
    if (bars.length >= 60 && speed) {
      const d = v.price - (mean(bars.slice(-60).map((b) => b[4])) + basis);
      const th = speed * 2;
      const flat = Math.abs(d) < th * 0.5;
      add('Trend · 1 hour', flat ? 'flat' : d > 0 ? 'up' : 'down', Math.abs(d) >= th * 1.5 ? 'moderate' : 'weak',
        `BTC is ${usd(Math.abs(d), 0)} ${d >= 0 ? 'above' : 'below'} its 1-hour average${flat ? ', with no clear trend' : d > 0 ? ': buyers have been in control' : ': sellers have been in control'}.`);
    }
    if (c && c.book && c.book.bands[1]) {
      const b = c.book.bands[1], tot = b.bid + b.ask, share = tot ? b.bid / tot : 0.5;
      add('Order book', share > 0.58 ? 'up' : share < 0.42 ? 'down' : 'flat', Math.abs(share - 0.5) > 0.15 ? 'moderate' : 'weak',
        `${Math.round(share * 100)}% of orders near the price are buyers waiting${share > 0.58 ? ', so there is more support below than supply above' : share < 0.42 ? ', so there is more supply above than support below' : ', a balanced book'}.`);
    }
    if (c && c.flow && c.flow.m5.buy + c.flow.m5.sell > 0) {
      const share = c.flow.m5.buy / (c.flow.m5.buy + c.flow.m5.sell);
      add('Who is trading · 5 min', share > 0.6 ? 'up' : share < 0.4 ? 'down' : 'flat', Math.abs(share - 0.5) > 0.2 ? 'moderate' : 'weak',
        `Buyers made ${Math.round(share * 100)}% of Coinbase trades in the last 5 minutes${share > 0.6 ? ', pushing the price up' : share < 0.4 ? ', so sellers are pushing the price down' : ', an even split'}.`);
    }
    if (c && c.liq) {
      const L = c.liq.longUsd, S = c.liq.shortUsd, tot = L + S;
      if (tot < 50000) add('Forced exits · 15 min', 'flat', 'weak', 'Few liquidations on Deribit lately, so no forced buying or selling.');
      else add('Forced exits · 15 min', L > S * 1.5 ? 'down' : S > L * 1.5 ? 'up' : 'flat', tot > 500000 ? 'moderate' : 'weak',
        `$${compact(L)} of longs and $${compact(S)} of shorts were forced out on Deribit${L > S * 1.5 ? ', which means forced selling' : S > L * 1.5 ? ', which means forced buying' : ''}.`);
    }
    if (c && c.deribit && finite(c.deribit.funding8h)) {
      const fr = c.deribit.funding8h;
      add('Futures positioning', fr > 0.0001 ? 'up' : fr < -0.00005 ? 'down' : 'flat', 'weak',
        fr > 0.0001 ? 'Futures traders are paying to stay long, so the crowd leans bullish.' : fr < -0.00005 ? 'Futures traders are paying to stay short, so the crowd leans bearish.' : 'Futures funding is near zero, so there is no strong lean either way.');
    }
    if (finite(v.mid)) {
      const d = Math.abs(v.mid - 0.5);
      add('Kalshi traders', v.mid > 0.55 ? 'up' : v.mid < 0.45 ? 'down' : 'flat', d > 0.25 ? 'strong' : d > 0.1 ? 'moderate' : 'weak',
        `Kalshi's price puts the chance of Up at ${pct(v.mid, 0)}.`);
    }
    const rounds = (T && T.rounds) || [];
    if (rounds.length >= 4) {
      const last = rounds.slice(0, 8), ups = last.filter((r) => r.result === 'yes').length;
      add('Past rounds', 'flat', 'weak', `Up won ${ups} of the last ${last.length} rounds. Each round starts fresh, so this is background, not a signal.`, true);
    }
    return items;
  }

  function renderEvidence(v) {
    const list = $('evidence'), sum = $('whySummary');
    list.textContent = ''; sum.textContent = '';
    if (!v || !v.f || !finite(v.target)) {
      const p = document.createElement('p');
      p.className = state.everOk && state.trend ? 'value-empty' : 'skeleton';
      p.textContent = state.everOk && state.trend ? 'Evidence appears once the window has a target.' : 'Loading live data…';
      sum.appendChild(p);
      return;
    }
    const items = evidenceList(v);
    let up = 0, down = 0, nUp = 0, nDown = 0, nFlat = 0;
    for (const it of items) {
      if (it.dir === 'up') { up += WEIGHT[it.strength]; nUp++; }
      else if (it.dir === 'down') { down += WEIGHT[it.strength]; nDown++; }
      else nFlat++;
    }
    const lean = up - down > 0.75 ? 'up' : down - up > 0.75 ? 'down' : 'mixed';
    const head = document.createElement('div'); head.className = 'why-head';
    const verdict = document.createElement('span');
    verdict.className = 'why-verdict ' + (lean === 'mixed' ? '' : lean);
    verdict.textContent = lean === 'up' ? 'Evidence leans Up' : lean === 'down' ? 'Evidence leans Down' : 'Evidence is mixed';
    const count = document.createElement('span'); count.className = 'why-count';
    count.textContent = `${nUp} up · ${nDown} down · ${nFlat} neutral`;
    head.append(verdict, count);
    const bar = document.createElement('div'); bar.className = 'why-bar'; bar.setAttribute('aria-hidden', 'true');
    const total = nUp + nDown + nFlat || 1;
    [['u', nUp], ['n', nFlat], ['d', nDown]].forEach(([cls, n]) => {
      if (!n) return;
      const i = document.createElement('i'); i.className = cls; i.style.width = ((100 * n) / total).toFixed(1) + '%'; bar.appendChild(i);
    });
    sum.append(head, bar);
    for (const it of items) {
      const li = document.createElement('li'); li.className = 'ev'; li.dataset.dir = it.dir;
      const icon = document.createElement('span'); icon.className = 'ev-icon'; icon.setAttribute('aria-hidden', 'true');
      icon.textContent = it.dir === 'up' ? '▲' : it.dir === 'down' ? '▼' : '–';
      const title = document.createElement('span'); title.className = 'ev-title'; title.textContent = it.title;
      const tag = document.createElement('span'); tag.className = 'ev-tag';
      tag.textContent = it.context ? 'Context' : it.dir === 'flat' ? 'Neutral' : `${it.dir === 'up' ? 'Up' : 'Down'} · ${it.strength}`;
      const text = document.createElement('span'); text.className = 'ev-text'; text.textContent = it.text;
      li.append(icon, title, tag, text);
      list.appendChild(li);
    }
    const note = document.createElement('li'); note.className = 'why-note';
    note.textContent = 'Signals show what is pushing the price right now and can flip within minutes. They explain the move; they don’t guarantee it.';
    list.appendChild(note);
  }

  // ---------- trend + past rounds ----------
  let range = ['1h', '4h', '24h'].includes(store.get('ip.range', '1h')) ? store.get('ip.range', '1h') : '1h';
  const RANGE = { '1h': { n: 60, avg: 15, label: '15-minute average', span: 'hour' }, '4h': { n: 240, avg: 60, label: '1-hour average', span: '4 hours' }, '24h': { n: 288, avg: 48, label: '4-hour average', span: '24 hours' } };
  function trendData(v) {
    const T = state.trend;
    if (!T) return null;
    const cfg = RANGE[range];
    const basis = (T.calib && finite(T.calib.basis)) ? T.calib.basis : 0;
    const src = range === '24h' ? T.bars5 : T.bars;
    const step = range === '24h' ? 300 : 60;
    if (!src || src.length < 3) return null;
    const startIdx = Math.max(0, src.length - cfg.n);
    const pts3 = [], avg = [];
    for (let i = startIdx; i < src.length; i++) {
      const t = (src[i][0] + step) * 1000;
      pts3.push([t, src[i][4] + basis]);
      if (i - cfg.avg + 1 >= 0) avg.push([t, mean(src.slice(i - cfg.avg + 1, i + 1).map((b) => b[4])) + basis]);
    }
    if (v && finite(v.price)) pts3.push([Math.max(serverNow(), pts3[pts3.length - 1][0]), v.price]);
    return { pts: pts3, avg, cfg };
  }

  function renderTrendChart(v) {
    const box = $('trendChart');
    const d = trendData(v);
    if (!d) { empty(box, 'Trend appears once price history loads.'); return; }
    const { svg, w, h } = frame(box, 220);
    const P = { l: 56, r: 12, t: 10, b: 24 };
    const x0 = d.pts[0][0], x1 = d.pts[d.pts.length - 1][0];
    const vals = d.pts.map((p) => p[1]).concat(d.avg.map((p) => p[1]));
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = Math.max((hi - lo) * 0.08, 5); lo -= pad; hi += pad;
    const x = (t) => P.l + ((t - x0) / (x1 - x0 || 1)) * (w - P.l - P.r);
    const y = (p) => P.t + ((hi - p) / (hi - lo)) * (h - P.t - P.b);
    // past rounds as background bands
    const rounds = (state.trend && state.trend.rounds) || [];
    for (const r of rounds) {
      const a = Math.max(Date.parse(r.open), x0), b = Math.min(Date.parse(r.close), x1);
      if (b <= a) continue;
      el('rect', { x: x(a), y: P.t, width: Math.max(1, x(b) - x(a) - (range === '24h' ? 0 : 1)), height: h - P.t - P.b,
        fill: r.result === 'yes' ? css('--up') : css('--down'), 'fill-opacity': 0.13 }, svg);
    }
    const m = state.live && state.live.market;
    if (m) {
      const a = Math.max(Date.parse(m.open), x0);
      if (a < x1) el('rect', { x: x(a), y: P.t, width: Math.max(1, x(x1) - x(a)), height: h - P.t - P.b, fill: css('--gold'), 'fill-opacity': 0.12 }, svg);
    }
    const step = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000].find((s2) => (hi - lo) / s2 <= 5) || 2000;
    for (let g = Math.ceil(lo / step) * step; g <= hi; g += step) {
      el('line', { x1: P.l, x2: w - P.r, y1: y(g), y2: y(g), stroke: css('--line'), 'stroke-dasharray': '2 4' }, svg);
      const t = el('text', { x: P.l - 8, y: y(g) + 4, 'text-anchor': 'end' }, svg); t.textContent = g.toLocaleString('en-US');
    }
    const t0 = el('text', { x: x(x0), y: h - 6, 'text-anchor': 'start' }, svg); t0.textContent = et(x0);
    const t1 = el('text', { x: x(x1), y: h - 6, 'text-anchor': 'end' }, svg); t1.textContent = 'now';
    if (d.avg.length > 1) el('path', { d: 'M' + d.avg.map(([t, p]) => `${x(t).toFixed(1)},${y(p).toFixed(1)}`).join(' L'), fill: 'none', stroke: css('--muted'), 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }, svg);
    el('path', { d: 'M' + d.pts.map(([t, p]) => `${x(t).toFixed(1)},${y(p).toFixed(1)}`).join(' L'), fill: 'none', stroke: css('--ink'), 'stroke-width': 1.75, 'stroke-linejoin': 'round' }, svg);
    const last = d.pts[d.pts.length - 1];
    el('circle', { cx: x(last[0]), cy: y(last[1]), r: 4, fill: css('--gold'), stroke: css('--surface'), 'stroke-width': 2 }, svg);

    const change = last[1] - d.pts[0][1];
    const avgNow = d.avg.length ? d.avg[d.avg.length - 1][1] : null;
    const pos = finite(avgNow) ? (last[1] >= avgNow ? 'above' : 'below') : null;
    const word = Math.abs(change) < (v && v.speed ? v.speed.v * 2 : 20) ? 'flat' : change > 0 ? 'up' : 'down';
    setText('trendLine', `Over the last ${d.cfg.span} BTC is ${word === 'flat' ? 'roughly flat' : (word === 'up' ? 'up ' : 'down ') + usd(Math.abs(change), 0)}` +
      (pos ? `, and ${pos} its ${d.cfg.label}.` : '.') +
      (word !== 'flat' && pos === (word === 'up' ? 'above' : 'below') ? ` That's a short-term ${word}trend.` : ''));
    box.setAttribute('aria-label', `BTC over the last ${d.cfg.span}: ${word === 'flat' ? 'roughly flat' : word + ' ' + usd(Math.abs(change), 0)}. Shaded bands show past rounds, green for Up and red for Down.`);

    const cross = el('line', { y1: P.t, y2: h - P.b, stroke: css('--gold'), 'stroke-width': 1, visibility: 'hidden' }, svg);
    hover(svg, (e) => {
      const r = svg.getBoundingClientRect();
      const px = clamp(e.clientX - r.left, P.l, w - P.r);
      const t = x0 + ((px - P.l) / (w - P.l - P.r)) * (x1 - x0);
      const a = nearest(d.pts, t);
      if (!a) return;
      const av = nearest(d.avg, t);
      const rd = rounds.find((q) => Date.parse(q.open) <= a[0] && a[0] < Date.parse(q.close) + 1000);
      cross.setAttribute('x1', x(a[0])); cross.setAttribute('x2', x(a[0])); cross.setAttribute('visibility', 'visible');
      const lines = [[et(a[0])], [{ b: usd(a[1]) }]];
      if (av) lines.push(['Average ' + usd(av[1], 0)]);
      if (rd) lines.push([`Round ${et(Date.parse(rd.open))}: `, { b: rd.result === 'yes' ? 'Up' : 'Down' }]);
      showTip(e, lines);
    }, () => cross.setAttribute('visibility', 'hidden'));
  }

  function renderRounds() {
    const rounds = (state.trend && state.trend.rounds) || [];
    const list = $('rounds');
    list.textContent = '';
    if (!rounds.length) { ['rUp', 'rMove', 'rStreak', 'rLast'].forEach((id) => setText(id, '–')); return; }
    const inRange = rounds.slice(0, range === '1h' ? 4 : range === '4h' ? 16 : 96);
    const ups = inRange.filter((r) => r.result === 'yes').length;
    setText('rUp', `${ups} of ${inRange.length} · ${pct(ups / inRange.length, 0)}`);
    const moves = inRange.filter((r) => finite(r.settle) && finite(r.target)).map((r) => Math.abs(r.settle - r.target));
    setText('rMove', moves.length ? usd(mean(moves), 0) : '–');
    let best = { n: 0, res: null }, cur = { n: 0, res: null };
    for (const r of inRange.slice().reverse()) {
      cur = r.result === cur.res ? { n: cur.n + 1, res: r.result } : { n: 1, res: r.result };
      if (cur.n > best.n) best = cur;
    }
    setText('rStreak', `${best.n} ${best.res === 'yes' ? 'Up' : 'Down'} in a row`);
    const lr = rounds[0];
    const mv = finite(lr.settle) && finite(lr.target) ? ' ' + sUsd(lr.settle - lr.target, 0) : '';
    setText('rLast', `${lr.result === 'yes' ? 'Up' : 'Down'}${mv}`);
    for (const r of rounds.slice(0, 9)) {
      const li = document.createElement('li');
      const up = r.result === 'yes';
      li.className = up ? 'up' : 'down';
      const res = document.createElement('span'); res.className = 'r-res'; res.textContent = (up ? '▲ ' : '▼ ') + (up ? 'Up' : 'Down');
      const time = document.createElement('span'); time.className = 'r-time'; time.textContent = et(Date.parse(r.close));
      const mvs = document.createElement('span');
      mvs.textContent = finite(r.settle) && finite(r.target) ? sUsd(r.settle - r.target, 0) : '';
      li.append(res, time, mvs);
      list.appendChild(li);
    }
  }

  document.querySelectorAll('.range-switch button').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.range === range));
    btn.addEventListener('click', () => {
      range = btn.dataset.range;
      store.set('ip.range', range);
      document.querySelectorAll('.range-switch button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      renderRounds();
      renderTrendChart(state.view);
    });
  });

  const CHARTS = { priceChart: renderPriceChart, trendChart: renderTrendChart, landChart: renderLanding, oddsChart: renderOddsChart };

  // ---------- alerts: chime + vibration when a Buy call appears ----------
  const alerts = { on: store.get('ip.alerts', false) === true, ctx: null };
  function unlockAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      alerts.ctx = alerts.ctx || new AC();
      if (alerts.ctx.state === 'suspended') alerts.ctx.resume();
    } catch { /* sound unavailable */ }
  }
  function chime() {
    const ctx = alerts.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    [[880, 0], [1320, 0.16]].forEach(([hz, at]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(0.25, t + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.28);
      o.connect(g); g.connect(ctx.destination);
      o.start(t + at); o.stop(t + at + 0.3);
    });
  }
  function notifyBuy() {
    if (!alerts.on) return;
    chime();
    if (navigator.vibrate) navigator.vibrate([140, 70, 140]);
  }
  function syncAlertButton() {
    $('alertBtn').setAttribute('aria-pressed', String(alerts.on));
    setText('alertLabel', alerts.on ? 'Alerts on' : 'Alert me');
  }
  $('alertBtn').addEventListener('click', () => {
    alerts.on = !alerts.on;
    store.set('ip.alerts', alerts.on);
    if (alerts.on) { unlockAudio(); chime(); }
    syncAlertButton();
    setText('announce', alerts.on ? 'Alerts on. You will hear a chime when a Buy call appears.' : 'Alerts off.');
  });
  // Browsers only allow sound after a tap, so unlock audio on the first touch of the page.
  document.addEventListener('pointerdown', () => { if (alerts.on) unlockAudio(); }, { once: true });

  // ---------- bet log ----------
  let log = store.get('ed.log', []);
  let stakeTouched = false;
  $('logStake').addEventListener('input', () => { stakeTouched = true; $('logStake').removeAttribute('aria-invalid'); setText('stakeMsg', ''); });
  function syncStakeInput(s) {
    if (stakeTouched || !s || !(s.stake > 0)) return;
    $('logStake').value = s.stake.toFixed(2);
  }
  function renderLogButtons(v) {
    const ok = v && v.f && v.secsLeft > 5;
    $('logUp').disabled = !(ok && v.up.ask !== null);
    $('logDn').disabled = !(ok && v.dn.ask !== null);
    $('logUp').textContent = ok && v.up.ask !== null ? `Log Up ${cents(v.up.ask)}` : 'Log Up';
    $('logDn').textContent = ok && v.dn.ask !== null ? `Log Down ${cents(v.dn.ask)}` : 'Log Down';
  }
  function addBet(sideName) {
    const v = state.view;
    if (!v || !v.f) return;
    const s = sideName === 'up' ? v.up : v.dn;
    if (s.ask === null) return;
    const stake = Number($('logStake').value);
    const qty = Math.floor(stake / s.cost);
    if (!(qty >= 1)) {
      $('logStake').setAttribute('aria-invalid', 'true');
      setText('stakeMsg', `Enter at least ${usd(s.cost)}, the cost of one contract.`);
      $('logStake').focus();
      return;
    }
    $('logStake').removeAttribute('aria-invalid');
    setText('stakeMsg', `Logged ${qty} ${sideName === 'up' ? 'Up' : 'Down'} contract${qty > 1 ? 's' : ''} at ${cents(s.ask)}.`);
    log.unshift({
      id: Date.now().toString(36), t: serverNow(), ticker: v.m.ticker, open: v.m.open, close: v.m.close, side: sideName,
      price: s.ask, fee: s.fee, p: s.p, edge: s.edge, qty, cost: qty * s.cost, result: null,
    });
    store.set('ed.log', log);
    renderLog();
  }
  $('logUp').addEventListener('click', () => addBet('up'));
  $('logDn').addEventListener('click', () => addBet('down'));
  $('logForm').addEventListener('submit', (e) => e.preventDefault());
  $('clearLog').addEventListener('click', () => { $('clearConfirm').hidden = false; $('clearLog').hidden = true; });
  $('clearNo').addEventListener('click', () => { $('clearConfirm').hidden = true; $('clearLog').hidden = false; });
  $('clearYes').addEventListener('click', () => { log = []; store.set('ed.log', log); $('clearConfirm').hidden = true; $('clearLog').hidden = false; renderLog(); });

  const pnl = (b) => (b.result === null ? null : (b.result === (b.side === 'up' ? 'yes' : 'no') ? b.qty - b.cost : -b.cost));
  function renderLog() {
    const body = $('logBody'); body.textContent = '';
    $('logEmpty').hidden = log.length > 0;
    $('logTable').hidden = log.length === 0;
    log.forEach((b) => {
      const tr = document.createElement('tr');
      const r = pnl(b);
      const cells = [
        et(Date.parse(b.close)),
        b.side === 'up' ? 'Up' : 'Down',
        cents(b.price),
        usd(b.cost),
        r === null ? 'Pending' : (r >= 0 ? 'Won ' : 'Lost ') + money(r),
      ];
      cells.forEach((c, i) => {
        const td = document.createElement('td'); td.textContent = c;
        if (i === 1) td.className = b.side === 'up' ? 'pos' : 'neg';
        if (i === 4 && r !== null) td.className = r >= 0 ? 'pos' : 'neg';
        if (i === 4 && r === null) td.className = 'dim';
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    const done = log.filter((b) => b.result !== null);
    const won = done.filter((b) => pnl(b) > 0).length;
    const total = done.reduce((t, b) => t + pnl(b), 0);
    const expected = done.reduce((t, b) => t + b.edge * b.qty, 0);
    setText('sBets', String(log.length));
    setText('sWin', done.length ? `${won}/${done.length} · ${pct(won / done.length, 0)}` : '–');
    setText('sPnl', money(total), signClass(total));
    setText('sExp', money(expected), signClass(expected));
  }

  async function resolveBets() {
    const now = serverNow();
    const pending = [...new Set(log.filter((b) => b.result === null && Date.parse(b.close) < now).map((b) => b.ticker))];
    if (!pending.length) return;
    try {
      const r = await fetch('/api/result?tickers=' + encodeURIComponent(pending.join(',')), { cache: 'no-store' });
      const j = await r.json();
      let changed = false;
      log.forEach((b) => {
        const res = j.results && j.results[b.ticker];
        if (b.result === null && res && (res.result === 'yes' || res.result === 'no')) { b.result = res.result; changed = true; }
      });
      if (changed) { store.set('ed.log', log); renderLog(); }
    } catch (e) { /* retry next cycle */ }
  }

  // ---------- loops ----------
  // In the background the desk sleeps (saves battery and data), unless alerts are on,
  // in which case it keeps checking the call every 5 seconds.
  function loop(fn, ms, always) {
    const run = async () => {
      const hidden = document.hidden;
      if (!hidden || always || alerts.on) await fn();
      setTimeout(run, hidden ? (alerts.on ? Math.max(ms, 5000) : Math.max(ms, 2000)) : ms);
    };
    run();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (!alerts.on) pauseStream(); }
    else { resumeStream(); pollLive(); pollContext(); }
  });
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => renderCharts(state.view), 150); });

  // Keyboard: focus a chart, then arrow keys move the read-out (Shift for bigger steps).
  ['landChart', 'oddsChart', 'priceChart', 'trendChart'].forEach((id) => {
    const box = $(id);
    box.__frac = 1;
    const show = () => {
      const svg = box.querySelector('svg');
      if (!svg || !box.__move) return;
      const r = svg.getBoundingClientRect();
      const ev = { clientX: r.left + box.__frac * r.width, clientY: r.top + r.height * 0.3 };
      pointer = { id, clientX: ev.clientX, clientY: ev.clientY };
      tip.setAttribute('aria-live', 'polite');
      box.__move(ev);
    };
    box.addEventListener('focus', () => { box.__frac = id === 'landChart' ? 0.5 : 1; show(); });
    box.addEventListener('blur', () => { pointer = null; hideTip(); tip.removeAttribute('aria-live'); });
    box.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.2 : 0.04;
      if (e.key === 'ArrowLeft') box.__frac = Math.max(0, box.__frac - step);
      else if (e.key === 'ArrowRight') box.__frac = Math.min(1, box.__frac + step);
      else if (e.key === 'Home') box.__frac = 0;
      else if (e.key === 'End') box.__frac = 1;
      else if (e.key === 'Escape') { hideTip(); return; }
      else return;
      e.preventDefault();
      show();
    });
  });
  window.addEventListener('themechange', () => renderCharts(state.view));

  // ---------- Simple / Pro ----------
  function setView(mode) {
    document.documentElement.dataset.view = mode;
    try { localStorage.setItem('ip.view', mode); } catch { /* per-device only */ }
    $('viewSimple').setAttribute('aria-pressed', String(mode !== 'pro'));
    $('viewPro').setAttribute('aria-pressed', String(mode === 'pro'));
    render();
  }
  $('viewSimple').addEventListener('click', () => setView('simple'));
  $('viewPro').addEventListener('click', () => setView('pro'));
  if (isPro()) { $('viewSimple').setAttribute('aria-pressed', 'false'); $('viewPro').setAttribute('aria-pressed', 'true'); }

  // ---------- explainers ----------
  document.querySelectorAll('.info-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', String(open));
      $(btn.getAttribute('aria-controls')).hidden = !open;
    });
  });

  // ---------- first-visit guide ----------
  if (store.get('ip.guide', null) !== 'done') $('guide').hidden = false;
  $('guideClose').addEventListener('click', () => { $('guide').hidden = true; store.set('ip.guide', 'done'); $('main').focus(); });
  $('guideOpen').addEventListener('click', () => {
    $('guide').hidden = false;
    $('guide').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('guideTitle').setAttribute('tabindex', '-1');
    $('guideTitle').focus({ preventScroll: true });
  });

  // ---------- Home Screen ----------
  // Remove the private sign-in link from the address once the server has used it.
  if (/[?&]_vercel_share=/.test(location.search)) history.replaceState(null, '', location.pathname + location.hash);
  const standalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let installEvt = null;
  function syncInstall(force) {
    const card = $('install');
    if (standalone()) { card.hidden = true; $('installOpen').hidden = true; return; }
    $('installOpen').hidden = false;
    const canPrompt = !!installEvt;
    $('installBtn').hidden = !canPrompt;
    $('installSteps').hidden = canPrompt || !isIOS;
    setText('installSub', canPrompt || isIOS
      ? 'Opens full screen like an app.'
      : 'Open your browser menu and choose Install app or Add to Home Screen. It opens full screen like an app.');
    if (force) card.hidden = false;
    else card.hidden = store.get('ip.install', null) === 'later';
  }
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; syncInstall(); });
  window.addEventListener('appinstalled', () => { installEvt = null; $('install').hidden = true; setText('announce', 'Installed. Open Investment Project from your Home Screen.'); });
  $('installBtn').addEventListener('click', async () => {
    if (!installEvt) return;
    installEvt.prompt();
    try { await installEvt.userChoice; } catch { /* dismissed */ }
    installEvt = null;
    syncInstall();
  });
  $('installLater').addEventListener('click', () => { store.set('ip.install', 'later'); $('install').hidden = true; $('main').focus(); });
  $('installOpen').addEventListener('click', () => {
    syncInstall(true);
    $('install').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('installTitle').setAttribute('tabindex', '-1');
    $('installTitle').focus({ preventScroll: true });
  });
  syncInstall();

  Object.keys(CHARTS).forEach((id) => chartObserver && chartObserver.observe($(id)));
  bindSettings();
  renderLog();
  syncAlertButton();
  render();
  connectStream();
  loop(pollTrend, TREND_MS);
  loop(pollContext, CONTEXT_MS);
  loop(pollLive, LIVE_MS);
  loop(resolveBets, RESULT_MS, true);
  setInterval(tick, 250);
})();
