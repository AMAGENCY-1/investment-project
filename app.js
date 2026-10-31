/* Investment Project client: streams Coinbase ticks over WebSocket, polls
   /api/live (1s) and /api/context (15s), prices the
   Kalshi BTC 15-minute market with a random-walk model of the settlement
   average, and shows where our odds and Kalshi's price disagree. */
(() => {
  'use strict';

  const LIVE_MS = 1000;
  const STREAM_URL = 'wss://ws-feed.exchange.coinbase.com';
  const CONTEXT_MS = 15000;
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
    live: null, ctx: null, offset: 0, lastOk: 0, everOk: false,
    ticker: null, series: [], history: [], view: null,
  };
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
    const cal = state.ctx && state.ctx.calib;
    const cb = spot.venues.find((x) => x.name === 'Coinbase');
    if (cal && finite(cal.basis)) {
      const base = streamFresh() ? stream.price : cb ? cb.mid : spot.composite;
      return { price: base + cal.basis, basis: cal.basis, n: cal.n, spread: cal.spread, calibrated: true };
    }
    return { price: streamFresh() ? stream.price : spot.composite, calibrated: false };
  }

  function chooseSpeed() {
    const s = state.ctx && state.ctx.speed;
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
  const stream = { price: null, t: 0, open: false, retries: 0, ws: null };
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
    ws.onclose = () => { stream.open = false; if (stream.ws === ws) retryStream(); };
    ws.onerror = () => { try { ws.close(); } catch { /* already closed */ } };
  }
  function retryStream() {
    const wait = Math.min(30000, 1000 * 2 ** stream.retries++);
    setTimeout(connectStream, wait);
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
      const r = await fetch('/api/live', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
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
  function render() {
    const v = compute();
    state.view = v;
    renderHero(v);
    renderMetrics(v);
    renderOdds(v);
    renderLadders();
    renderContext(v);
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
    renderOdds(v);
    renderLogButtons(v);
  }

  let lastSpoken = null;
  function renderHero(v) {
    const verdict = $('verdict');
    if (!v) {
      setText('windowLabel', state.everOk ? 'Between windows' : 'Finding the live window…');
      verdict.dataset.state = 'wait';
      setText('verdictWord', 'Wait');
      setText('verdictSub', state.everOk ? 'The next 15-minute window opens shortly.' : 'Loading live prices');
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
    let stateName = 'skip', word = 'Skip', sub;
    if (v.secsLeft <= 5) {
      word = 'Closed'; stateName = 'wait'; sub = 'Window is settling. Next one opens at ' + et(v.closeMs) + '.';
    } else if (!best) {
      sub = 'No asks on Kalshi right now.';
    } else if (finite(v.mid) && Math.abs(v.pUp - v.mid) > 0.25) {
      word = 'Check data';
      sub = `Our odds and Kalshi are ${Math.abs((v.pUp - v.mid) * 100).toFixed(0)} pts apart. Kalshi sees the real index, so this is more likely a data gap than an edge.`;
    } else if (best[1].edge >= min && best[1].qty >= 1) {
      stateName = best[0]; word = best[0] === 'up' ? 'Buy Up' : 'Buy Down';
      sub = `Our odds ${odds(best[1].p)} vs Kalshi ${cents(best[1].ask)} + fee`;
    } else if (best[1].edge >= min) {
      sub = `${best[0] === 'up' ? 'Up' : 'Down'} has an edge, but your bankroll is too small for one contract.`;
    } else {
      sub = `Best is ${best[0] === 'up' ? 'Up' : 'Down'} at ${pts(best[1].edge)}, under your ${settings.minEdge} pt bar.`;
    }
    verdict.dataset.state = stateName;
    setText('verdictWord', word);
    setText('verdictSub', sub);
    if (word !== lastSpoken) { lastSpoken = word; setText('announce', `Call: ${word}. ${sub || ''}`); }
    const s = stateName === 'up' ? v.up : stateName === 'down' ? v.dn : null;
    setText('tStake', s ? usd(s.stake) : '$0', '');
    setText('tQty', s ? String(s.qty) : '0', '');
    setText('tPays', s ? usd(s.qty) : '–', '');
    setText('tEdge', best ? pts(best[1].edge) : '–', best ? signClass(best[1].edge) : '');
    syncStakeInput(s);
  }

  function renderMetrics(v) {
    const live = state.live;
    if (!v) { ['mTarget', 'mNow', 'mGap', 'mSpeed'].forEach((id) => setText(id, '–')); return; }
    setText('mTarget', finite(v.target) ? usd(v.target) : 'At open');
    setText('mNow', usd(v.price));
    const gap = finite(v.price) && finite(v.target) ? v.price - v.target : null;
    setText('mGap', sUsd(gap), signClass(gap));
    setText('mGapNote', finite(gap) ? (gap >= 0 ? 'above target' : 'below target') : 'now vs target');
    setText('mSpeed', v.speed ? usd(v.speed.v, 0) + '/min' : '–');
    setText('mSpeedNote', v.speed ? v.speed.label : 'typical move / min');
    if (v.est && v.est.calibrated) setText('mNowNote', `index est. · Coinbase ${sUsd(v.est.basis)}`);
    else if (live && live.spot) setText('mNowNote', `${live.spot.venues.length}-exchange median`);
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

    const s = c.speed;
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
    if (c.calib && finite(c.calib.basis)) {
      const el = $('pCal');
      el.textContent = `Coinbase ${sUsd(c.calib.basis)}`;
      const sm = document.createElement('small');
      sm.textContent = `from the last ${c.calib.n} Kalshi targets` + (finite(c.calib.spread) ? `, ±${usd(c.calib.spread)}` : '');
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
    markets: 'Kalshi markets', recent: 'Kalshi targets', orderbook: 'Kalshi book', coinbase: 'Coinbase', kraken: 'Kraken', bitstamp: 'Bitstamp', gemini: 'Gemini',
    candles: 'Coinbase candles', cbBook: 'Coinbase book', krBook: 'Kraken book', trades: 'Coinbase trades', perp: 'Deribit perp',
    perpTrades: 'Deribit trades', dvol: 'Deribit DVOL', hl: 'Hyperliquid',
  };
  function renderSources() {
    const el = $('sources'); el.textContent = '';
    const sc = document.createElement('li');
    sc.textContent = (streamFresh() ? '✓ ' : '✕ ') + 'Coinbase stream';
    if (!streamFresh()) { sc.classList.add('bad'); sc.title = 'Using 1-second polling instead'; }
    el.appendChild(sc);
    const errs = { ...((state.live && state.live.errors) || {}), ...((state.ctx && state.ctx.errors) || {}) };
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
    const p = document.createElement('p'); p.className = 'chart-empty'; p.textContent = msg; container.appendChild(p);
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

  function renderCharts(v) {
    renderLanding(v);
    renderOddsChart(v);
    renderPriceChart(v);
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
    const bars = (state.ctx && state.ctx.speed && state.ctx.speed.bars) || [];
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
    const bars = (state.ctx && state.ctx.speed && state.ctx.speed.bars) || [];
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
  function loop(fn, ms) {
    const run = async () => {
      if (!document.hidden) await fn();
      setTimeout(run, document.hidden ? ms * 3 : ms);
    };
    run();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollLive(); pollContext(); } });
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => renderCharts(state.view), 150); });

  // Keyboard: focus a chart, then arrow keys move the read-out (Shift for bigger steps).
  ['landChart', 'oddsChart', 'priceChart'].forEach((id) => {
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

  bindSettings();
  renderLog();
  render();
  connectStream();
  loop(pollContext, CONTEXT_MS);
  loop(pollLive, LIVE_MS);
  loop(resolveBets, RESULT_MS);
  setInterval(tick, 250);
})();
