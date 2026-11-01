// NBA props feed: every open Kalshi player-prop market for upcoming games, with
// our projection, chance of hitting the line, and the evidence behind it.
// ESPN data is cached in the warm instance (rosters 6h, game logs 30m).
const { getJSON, send, allowGet } = require('./_lib');
const N = require('./_nba');

const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const ESPN_V2 = 'https://site.api.espn.com/apis/v2/sports/basketball/nba';
const ESPN_WEB = 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba';
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; InvestmentProject/1.0)' };
const espn = (url, timeout = 6000) => getJSON(url, { headers: UA, timeout });

const cache = { resp: null, respAt: 0, teams: null, teamsAt: 0, standings: null, standingsAt: 0, injuries: null, injuriesAt: 0, rosters: new Map(), logs: new Map(), boards: new Map() };
const fresh = (at, ttl) => Date.now() - at < ttl;

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; try { out[i] = await fn(items[i]); } catch { out[i] = null; } } };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

async function teams() {
  if (cache.teams && fresh(cache.teamsAt, 864e5)) return cache.teams;
  const j = await espn(`${ESPN}/teams`);
  const map = {};
  for (const t of j.sports[0].leagues[0].teams) map[t.team.abbreviation] = { id: t.team.id, name: t.team.shortDisplayName || t.team.name || t.team.displayName };
  cache.teams = map; cache.teamsAt = Date.now();
  return map;
}

async function roster(teamId) {
  const c = cache.rosters.get(teamId);
  if (c && fresh(c.at, 6 * 36e5)) return c.athletes;
  const j = await espn(`${ESPN}/teams/${teamId}/roster`);
  const athletes = (j.athletes || []).map((a) => ({ id: a.id, fullName: a.fullName, displayName: a.displayName }));
  cache.rosters.set(teamId, { at: Date.now(), athletes });
  return athletes;
}

async function gamelogs(athleteId) {
  const c = cache.logs.get(athleteId);
  if (c && fresh(c.at, 30 * 6e4)) return c;
  const curRaw = await espn(`${ESPN_WEB}/athletes/${athleteId}/gamelog`);
  const seasonFilter = (curRaw.filters || []).find((f) => f.name === 'season');
  const season = seasonFilter ? Number(seasonFilter.value) : null;
  let prev = [];
  if (season) { try { prev = N.parseGamelog(await espn(`${ESPN_WEB}/athletes/${athleteId}/gamelog?season=${season - 1}`)); } catch { prev = []; } }
  const out = { at: Date.now(), cur: N.parseGamelog(curRaw), prev, season };
  cache.logs.set(athleteId, out);
  return out;
}

async function standings() {
  if (cache.standings && fresh(cache.standingsAt, 30 * 6e4)) return cache.standings;
  const j = await espn(`${ESPN_V2}/standings`);
  const rows = [];
  for (const conf of j.children || []) for (const e of (conf.standings && conf.standings.entries) || []) {
    const s = Object.fromEntries((e.stats || []).map((x) => [x.name, x.value]));
    rows.push({ abbr: e.team.abbreviation, name: e.team.shortDisplayName || e.team.name || e.team.displayName, pa: s.avgPointsAgainst, gp: (s.wins || 0) + (s.losses || 0) });
  }
  const valid = rows.filter((r) => Number.isFinite(r.pa));
  const league = N.mean(valid.map((r) => r.pa));
  valid.sort((a, b) => b.pa - a.pa).forEach((r, i) => { r.rank = i + 1; });
  const map = {};
  for (const r of valid) {
    const ratio = r.pa / league;
    map[r.abbr] = { ...r, factor: Math.min(1.06, Math.max(0.94, 1 + (ratio - 1) * Math.min(1, r.gp / 15))) };
  }
  cache.standings = map; cache.standingsAt = Date.now();
  return map;
}

async function injuries() {
  if (cache.injuries && fresh(cache.injuriesAt, 10 * 6e4)) return cache.injuries;
  const j = await espn(`${ESPN}/injuries`);
  const map = {};
  for (const team of j.injuries || []) for (const inj of team.injuries || []) {
    const name = inj.athlete && inj.athlete.displayName;
    if (!name) continue;
    const d = inj.details || {};
    map[N.normName(name)] = { status: inj.status || (inj.type && inj.type.description) || 'Listed', detail: [d.type, d.returnDate ? `return ${d.returnDate}` : null].filter(Boolean).join(', ') };
  }
  cache.injuries = map; cache.injuriesAt = Date.now();
  return map;
}

async function scoreboard(date) {
  const c = cache.boards.get(date);
  if (c && fresh(c.at, 3 * 6e4)) return c.games;
  const j = await espn(`${ESPN}/scoreboard?dates=${date}`);
  const games = {};
  for (const ev of j.events || []) {
    const comp = (ev.competitions || [])[0] || {};
    const abbrs = (comp.competitors || []).map((x) => x.team && x.team.abbreviation).filter(Boolean).sort();
    const home = (comp.competitors || []).find((x) => x.homeAway === 'home');
    games[abbrs.join('-')] = { start: ev.date, state: ev.status && ev.status.type ? ev.status.type.state : 'pre', detail: ev.status && ev.status.type ? ev.status.type.shortDetail : '', home: home && home.team ? home.team.abbreviation : null };
  }
  cache.boards.set(date, { at: Date.now(), games });
  return games;
}

