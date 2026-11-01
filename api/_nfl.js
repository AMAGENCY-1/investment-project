// NFL prop engine: Kalshi player-prop markets + ESPN game logs -> per-game
// projection, chance of hitting the line, and plain-English evidence.
const { countAtLeast, Phi, mean, normName, findAthlete } = require('./_nba');

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const dollars = (m, k) => (m[k + '_dollars'] !== undefined ? num(m[k + '_dollars']) : m[k] !== undefined && m[k] !== null ? Number(m[k]) / 100 : null);

// Per-game Kalshi series we model (protected / ladder / season markets are left out).
const SERIES = {
  KXNFLPASSYDS: { key: 'passYds', label: 'passing yards', short: 'PASS YDS', kind: 'yards', usage: 'att', group: 'pass' },
  KXNFLPASSTDS: { key: 'passTD', label: 'passing TDs', short: 'PASS TD', kind: 'count', usage: 'att', group: 'pass' },
  KXNFLPASSCOMP: { key: 'comp', label: 'completions', short: 'CMP', kind: 'count', usage: 'att', group: 'pass' },
  KXNFLPASSATT: { key: 'att', label: 'pass attempts', short: 'ATT', kind: 'count', usage: 'att', group: 'pass' },
  KXNFLPASSINT: { key: 'int', label: 'interceptions thrown', short: 'INT', kind: 'count', usage: 'att', group: 'pass' },
  KXNFLRSHYDS: { key: 'rushYds', label: 'rushing yards', short: 'RUSH YDS', kind: 'yards', usage: 'car', group: 'rush' },
  KXNFLRSHATT: { key: 'car', label: 'rushing attempts', short: 'CAR', kind: 'count', usage: 'car', group: 'rush' },
  KXNFLRECYDS: { key: 'recYds', label: 'receiving yards', short: 'REC YDS', kind: 'yards', usage: 'tgt', group: 'rec' },
  KXNFLREC: { key: 'rec', label: 'receptions', short: 'REC', kind: 'count', usage: 'tgt', group: 'rec' },
  KXNFLRRYDS: { key: 'rrYds', label: 'rushing + receiving yards', short: 'R+R YDS', kind: 'yards', usage: 'touches', group: 'combo' },
  KXNFLANYTD: { key: 'tds', label: 'touchdowns', short: 'TD', kind: 'count', usage: 'touches', group: 'td' },
  KXNFL2TD: { key: 'tds', label: 'touchdowns', short: 'TD', kind: 'count', usage: 'touches', group: 'td' },
};
const SCORING = new Set(['passYds', 'passTD', 'rushYds', 'recYds', 'rrYds', 'tds']);
const USAGE_LABEL = { att: 'pass attempts', car: 'carries', tgt: 'targets', touches: 'touches (carries + targets)' };

// "in the New England vs Miami Pro Football game" -> ["New England", "Miami"]
function teamsFromRules(rules) {
  const m = /in the (.+?) vs\.? (.+?) (?:Pro(?:fessional)? Football|NFL) game/i.exec(rules || '');
  return m ? [m[1].trim(), m[2].trim()] : null;
}

function parseMarket(m, seriesTicker) {
  const meta = SERIES[seriesTicker];
  if (!meta) return null;
  let strike = num(m.floor_strike);
  if (!Number.isFinite(strike) && /ANYTD$/.test(seriesTicker)) strike = 0.5;
  if (!Number.isFinite(strike) && /2TD$/.test(seriesTicker)) strike = 1.5;
  if (m.strike_type && m.strike_type !== 'greater' && !/TD$/.test(seriesTicker)) return null;
  if (!Number.isFinite(strike)) return null;
  const parts = String(m.ticker || '').split('-');
  if (parts.length < 3) return null;
  const gm = /^(\d{2})([A-Z]{3})(\d{2})/.exec(parts[1] || '');
  const names = teamsFromRules(m.rules_primary);
  if (!gm || !names) return null;
  const player = String(m.title || m.yes_sub_title || '').split(':')[0].trim();
  if (!player) return null;
  const MONTHS = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
  return {
    ticker: m.ticker, series: seriesTicker, stat: meta.key, statLabel: meta.label, statShort: meta.short, kind: meta.kind, usage: meta.usage, group: meta.group,
    player, teamNames: names, game: parts[1], gameDate: `20${gm[1]}${MONTHS[gm[2]] || '01'}${gm[3]}`,
    line: Math.round(strike + 0.5),
    yesBid: dollars(m, 'yes_bid'), yesAsk: dollars(m, 'yes_ask'), noBid: dollars(m, 'no_bid'), noAsk: dollars(m, 'no_ask'),
    volume: num(m.volume_fp !== undefined ? m.volume_fp : m.volume), close: m.close_time, rulesDetail: m.rules_secondary || '',
  };
}

