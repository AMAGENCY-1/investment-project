/* Investment Project · Sports: NBA player props on Kalshi. Loads /api/nba (Kalshi
   prices + ESPN-based projections), works out value with your settings, and shows
   the evidence behind every prop. Includes a bet cap and a daily loss limit. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const REFRESH_MS = 120000;
  const PAGE = 30;

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* per-device only */ } },
  };
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  const MINUS = '−';
  const usd = (v, d = 2) => (finite(v) ? '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–');
  const money = (v) => (finite(v) ? (v < 0 ? MINUS : '') + usd(v) : '–');
  const cents = (p) => (finite(p) ? Math.round(p * 100) + '¢' : '–');
  const pct = (p) => (finite(p) ? Math.round(p * 100) + '%' : '–');
  const pts = (e) => (finite(e) ? (e >= 0 ? '+' : MINUS) + Math.abs(e * 100).toFixed(1) + ' pts' : '–');
  const etDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const etTime = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const signClass = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  function setText(id, text, cls) {
    const el = $(id); if (!el) return;
    el.textContent = text;
    if (cls !== undefined) { el.classList.remove('pos', 'neg', 'dim'); if (cls) el.classList.add(cls); }
  }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

  // ---------- settings ----------
  const DEFAULTS = { bank: 10, maxBet: 2, limit: 10, minEdge: 6, fee: 0.07 };
  const settings = { ...DEFAULTS, ...store.get('ip.sports.settings', {}) };
  const FIELDS = { bank: 'sBank', maxBet: 'sMaxBet', limit: 'sLimit', minEdge: 'sMinEdge', fee: 'sFee' };
  for (const [k, id] of Object.entries(FIELDS)) {
    const input = $(id);
    input.value = settings[k];
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (!finite(v) || v < 0) { input.value = settings[k]; return; }
      settings[k] = v; store.set('ip.sports.settings', settings); render();
    });
  }

  // ---------- state ----------
  const state = { data: store.get('ip.nba', null), filter: { stat: 'all', game: 'all', q: '', goodOnly: false }, shown: PAGE, loadedAt: 0, failed: false };
  if (state.data && Date.now() - state.data.serverTime > 45 * 60 * 1000) state.data = null;
  let log = store.get('ip.sportslog', []);

  // ---------- daily limit ----------
  function today() {
    const day = etDay(Date.now());
    let realized = 0, pending = 0;
    for (const b of log) {
      if (etDay(b.t) !== day) continue;
      if (b.result === null) pending += b.cost;
      else realized += pnl(b);
    }
    const worst = realized - pending;
    return { realized, pending, worst, locked: worst <= -settings.limit };
  }
  const pnl = (b) => (b.result === null ? null : (b.result === b.side ? b.qty - b.cost : -b.cost));

  // ---------- value ----------
  function evaluate(pr, pl, locked) {
    if (pl.state && pl.state !== 'pre') return { chip: pl.state === 'post' ? 'Final' : 'Game started', cls: 'fair', state: 'live', note: 'Pre-game projections no longer apply once the game starts.' };
    if (pl.injury && /out/i.test(pl.injury.status)) return { chip: 'Out', cls: 'bad', state: 'out', note: 'Listed as out on the injury report.' };
    if (pr.chance === null) return { chip: 'No data', cls: 'fair', state: 'nodata', note: pr.reason };
    const fee = (p) => settings.fee * p * (1 - p);
    const ok = (a) => finite(a) && a > 0 && a < 1;
    const yesCost = ok(pr.yesAsk) ? pr.yesAsk + fee(pr.yesAsk) : null;
    const noCost = ok(pr.noAsk) ? pr.noAsk + fee(pr.noAsk) : null;
    let best = null;
    if (yesCost !== null) best = { side: 'yes', edge: pr.chance - yesCost, cost: yesCost, price: pr.yesAsk, p: pr.chance };
    if (noCost !== null) { const e = 1 - pr.chance - noCost; if (!best || e > best.edge) best = { side: 'no', edge: e, cost: noCost, price: pr.noAsk, p: 1 - pr.chance }; }
    const spread = ok(pr.yesAsk) ? pr.yesAsk - (finite(pr.yesBid) ? pr.yesBid : 0) : null;
    if (!best) return { chip: 'No offers', cls: 'fair', state: 'none', spread };
    const v = { ...best, spread };
    const min = settings.minEdge / 100;
    if (best.edge >= min) {
      if (pl.injury) return { ...v, chip: 'Injury risk', cls: 'warn', state: 'risk', note: `On the injury report (${pl.injury.status}).` };
      if (spread !== null && spread > 0.10) return { ...v, chip: 'Wide spread', cls: 'warn', state: 'thin', note: 'Few traders here, so the asking price is unreliable. Consider a limit order at our fair price.' };
      if (pl.games < 15) return { ...v, chip: 'Thin history', cls: 'warn', state: 'thin', note: 'Not enough games to trust the projection.' };
      if (locked) return { ...v, chip: 'Daily limit reached', cls: 'bad', state: 'locked', note: 'Suggestions resume tomorrow.' };
      const kelly = best.edge / (1 - best.cost);
      const stake = Math.min(settings.bank * 0.25 * kelly, settings.maxBet);
      const qty = Math.floor(stake / best.cost);
      if (qty < 1) return { ...v, chip: 'Good value', cls: 'ok', state: 'good', qty: 0, note: 'One contract costs more than your max bet.' };
      return { ...v, chip: `Good value · ${best.side === 'yes' ? 'Yes' : 'No'} ${pts(best.edge)}`, cls: 'ok', state: 'good', qty, stake: qty * best.cost };
    }
    if (best.edge > -min) return { ...v, chip: 'About fair', cls: 'fair', state: 'fair' };
    return { ...v, chip: 'No value', cls: 'fair', state: 'novalue' };
  }

  // ---------- filters ----------
  const COMBOS = new Set(['pra', 'pr', 'pa', 'ra']);
  const DEF = new Set(['stl', 'blk', 'stocks']);
  function matches(pr, pl) {
    const f = state.filter;
    if (f.stat !== 'all') {
      if (f.stat === 'combo' && !COMBOS.has(pr.stat)) return false;
      if (f.stat === 'def' && !DEF.has(pr.stat)) return false;
      if (f.stat !== 'combo' && f.stat !== 'def' && pr.stat !== f.stat) return false;
    }
    if (f.game !== 'all' && pl.game !== f.game) return false;
    if (f.q && !pl.name.toLowerCase().includes(f.q)) return false;
    return true;
  }
  document.querySelectorAll('#statChips button').forEach((b) => b.addEventListener('click', () => {
    state.filter.stat = b.dataset.stat; state.shown = PAGE;
    document.querySelectorAll('#statChips button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  }));
  $('gameSel').addEventListener('change', (e) => { state.filter.game = e.target.value; state.shown = PAGE; render(); });
  $('search').addEventListener('input', (e) => { state.filter.q = e.target.value.trim().toLowerCase(); state.shown = PAGE; render(); });
  $('goodOnly').addEventListener('change', (e) => { state.filter.goodOnly = e.target.checked; state.shown = PAGE; render(); });
  $('more').addEventListener('click', () => { state.shown += PAGE; render(); });

  // ---------- render ----------
  const rank = { good: 0, risk: 1, thin: 1, locked: 1, fair: 2, novalue: 3, none: 4, nodata: 5, live: 6, out: 7 };
  function render() {
    const d = state.data;
    const t = today();
    setText('kToday', money(t.realized - t.pending), signClass(t.realized - t.pending));
    const frac = Math.min(1, Math.max(0, -t.worst / settings.limit));
    $('limitFill').style.width = (frac * 100).toFixed(1) + '%';
    $('limitMeter').dataset.state = t.locked ? 'stop' : frac > 0.6 ? 'warn' : '';
    setText('limitText', t.locked
      ? `Daily loss limit of ${usd(settings.limit, 0)} reached (including ${usd(t.pending)} still pending). Buy suggestions are off until tomorrow.`
      : `Daily loss limit: ${usd(settings.limit, 0)}. ${usd(Math.max(0, settings.limit + t.worst))} left today, counting pending bets as losses.`);
    const list = $('props');
    list.textContent = '';
    if (!d) {
      const li = el('li', 'skeleton', state.failed ? 'Couldn’t load props. Pull to refresh or try again shortly.' : 'Loading props and stats…');
      list.appendChild(li);
      return;
    }
    const games = {};
    for (const pl of Object.values(d.players)) games[pl.game] = pl;
    const sel = $('gameSel');
    if (sel.options.length - 1 !== Object.keys(games).length) {
      const cur = sel.value;
      sel.length = 1;
      Object.entries(games).sort((a, b) => Date.parse(a[1].start || 0) - Date.parse(b[1].start || 0)).forEach(([code, pl]) => {
        const o = el('option', '', `${pl.team} / ${pl.opp}${pl.start ? ' · ' + etTime(pl.start) : ''}`); o.value = code; sel.appendChild(o);
      });
      sel.value = [...sel.options].some((o) => o.value === cur) ? cur : 'all';
    }
    const rows = d.props.map((pr) => {
      const pl = d.players[pr.pid];
      return { pr, pl, v: evaluate(pr, pl, t.locked) };
    });
    const good = rows.filter((r) => r.v.state === 'good').length;
    setText('kProps', String(d.props.length));
    setText('kGames', String(Object.keys(games).length));
    setText('kGood', String(good), good ? 'pos' : '');
    const firstStart = Object.values(games).map((g) => g.start).filter(Boolean).sort()[0];
    setText('slateLabel', firstStart ? `First tip ${etTime(firstStart)} ET` : 'Upcoming games');
    let shown = rows.filter((r) => r.pl && matches(r.pr, r.pl));
    if (state.filter.goodOnly) shown = shown.filter((r) => r.v.state === 'good');
    shown.sort((a, b) => (rank[a.v.state] - rank[b.v.state]) || ((b.v.edge ?? -9) - (a.v.edge ?? -9)));
    setText('listHint', `${shown.length} prop${shown.length === 1 ? '' : 's'}`);
    $('propsEmpty').hidden = shown.length > 0;
    if (!shown.length) setText('propsEmpty', state.filter.goodOnly ? 'No good-value props right now. That’s common: Kalshi prices are usually fair. Check back closer to tip-off.' : 'No props match these filters.');
    shown.slice(0, state.shown).forEach((r) => list.appendChild(card(r)));
    $('more').hidden = shown.length <= state.shown;
  }

  function card({ pr, pl, v }) {
    const li = el('li', 'prop');
    li.dataset.state = v.state;
    const top = el('div', 'prop-top');
    const who = el('div', 'prop-who');
    who.append(el('span', 'prop-name', pl.name), el('span', 'prop-meta', `${pl.team} ${pl.home === false ? '@' : 'vs'} ${pl.opp}${pl.start ? ' · ' + etTime(pl.start) : ''}`));
    top.append(who, el('span', 'chip ' + v.cls, v.chip));
    li.append(top, el('div', 'prop-line', `${pr.line}+ ${pr.statLabel}`));
    if (pr.chance !== null) {
      const bar = (label, frac, cls, text) => {
        const r = el('div', 'vbar');
        const t = el('span', 'track'); t.setAttribute('aria-hidden', 'true');
        const f = el('i', cls); f.style.width = (Math.max(0, Math.min(1, frac)) * 100).toFixed(1) + '%';
        t.appendChild(f);
        r.append(el('span', 'vlab', label), t, el('span', 'vnum', text));
        return r;
      };
      li.append(bar('Our chance', pr.chance, 'ours-up', pct(pr.chance)));
      if (finite(pr.yesAsk) && pr.yesAsk > 0 && pr.yesAsk < 1) li.append(bar('Kalshi Yes', pr.yesAsk, 'price', cents(pr.yesAsk)));
    }
    if (v.state === 'good' && v.qty > 0) {
      const p = el('p', 'prop-call');
      const b = el('b', '', `Buy ${v.side === 'yes' ? 'Yes' : 'No'}`);
      p.append(b, ` (${v.side === 'yes' ? pr.line + '+' : 'under ' + pr.line}) at ${cents(v.price)} · bet ${usd(v.stake)} · ${v.qty} contract${v.qty > 1 ? 's' : ''}`);
      li.append(p);
    } else if (v.note) li.append(el('p', 'prop-fair', v.note));
    if (pr.chance !== null && v.state !== 'live' && v.state !== 'out') li.append(el('p', 'prop-fair', `Our fair price: Yes ${cents(pr.chance)} · No ${cents(1 - pr.chance)}${finite(v.spread) ? ` · Kalshi spread ${cents(v.spread)}` : ''}`));
    if (pr.evidence) li.append(why(pr, pl, v));
    return li;
  }

  const DIR = { over: ['up', '▲', 'Over'], under: ['down', '▼', 'Under'], flat: ['flat', '–', 'Neutral'], warn: ['flat', '!', 'Injury'], model: ['flat', '≈', 'Model'] };
  function why(pr, pl, v) {
    const det = el('details', 'prop-why');
    det.append(el('summary', '', 'Why'));
    det.addEventListener('toggle', () => {
      if (!det.open || det.dataset.built) return;
      det.dataset.built = '1';
      const ul = el('ul', 'evidence');
      for (const e of pr.evidence) {
        const [dir, icon, tag] = DIR[e.dir] || DIR.flat;
        const li = el('li', 'ev'); li.dataset.dir = dir;
        const ic = el('span', 'ev-icon', icon); ic.setAttribute('aria-hidden', 'true');
        li.append(ic, el('span', 'ev-title', tag), el('span', 'ev-tag', ''), el('span', 'ev-text', e.text));
        ul.appendChild(li);
      }
      det.append(ul, miniChart(pr, pl));
      det.append(el('p', 'mini-cap', 'Last 10 games, oldest to newest. The dashed line is the target.'));
      det.append(logControls(pr, pl, v));
    });
    return det;
  }

  function miniChart(pr, pl) {
    const NS = 'http://www.w3.org/2000/svg';
    const games = pl.recent.slice(0, 10).reverse();
    const vals = games.map((g) => statValue(g, pr.stat));
    const W = 320, H = 108, P = { l: 6, r: 6, t: 16, b: 18 };
    const max = Math.max(pr.line, ...vals, 1) * 1.1;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'mini');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Last ${vals.length} games: ${vals.join(', ')}. Target ${pr.line}.`);
    const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const bw = (W - P.l - P.r) / Math.max(vals.length, 1);
    const y = (v) => P.t + (1 - v / max) * (H - P.t - P.b);
    const add = (tag, attrs, text) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); if (text !== undefined) n.textContent = text; svg.appendChild(n); return n; };
    vals.forEach((v, i) => {
      const x = P.l + i * bw + 3, w = bw - 6;
      const hit = v >= pr.line;
      add('rect', { x, y: y(v), width: Math.max(2, w), height: Math.max(1, y(0) - y(v)), rx: 3, fill: hit ? css('--up') : css('--price-fill') });
      add('text', { x: x + w / 2, y: y(v) - 4, 'text-anchor': 'middle' }, String(v));
      add('text', { x: x + w / 2, y: H - 4, 'text-anchor': 'middle' }, games[i].o || '');
    });
    add('line', { x1: P.l, x2: W - P.r, y1: y(pr.line - 0.5), y2: y(pr.line - 0.5), stroke: css('--gold'), 'stroke-width': 1.5, 'stroke-dasharray': '4 3' });
    return svg;
  }
  function statValue(g, key) {
    switch (key) {
      case 'pra': return g.pts + g.reb + g.ast;
      case 'pr': return g.pts + g.reb;
      case 'pa': return g.pts + g.ast;
      case 'ra': return g.reb + g.ast;
      case 'stocks': return g.stl + g.blk;
      default: return g[key];
    }
  }

  // ---------- bet log ----------
  function logControls(pr, pl, v) {
    const wrap = el('form', 'log-actions');
    wrap.noValidate = true;
    wrap.addEventListener('submit', (e) => e.preventDefault());
    const id = 'stake-' + pr.ticker.replace(/[^A-Za-z0-9]/g, '');
    const field = el('div', 'stake-field');
    const label = el('label', '', 'Bet ($)'); label.htmlFor = id;
    const input = el('input'); input.id = id; input.type = 'number'; input.inputMode = 'decimal'; input.min = '0.01'; input.step = '0.01';
    input.value = (v.stake || 1).toFixed(2);
    field.append(label, input);
    const msg = el('p', 'field-msg'); msg.setAttribute('aria-live', 'polite');
    const mk = (side) => {
      const price = side === 'yes' ? pr.yesAsk : pr.noAsk;
      const b = el('button', 'btn ' + (side === 'yes' ? 'btn-up' : 'btn-down'), `Log ${side === 'yes' ? 'Yes' : 'No'} ${cents(price)}`);
      b.type = 'button';
      b.disabled = !(finite(price) && price > 0 && price < 1) || pl.state !== 'pre';
      b.addEventListener('click', () => {
        const fee = settings.fee * price * (1 - price);
        const cost = price + fee;
        const qty = Math.floor(Number(input.value) / cost);
        if (!(qty >= 1)) { input.setAttribute('aria-invalid', 'true'); msg.textContent = `Enter at least ${usd(cost)}, the cost of one contract.`; return; }
        if (today().locked) { msg.textContent = 'Daily loss limit reached. Logging is still allowed, but consider stopping for today.'; }
        input.removeAttribute('aria-invalid');
        const p = side === 'yes' ? pr.chance : 1 - pr.chance;
        log.unshift({ id: Date.now().toString(36), t: Date.now(), ticker: pr.ticker, player: pl.name, stat: pr.statShort, line: pr.line, side, price, fee, p, edge: p - cost, qty, cost: qty * cost, result: null });
        store.set('ip.sportslog', log);
        msg.textContent = `Logged ${qty} ${side === 'yes' ? 'Yes' : 'No'} at ${cents(price)}.`;
        renderLog(); render();
      });
      return b;
    };
    wrap.append(field, mk('yes'), mk('no'), msg);
    return wrap;
  }

  function renderLog() {
    const body = $('logBody'); body.textContent = '';
    $('logEmpty').hidden = log.length > 0;
    $('logTable').hidden = log.length === 0;
    for (const b of log) {
      const tr = document.createElement('tr');
      const r = pnl(b);
      const cells = [`${b.player} ${b.line}+ ${b.stat}`, b.side === 'yes' ? 'Yes' : 'No', cents(b.price), usd(b.cost), r === null ? 'Pending' : (r >= 0 ? 'Won ' : 'Lost ') + money(r)];
      cells.forEach((c, i) => {
        const td = el('td', '', c);
        if (i === 4) td.className = r === null ? 'dim' : r >= 0 ? 'pos' : 'neg';
        tr.appendChild(td);
      });
      body.appendChild(tr);
    }
    const done = log.filter((b) => b.result !== null);
    const won = done.filter((b) => pnl(b) > 0).length;
    const total = done.reduce((t, b) => t + pnl(b), 0);
    const expected = done.reduce((t, b) => t + b.edge * b.qty, 0);
    setText('sBets', String(log.length));
    setText('sWin', done.length ? `${won}/${done.length}` : '–');
    setText('sPnl', money(total), signClass(total));
    setText('sExp', money(expected), signClass(expected));
  }
  $('clearLog').addEventListener('click', () => { $('clearConfirm').hidden = false; $('clearLog').hidden = true; });
  $('clearNo').addEventListener('click', () => { $('clearConfirm').hidden = true; $('clearLog').hidden = false; });
  $('clearYes').addEventListener('click', () => { log = []; store.set('ip.sportslog', log); $('clearConfirm').hidden = true; $('clearLog').hidden = false; renderLog(); render(); });

  async function resolveBets() {
    const pending = [...new Set(log.filter((b) => b.result === null).map((b) => b.ticker))].slice(0, 25);
    if (!pending.length) return;
    try {
      const r = await fetch('/api/result?tickers=' + encodeURIComponent(pending.join(',')), { cache: 'no-store' });
      const j = await r.json();
      let changed = false;
      for (const b of log) {
        const res = j.results && j.results[b.ticker];
        if (b.result === null && res && (res.result === 'yes' || res.result === 'no')) { b.result = res.result; changed = true; }
      }
      if (changed) { store.set('ip.sportslog', log); renderLog(); render(); }
    } catch { /* try again later */ }
  }

  // ---------- data ----------
  async function load() {
    try {
      const r = await fetch('/api/nba', { cache: 'no-store', redirect: 'manual' });
      if (r.type === 'opaqueredirect' || r.status === 401 || r.status === 403) { $('authBanner').hidden = false; throw new Error('signed out'); }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      $('authBanner').hidden = true;
      state.data = await r.json();
      state.loadedAt = Date.now(); state.failed = false;
      store.set('ip.nba', state.data);
      if (state.data.rulesNote) setText('rulesNote', 'Kalshi rules: ' + state.data.rulesNote);
    } catch (e) {
      state.failed = !state.data;
    }
    status();
    render();
  }
  function status() {
    const st = $('status');
    if (state.loadedAt) {
      st.dataset.state = 'live';
      const mins = Math.round((Date.now() - state.loadedAt) / 60000);
      setText('statusText', mins < 1 ? 'Updated now' : `Updated ${mins} min ago`);
    } else if (state.failed) { st.dataset.state = 'error'; setText('statusText', 'Offline'); }
  }

  // ---------- explainers ----------
  document.querySelectorAll('.info-btn').forEach((btn) => btn.addEventListener('click', () => {
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    $(btn.getAttribute('aria-controls')).hidden = !open;
  }));

  // ---------- Home Screen ----------
  if (/[?&]_vercel_share=/.test(location.search)) history.replaceState(null, '', location.pathname + location.hash);
  const standalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let installEvt = null;
  function syncInstall(force) {
    if (standalone()) { $('install').hidden = true; $('installOpen').hidden = true; return; }
    $('installOpen').hidden = false;
    $('installBtn').hidden = !installEvt;
    $('installSteps').hidden = !!installEvt || !isIOS;
    if (!installEvt && !isIOS) setText('installSub', 'Open your browser menu and choose Install app or Add to Home Screen.');
    $('install').hidden = force ? false : store.get('ip.sports.install', null) === 'later';
  }
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; syncInstall(); });
  $('installBtn').addEventListener('click', async () => { if (!installEvt) return; installEvt.prompt(); try { await installEvt.userChoice; } catch { /* dismissed */ } installEvt = null; syncInstall(); });
  $('installLater').addEventListener('click', () => { store.set('ip.sports.install', 'later'); $('install').hidden = true; $('main').focus(); });
  $('installOpen').addEventListener('click', () => { syncInstall(true); $('install').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  syncInstall();

  // ---------- start ----------
  window.addEventListener('themechange', () => { document.querySelectorAll('.prop-why[open]').forEach((d) => { delete d.dataset.built; }); render(); });
  renderLog();
  render();
  load();
  resolveBets();
  setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
  setInterval(() => { if (!document.hidden) resolveBets(); }, 60000);
  setInterval(status, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - state.loadedAt > 60000) load(); });
})();
