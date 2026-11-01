// NBA prop engine: Kalshi player-prop markets + ESPN game logs -> projection,
// chance of hitting the line, and plain-English evidence. Pure helpers here;
// the HTTP handler lives in api/nba.js.

// ---------- math ----------
function erf(x) {
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
}
const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
function lgamma(z) {
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
const mean = (a) => (a.length ? a.reduce((t, x) => t + x, 0) / a.length : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// P(X >= k) for a count with mean mu and variance v (negative binomial, or Poisson when v <= mu).
function countAtLeast(k, mu, v) {
  if (k <= 0) return 1;
  if (!(mu > 0)) return 0;
  let cdf = 0;
  if (v <= mu * 1.0001) {
    for (let x = 0; x < k; x++) cdf += Math.exp(-mu + x * Math.log(mu) - lgamma(x + 1));
  } else {
    const r = (mu * mu) / (v - mu), p = r / (r + mu);
    for (let x = 0; x < k; x++) cdf += Math.exp(lgamma(x + r) - lgamma(r) - lgamma(x + 1) + r * Math.log(p) + x * Math.log(1 - p));
  }
  return clamp(1 - cdf, 0, 1);
}

// ---------- markets ----------
const SERIES = {
  KXNBAPTS: { key: 'pts', label: 'points', short: 'PTS', kind: 'normal' },
  KXNBAREB: { key: 'reb', label: 'rebounds', short: 'REB', kind: 'count' },
  KXNBAAST: { key: 'ast', label: 'assists', short: 'AST', kind: 'count' },
  KXNBA3PT: { key: 'fg3', label: 'threes', short: '3PM', kind: 'count' },
  KXNBAPRA: { key: 'pra', label: 'points + rebounds + assists', short: 'PRA', kind: 'normal' },
  KXNBAPR: { key: 'pr', label: 'points + rebounds', short: 'P+R', kind: 'normal' },
  KXNBAPA: { key: 'pa', label: 'points + assists', short: 'P+A', kind: 'normal' },
  KXNBARA: { key: 'ra', label: 'rebounds + assists', short: 'R+A', kind: 'count' },
  KXNBASTL: { key: 'stl', label: 'steals', short: 'STL', kind: 'count' },
  KXNBABLK: { key: 'blk', label: 'blocks', short: 'BLK', kind: 'count' },
  KXNBASTOCK: { key: 'stocks', label: 'steals + blocks', short: 'STK', kind: 'count' },
};
const SCORING = new Set(['pts', 'pra', 'pr', 'pa']);
// Kalshi uses NBA tricodes; ESPN abbreviates a few teams differently.
const TO_ESPN = { GSW: 'GS', NOP: 'NO', NYK: 'NY', SAS: 'SA', UTA: 'UTAH', WAS: 'WSH' };
const espnAbbr = (code) => TO_ESPN[code] || code;
const MONTHS = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const dollars = (m, k) => (m[k + '_dollars'] !== undefined ? num(m[k + '_dollars']) : m[k] !== undefined && m[k] !== null ? Number(m[k]) / 100 : null);

// "KXNBAPTS-26NOV01LACGSW-LACRHACHIMURA28-25" -> game + player team
function parseMarket(m, seriesTicker) {
  const meta = SERIES[seriesTicker];
  const strike = num(m.floor_strike);
  if (!meta || m.strike_type !== 'greater' || !Number.isFinite(strike)) return null;
  const parts = String(m.ticker || '').split('-');
  if (parts.length < 4) return null;
  const game = parts[1];
  const gm = /^(\d{2})([A-Z]{3})(\d{2})([A-Z]{3})([A-Z]{3})$/.exec(game);
  if (!gm) return null;
  const team = parts[2].slice(0, 3);
  const teams = [gm[4], gm[5]];
  if (!teams.includes(team)) return null;
  const name = String(m.title || m.yes_sub_title || '').split(':')[0].trim();
  if (!name) return null;
  return {
    ticker: m.ticker, series: seriesTicker, stat: meta.key, statLabel: meta.label, statShort: meta.short, kind: meta.kind,
    player: name, team, opp: teams[0] === team ? teams[1] : teams[0], game, gameDate: `20${gm[1]}${MONTHS[gm[2]] || '01'}${gm[3]}`, teams,
    line: Math.round(strike + 0.5),
    yesBid: dollars(m, 'yes_bid'), yesAsk: dollars(m, 'yes_ask'), noBid: dollars(m, 'no_bid'), noAsk: dollars(m, 'no_ask'),
    volume: num(m.volume_fp !== undefined ? m.volume_fp : m.volume), openInterest: num(m.open_interest_fp !== undefined ? m.open_interest_fp : m.open_interest),
    close: m.close_time, rules: m.rules_primary || '', rulesDetail: m.rules_secondary || '',
  };
}

// ---------- ESPN ----------
const normName = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[.'’`-]/g, ' ').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();

function findAthlete(name, athletes) {
  const n = normName(name);
  let hit = athletes.find((a) => normName(a.fullName) === n || normName(a.displayName) === n);
  if (hit) return hit;
  const parts = n.split(' ');
  const last = parts[parts.length - 1], first = parts[0];
  const cands = athletes.filter((a) => {
    const an = normName(a.fullName).split(' ');
    return an[an.length - 1] === last && an[0][0] === first[0];
  });
  return cands.length === 1 ? cands[0] : null;
}

function parseGamelog(gl) {
  const names = (gl && gl.names) || [];
  const at = (n) => names.indexOf(n);
  const iMin = at('minutes'), iPts = at('points'), iReb = at('totalRebounds'), iAst = at('assists'), iStl = at('steals'), iBlk = at('blocks');
  const i3 = at('threePointFieldGoalsMade-threePointFieldGoalsAttempted');
  const seen = new Set(), games = [];
  for (const st of (gl && gl.seasonTypes) || []) {
    if (!/regular season/i.test(st.displayName || '')) continue;
    for (const cat of st.categories || []) {
      for (const e of cat.events || []) {
        const id = e.eventId || e.id;
        if (!id || seen.has(id)) continue;
        const s = e.stats || [];
        const min = parseFloat(s[iMin]);
        if (!(min > 0)) continue;
        seen.add(id);
        const meta = (gl.events || {})[id] || {};
        games.push({
          date: meta.gameDate || null, opp: meta.opponent ? meta.opponent.abbreviation : null, home: meta.atVs === 'vs', min,
          pts: +s[iPts] || 0, reb: +s[iReb] || 0, ast: +s[iAst] || 0, stl: +s[iStl] || 0, blk: +s[iBlk] || 0,
          fg3: parseInt(String(s[i3] || '0').split('-')[0], 10) || 0,
        });
      }
    }
  }
  return games.sort((a, b) => Date.parse(b.date || 0) - Date.parse(a.date || 0));
}

function statOf(g, key) {
  switch (key) {
    case 'pra': return g.pts + g.reb + g.ast;
    case 'pr': return g.pts + g.reb;
    case 'pa': return g.pts + g.ast;
    case 'ra': return g.reb + g.ast;
    case 'stocks': return g.stl + g.blk;
    default: return g[key];
  }
}

// ---------- projection ----------
function project(cur, prev, key, oppFactor) {
  const all = cur.concat(prev);
  if (all.length < 5) return null;
  const last5 = all.slice(0, 5);
  const wavg = (parts) => { const w = parts.reduce((t, [, x]) => t + x, 0); return parts.reduce((t, [v, x]) => t + v * x, 0) / w; };
  const mParts = [[mean(last5.map((g) => g.min)), 0.5]];
  if (cur.length) mParts.push([mean(cur.map((g) => g.min)), 0.3]);
  if (prev.length) mParts.push([mean(prev.map((g) => g.min)), 0.2]);
  const minutes = wavg(mParts);
  const rate = (gs) => gs.reduce((t, g) => t + statOf(g, key), 0) / gs.reduce((t, g) => t + g.min, 0);
  let r;
  if (cur.length && prev.length) { const w = cur.length / (cur.length + 10); r = w * rate(cur) + (1 - w) * rate(prev); }
  else r = rate(cur.length ? cur : prev);
  r = 0.8 * r + 0.2 * rate(last5);
  const mu = r * minutes * (oppFactor || 1);
  const sample = all.slice(0, 30).map((g) => statOf(g, key));
  const sm = mean(sample);
  const sv = sample.reduce((t, x) => t + (x - sm) ** 2, 0) / Math.max(1, sample.length - 1);
  return { mu, minutes, variance: sm > 0 ? sv * (mu / sm) : sv, n: all.length };
}

function chanceAtLeast(k, proj, kind) {
  const { mu } = proj;
  let p;
  if (kind === 'normal') {
    const sd = Math.sqrt(Math.max(proj.variance, (0.18 * mu) ** 2) + (0.07 * mu) ** 2);
    p = 1 - Phi((k - 0.5 - mu) / sd);
  } else {
    p = countAtLeast(k, mu, Math.max(proj.variance * 1.1, mu * 1.05));
  }
  return clamp(p, 0.02, 0.98);
}

const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 >> 3 ^ 1 && n % 10) || 0] || 'th');
const fmt1 = (x) => (Number.isFinite(x) ? (Math.round(x * 10) / 10).toFixed(1) : '–');