async function build() {
  const errors = {};
  const series = Object.keys(N.SERIES);
  const lists = await pool(series, 6, (s) => getJSON(`${KALSHI}/markets?series_ticker=${s}&status=open&limit=1000`, { timeout: 6000 }).then((j) => ({ s, markets: j.markets || [] })));
  let props = [];
  lists.forEach((l, i) => {
    if (!l) { errors[series[i]] = 'unavailable'; return; }
    for (const m of l.markets) { const p = N.parseMarket(m, l.s); if (p) props.push(p); }
  });
  // Only games from yesterday (ET) onward.
  const etToday = new Date(Date.now() - 5 * 36e5).toISOString().slice(0, 10).replace(/-/g, '');
  props = props.filter((p) => p.gameDate >= String(Number(etToday) - 1));

  const [teamMap, stand, inj] = await Promise.all([
    teams().catch((e) => { errors.teams = String(e.message || e); return {}; }),
    standings().catch((e) => { errors.standings = String(e.message || e); return {}; }),
    injuries().catch((e) => { errors.injuries = String(e.message || e); return {}; }),
  ]);
  const dates = [...new Set(props.map((p) => p.gameDate))];
  const boards = {};
  await pool(dates, 4, async (d) => { try { Object.assign(boards, await scoreboard(d)); } catch (e) { errors.scoreboard = String(e.message || e); } });

  const teamCodes = [...new Set(props.flatMap((p) => p.teams))];
  const rosters = {};
  await pool(teamCodes, 8, async (code) => {
    const t = teamMap[N.espnAbbr(code)];
    if (t) rosters[code] = await roster(t.id).catch(() => []);
  });

  // Match each prop's player to an ESPN athlete (own team first, then opponent).
  const players = {};
  for (const p of props) {
    const key = `${p.team}:${N.normName(p.player)}`;
    p.pid = key;
    if (players[key]) continue;
    const a = N.findAthlete(p.player, rosters[p.team] || []) || N.findAthlete(p.player, rosters[p.opp] || []);
    players[key] = { name: p.player, team: p.team, opp: p.opp, game: p.game, athleteId: a ? a.id : null };
  }
  const ids = [...new Set(Object.values(players).map((x) => x.athleteId).filter(Boolean))];
  const logs = {};
  await pool(ids, 12, async (id) => { logs[id] = await gamelogs(id); });

  const out = [];
  for (const p of props) {
    const pl = players[p.pid];
    const lg = pl.athleteId ? logs[pl.athleteId] : null;
    const pair = [N.espnAbbr(p.teams[0]), N.espnAbbr(p.teams[1])].sort().join('-');
    const gameInfo = boards[pair] || null;
    const injury = inj[N.normName(p.player)] || null;
    const oppInfo = stand[N.espnAbbr(p.opp)] || null;
    const base = { ...p, start: gameInfo ? gameInfo.start : null, state: gameInfo ? gameInfo.state : 'pre', stateDetail: gameInfo ? gameInfo.detail : '',
      home: gameInfo ? gameInfo.home === N.espnAbbr(p.team) : null, injury };
    delete base.teams;
    if (!lg) { out.push({ ...base, chance: null, reason: 'No ESPN stats found for this player.' }); continue; }
    const proj = N.project(lg.cur, lg.prev, p.stat, N.SCORING.has(p.stat) && oppInfo ? oppInfo.factor : 1);
    if (!proj) { out.push({ ...base, chance: null, reason: 'Fewer than 5 games of data.' }); continue; }
    base.chance = N.chanceAtLeast(p.line, proj, p.kind);
    base.mu = proj.mu; base.minutes = proj.minutes; base.games = proj.n; base.gamesCur = lg.cur.length;
    base.evidence = N.evidence(base, lg.cur, lg.prev, proj, oppInfo, injury);
    base.recent = lg.cur.concat(lg.prev).slice(0, 10).map((g) => ({ d: g.date, o: g.opp, v: N.statOf(g, p.stat), m: g.min }));
    out.push(base);
  }
  return { generatedAt: Date.now(), props: out, playersMatched: ids.length, playersTotal: Object.keys(players).length, errors };
}

module.exports = async (req, res) => {
  if (!allowGet(req, res)) return;
  if (!cache.resp || !fresh(cache.respAt, 90 * 1000)) {
    try { const t0 = Date.now(); cache.resp = await build(); cache.resp.buildMs = Date.now() - t0; cache.respAt = Date.now(); }
    catch (e) { if (!cache.resp) { res.statusCode = 502; return send(res, { error: String(e.message || e) }, 0); } }
  }
  if (req.query && req.query.summary) {
    const r = cache.resp, ok = r.props.filter((p) => p.chance !== null);
    return send(res, { playersMatched: r.playersMatched, playersTotal: r.playersTotal, props: r.props.length, withChance: ok.length,
      bySeries: r.props.reduce((t, p) => ({ ...t, [p.series]: (t[p.series] || 0) + 1 }), {}), unmatched: r.props.filter((p) => p.chance === null).slice(0, 8).map((p) => [p.player, p.team, p.reason]),
      sample: ok.slice(0, 2), errors: r.errors, buildMs: r.buildMs }, 0);
  }
  send(res, { serverTime: Date.now(), ...cache.resp }, 60);
};