// Match Kalshi's team wording ("Los Angeles C", "New York J", "Miami") to an ESPN team.
function matchTeam(name, teams) {
  const n = String(name || '').toLowerCase().trim();
  let hit = teams.find((t) => `${t.location} ${t.name}`.toLowerCase() === n || t.name.toLowerCase() === n);
  if (hit) return hit;
  const same = teams.filter((t) => t.location.toLowerCase() === n);
  if (same.length === 1) return same[0];
  const m = /^(.*)\s([a-z0-9])$/i.exec(n);
  if (m) {
    const cand = teams.filter((t) => t.location.toLowerCase() === m[1] && t.name.toLowerCase().startsWith(m[2].toLowerCase()));
    if (cand.length === 1) return cand[0];
  }
  return null;
}

function parseGamelog(gl) {
  const names = (gl && gl.names) || [];
  const idx = {};
  names.forEach((n, i) => { if (!(n in idx)) idx[n] = i; });
  const val = (s, n) => { const i = idx[n]; if (i === undefined) return 0; const v = parseFloat(s[i]); return Number.isFinite(v) ? v : 0; };
  const seen = new Set(), games = [];
  for (const st of (gl && gl.seasonTypes) || []) {
    if (!/regular season/i.test(st.displayName || '')) continue;
    for (const cat of st.categories || []) {
      for (const e of cat.events || []) {
        const id = e.eventId || e.id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const s = e.stats || [], meta = (gl.events || {})[id] || {};
        const g = {
          date: meta.gameDate || null, opp: meta.opponent ? meta.opponent.abbreviation : null, home: meta.atVs === 'vs',
          comp: val(s, 'completions'), att: val(s, 'passingAttempts'), passYds: val(s, 'passingYards'), passTD: val(s, 'passingTouchdowns'), int: val(s, 'interceptions'),
          car: val(s, 'rushingAttempts'), rushYds: val(s, 'rushingYards'), rushTD: val(s, 'rushingTouchdowns'),
          rec: val(s, 'receptions'), tgt: val(s, 'receivingTargets'), recYds: val(s, 'receivingYards'), recTD: val(s, 'receivingTouchdowns'),
        };
        g.rrYds = g.rushYds + g.recYds;
        g.tds = g.rushTD + g.recTD;
        g.touches = g.car + g.tgt;
        games.push(g);
      }
    }
  }
  return games.sort((a, b) => Date.parse(b.date || 0) - Date.parse(a.date || 0));
}

function project(cur, prev, key, factor) {
  const all = cur.concat(prev);
  if (all.length < 4) return null;
  const avg = (gs) => mean(gs.map((g) => g[key]));
  let base;
  if (cur.length && prev.length) { const w = cur.length / (cur.length + 4); base = w * avg(cur) + (1 - w) * avg(prev); }
  else base = avg(cur.length ? cur : prev);
  const mu = (0.75 * base + 0.25 * avg(all.slice(0, 3))) * (factor || 1);
  const sample = all.slice(0, 20).map((g) => g[key]);
  const sm = mean(sample);
  const sv = sample.reduce((t, x) => t + (x - sm) ** 2, 0) / Math.max(1, sample.length - 1);
  return { mu, variance: sm > 0 ? sv * (mu / sm) : sv, n: all.length };
}