function evidence(prop, cur, prev, proj, opp, injury) {
  const k = prop.line, key = prop.stat, label = prop.statLabel, who = prop.player;
  const vals = (gs) => gs.map((g) => statOf(g, key));
  const all = cur.concat(prev);
  const ev = [];
  const side = (x) => (x >= k - 0.5 + 0.05 * k ? 'over' : x <= k - 0.5 - 0.05 * k ? 'under' : 'flat');
  const last5 = vals(all.slice(0, 5));
  const a5 = mean(last5), aCur = cur.length ? mean(vals(cur)) : null;
  ev.push({ dir: side(aCur !== null && cur.length >= 3 ? aCur : a5),
    text: aCur !== null ? `${who} averages ${fmt1(aCur)} ${label} this season (${cur.length} game${cur.length === 1 ? '' : 's'}) and ${fmt1(a5)} over the last 5.`
      : `${who} averaged ${fmt1(a5)} ${label} over the last 5 games played.` });
  const last10 = vals(all.slice(0, 10));
  const hits = last10.filter((v) => v >= k).length;
  ev.push({ dir: hits / last10.length > 0.55 ? 'over' : hits / last10.length < 0.45 ? 'under' : 'flat',
    text: `Reached ${k}+ in ${hits} of the last ${last10.length} games.` });
  const m5 = mean(all.slice(0, 5).map((g) => g.min)), mBase = mean((cur.length >= 3 ? cur : all.slice(0, 20)).map((g) => g.min));
  ev.push({ dir: m5 > mBase * 1.08 ? 'over' : m5 < mBase * 0.92 ? 'under' : 'flat',
    text: `Playing ${fmt1(m5)} minutes a game lately vs ${fmt1(mBase)} ${cur.length >= 3 ? 'this season' : 'on average'}${m5 > mBase * 1.08 ? ', a bigger role' : m5 < mBase * 0.92 ? ', a smaller role' : ''}.` });
  if (opp && SCORING.has(key)) {
    ev.push({ dir: opp.factor > 1.015 ? 'over' : opp.factor < 0.985 ? 'under' : 'flat',
      text: `${opp.name} allow ${fmt1(opp.pa)} points a game, ${ordinal(opp.rank)} most in the league${opp.factor > 1.015 ? ', which helps scoring' : opp.factor < 0.985 ? ', a tougher defense' : ''}.` });
  }
  if (prev.length >= 10) {
    const aPrev = mean(vals(prev));
    ev.push({ dir: side(aPrev), text: `Last season: ${fmt1(aPrev)} ${label} a game over ${prev.length} games.` });
  }
  if (injury) ev.push({ dir: 'warn', text: `Injury report: ${injury.status}${injury.detail ? ` (${injury.detail})` : ''}. ${/out/i.test(injury.status) ? 'Expected to miss the game.' : 'Could sit or play limited minutes.'}` });
  ev.push({ dir: 'model', text: `Our projection: ${fmt1(proj.mu)} ${label} in about ${fmt1(proj.minutes)} minutes, so ${k}+ happens about ${Math.round(prop.chance * 100)}% of the time.` });
  return ev;
}

module.exports = { SERIES, SCORING, parseMarket, espnAbbr, findAthlete, parseGamelog, statOf, project, chanceAtLeast, evidence, countAtLeast, Phi, mean, normName };