function chanceAtLeast(k, proj, kind) {
  const { mu } = proj;
  let p;
  if (kind === 'yards') {
    const sd = Math.sqrt(Math.max(proj.variance, (0.35 * mu) ** 2) + (0.1 * mu) ** 2) || 1;
    p = 1 - Phi((k - 0.5 - mu) / sd);
  } else {
    p = countAtLeast(k, Math.max(mu, 0.01), Math.max(proj.variance * 1.1, mu * 1.05));
  }
  return clamp(p, 0.02, 0.98);
}

const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 >> 3 ^ 1 && n % 10) || 0] || 'th');
const fmt1 = (x) => (Number.isFinite(x) ? (Math.round(x * 10) / 10).toFixed(1) : '–');

function evidence(prop, cur, prev, proj, opp, injury) {
  const k = prop.line, key = prop.stat, label = prop.statLabel, who = prop.player;
  const all = cur.concat(prev);
  const vals = (gs) => gs.map((g) => g[key]);
  const side = (x) => (x >= k - 0.5 + 0.05 * k ? 'over' : x <= k - 0.5 - 0.05 * k ? 'under' : 'flat');
  const ev = [];
  const a3 = mean(vals(all.slice(0, 3))), aCur = cur.length ? mean(vals(cur)) : null;
  ev.push({ shared: true, dir: side(aCur !== null && cur.length >= 3 ? aCur : a3),
    text: aCur !== null ? `${who} averages ${fmt1(aCur)} ${label} this season (${cur.length} game${cur.length === 1 ? '' : 's'}) and ${fmt1(a3)} over the last 3.`
      : `${who} averaged ${fmt1(a3)} ${label} over the last 3 games played.` });
  const last10 = vals(all.slice(0, 10)), hits = last10.filter((v) => v >= k).length;
  ev.push({ dir: hits / last10.length > 0.55 ? 'over' : hits / last10.length < 0.45 ? 'under' : 'flat', text: `Reached ${k}+ in ${hits} of the last ${last10.length} games.` });
  const u = prop.usage;
  const u3 = mean(all.slice(0, 3).map((g) => g[u])), uBase = mean((cur.length >= 3 ? cur : all.slice(0, 10)).map((g) => g[u]));
  if (uBase > 0) ev.push({ shared: true, dir: u3 > uBase * 1.12 ? 'over' : u3 < uBase * 0.88 ? 'under' : 'flat',
    text: `Averaging ${fmt1(u3)} ${USAGE_LABEL[u]} over the last 3 vs ${fmt1(uBase)} ${cur.length >= 3 ? 'this season' : 'on average'}${u3 > uBase * 1.12 ? ', a bigger role' : u3 < uBase * 0.88 ? ', a smaller role' : ''}.` });
  if (opp && SCORING.has(key)) ev.push({ shared: true, dir: opp.factor > 1.02 ? 'over' : opp.factor < 0.98 ? 'under' : 'flat',
    text: `${opp.name} allow ${fmt1(opp.ppg)} points a game, ${ordinal(opp.rank)} most in the league${opp.factor > 1.02 ? ', a defense that gives up production' : opp.factor < 0.98 ? ', a tougher defense' : ''}.` });
  if (prev.length >= 6) ev.push({ shared: true, dir: side(mean(vals(prev))), text: `Last season: ${fmt1(mean(vals(prev)))} ${label} a game over ${prev.length} games.` });
  if (injury) ev.push({ shared: true, dir: 'warn', text: `Injury report: ${injury.status}${injury.detail ? ` (${injury.detail})` : ''}.${/out|reserve/i.test(injury.status) ? ' Expected to miss the game.' : ' Could be limited or sit.'}` });
  ev.push({ dir: 'model', text: `Our projection: ${fmt1(proj.mu)} ${label}, so ${k}+ happens about ${Math.round(prop.chance * 100)}% of the time.` });
  return ev;
}

module.exports = { SERIES, SCORING, parseMarket, matchTeam, parseGamelog, project, chanceAtLeast, evidence, normName, findAthlete, mean };
