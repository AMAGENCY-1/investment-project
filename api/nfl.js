// NFL props feed: open Kalshi player-prop markets for upcoming games with our
// projection, chance of hitting the line and the evidence behind it.
const { getJSON, send, allowGet } = require('./_lib');
const N = require('./_nfl');

const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const ESPN_V2 = 'https://site.api.espn.com/apis/v2/sports/football/nfl';
const ESPN_WEB = 'https://site.web.api.espn.com/apis/common/v3/sports/football/nfl';
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

async function markets(series) {
  const all = [];
  let cursor = '';
  for (let page = 0; page < 4; page++) {
    const j = await getJSON(`${KALSHI}/markets?series_ticker=${series}&status=open&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { timeout: 7000 });
    all.push(...(j.markets || []));
    cursor = j.cursor;
    if (!cursor || !(j.markets || []).length) break;
  }
  return all;
}

async function teams() {
  if (cache.teams && fresh(cache.teamsAt, 864e5)) return cache.teams;
  const j = await espn(`${ESPN}/teams`);
  const list = j.sports[0].leagues[0].teams.map((t) => ({ id: t.team.id, abbr: t.team.abbreviation, location: t.team.location, name: t.team.name }));
  cache.teams = list; cache.teamsAt = Date.now();
  return list;
}

async function roster(teamId) {
  const c = cache.rosters.get(teamId);
  if (c && fresh(c.at, 6 * 36e5)) return c.athletes;
  const j = await espn(`${ESPN}/teams/${teamId}/roster`);
  const flat = [];
  for (const a of j.athletes || []) {
    if (Array.isArray(a.items)) a.items.forEach((x) => flat.push(x)); else flat.push(a);
  }
  const athletes = flat.map((a) => ({ id: a.id, fullName: a.fullName, displayName: a.displayName, pos: a.position && a.position.abbreviation }));
  cache.rosters.set(teamId, { at: Date.now(), athletes });
  return athletes;
}

async function gamelogs(id) {
  const c = cache.logs.get(id);
  if (c && fresh(c.at, 30 * 6e4)) return c;
  const curRaw = await espn(`${ESPN_WEB}/athletes/${id}/gamelog`);
  const f = (curRaw.filters || []).find((x) => x.name === 'season');
  const season = f ? Number(f.value) : null;
  let prev = [];
  if (season) { try { prev = N.parseGamelog(await espn(`${ESPN_WEB}/athletes/${id}/gamelog?season=${season - 1}`)); } catch { prev = []; } }
  const out = { at: Date.now(), cur: N.parseGamelog(curRaw), prev };
  cache.logs.set(id, out);
  return out;
}

async function standings() {
  if (cache.standings && fresh(cache.standingsAt, 30 * 6e4)) return cache.standings;
  const j = await espn(`${ESPN_V2}/standings`);
  const rows = [];
  const walk = (node) => {
    for (const e of (node.standings && node.standings.entries) || []) {
      const s = Object.fromEntries((e.stats || []).map((x) => [x.name, x.value]));
      const gp = (s.wins || 0) + (s.losses || 0) + (s.ties || 0);
      if (gp > 0) rows.push({ abbr: e.team.abbreviation, name: e.team.shortDisplayName || e.team.name || e.team.displayName, ppg: s.pointsAgainst / gp, gp });
    }
    (node.children || []).forEach(walk);
  };
  walk(j);
  const league = N.mean(rows.map((r) => r.ppg));
  rows.sort((a, b) => b.ppg - a.ppg).forEach((r, i) => { r.rank = i + 1; });
  const map = {};
  for (const r of rows) map[r.abbr] = { ...r, factor: Math.min(1.08, Math.max(0.92, 1 + (r.ppg / league - 1) * Math.min(1, r.gp / 8))) };
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
    map[N.normName(name)] = { status: inj.status || 'Listed', detail: [d.type, d.returnDate ? `return ${d.returnDate}` : null].filter(Boolean).join(', ') };
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
    games[abbrs.join('-')] = { start: ev.date, state: ev.status && ev.status.type ? ev.status.type.state : 'pre', home: home && home.team ? home.team.abbreviation : null };
  }
  cache.boards.set(date, { at: Date.now(), games });
  return games;
}

async function build() {
  const errors = {};
  const series = Object.keys(N.SERIES);
  const lists = await pool(series, 4, (s) => markets(s).then((m) => ({ s, m })));
  let props = [];
  lists.forEach((l, i) => {
    if (!l) { errors[series[i]] = 'unavailable'; return; }
    for (const m of l.m) { const p = N.parseMarket(m, l.s); if (p) props.push(p); }
  });
  const etToday = new Date(Date.now() - 5 * 36e5).toISOString().slice(0, 10).replace(/-/g, '');
  // Keep upcoming games and lines that are actually trading (skip 1¢ / 99¢ dead lines).
  const live = (a) => Number.isFinite(a) && a >= 0.03 && a <= 0.97;
  props = props.filter((p) => p.gameDate >= String(Number(etToday) - 1) && (live(p.yesAsk) || live(p.noAsk)));

  const [teamList, stand, inj] = await Promise.all([
    teams().catch((e) => { errors.teams = String(e.message || e); return []; }),
    standings().catch((e) => { errors.standings = String(e.message || e); return {}; }),
    injuries().catch((e) => { errors.injuries = String(e.message || e); return {}; }),
  ]);
  const boards = {};
  await pool([...new Set(props.map((p) => p.gameDate))], 4, async (d) => { try { Object.assign(boards, await scoreboard(d)); } catch (e) { errors.scoreboard = String(e.message || e); } });

  // Resolve each game's two teams, then fetch rosters.
  for (const p of props) p.teamsResolved = p.teamNames.map((n) => N.matchTeam(n, teamList));
  props = props.filter((p) => p.teamsResolved[0] && p.teamsResolved[1]);
  const teamIds = [...new Set(props.flatMap((p) => p.teamsResolved.map((t) => t.id)))];
  const rosters = {};
  await pool(teamIds, 8, async (id) => { rosters[id] = await roster(id).catch(() => []); });

  const players = {};
  for (const p of props) {
    const [a, b] = p.teamsResolved;
    const key = `${p.game}:${N.normName(p.player)}`;
    p.pid = key;
    if (players[key]) continue;
    let team = a, opp = b;
    let ath = N.findAthlete(p.player, rosters[a.id] || []);
    if (!ath) { ath = N.findAthlete(p.player, rosters[b.id] || []); if (ath) { team = b; opp = a; } }
    players[key] = { name: p.player, team: team.abbr, opp: opp.abbr, game: p.game, athleteId: ath ? ath.id : null, pos: ath ? ath.pos : null, unsure: !ath };
  }
  const ids = [...new Set(Object.values(players).map((x) => x.athleteId).filter(Boolean))];
  const logs = {};
  await pool(ids, 12, async (id) => { logs[id] = await gamelogs(id); });

  const out = [], people = {}, shared = {};
  let rulesNote = '';
  for (const p of props) {
    const pl = players[p.pid];
    const lg = pl.athleteId ? logs[pl.athleteId] : null;
    const board = boards[[pl.team, pl.opp].sort().join('-')] || null;
    if (board && board.state === 'post') continue;
    const injury = inj[N.normName(p.player)] || null;
    const opp = stand[pl.opp] || null;
    if (!rulesNote && p.rulesDetail) rulesNote = p.rulesDetail.split('\n\n')[0];
    if (!people[p.pid]) {
      people[p.pid] = { name: p.player, team: pl.team, opp: pl.opp, pos: pl.pos, game: p.game, injury,
        start: board ? board.start : null, state: board ? board.state : 'pre', home: board ? board.home === pl.team : null,
        games: lg ? lg.cur.length + lg.prev.length : 0, gamesCur: lg ? lg.cur.length : 0,
        recent: lg ? lg.cur.concat(lg.prev).slice(0, 10).map((g) => ({ d: g.date, o: g.opp, passYds: g.passYds, passTD: g.passTD, comp: g.comp, att: g.att, int: g.int,
          rushYds: g.rushYds, car: g.car, recYds: g.recYds, rec: g.rec, rrYds: g.rrYds, tds: g.tds })) : [] };
    }
    const base = { ticker: p.ticker, pid: p.pid, stat: p.stat, statLabel: p.statLabel, statShort: p.statShort, group: p.group, line: p.line,
      yesBid: p.yesBid, yesAsk: p.yesAsk, noBid: p.noBid, noAsk: p.noAsk, volume: p.volume, close: p.close, chance: null };
    if (!lg) { out.push({ ...base, reason: 'No ESPN stats found for this player.' }); continue; }
    const proj = N.project(lg.cur, lg.prev, p.stat, N.SCORING.has(p.stat) && opp ? opp.factor : 1);
    if (!proj) { out.push({ ...base, reason: 'Fewer than 4 games of data.' }); continue; }
    base.chance = N.chanceAtLeast(p.line, proj, p.kind);
    base.mu = proj.mu;
    const ev = N.evidence({ ...p, chance: base.chance }, lg.cur, lg.prev, proj, opp, injury);
    const sk = `${p.pid}|${p.stat}`;
    if (!shared[sk]) shared[sk] = ev.filter((e) => e.shared).map(({ dir, text }) => ({ dir, text }));
    base.evidence = ev.filter((e) => !e.shared);
    out.push(base);
  }
  return { generatedAt: Date.now(), league: 'nfl', props: out, players: people, shared, rulesNote, playersMatched: ids.length, playersTotal: Object.keys(players).length, errors };
}

module.exports = async (req, res) => {
  if (!allowGet(req, res)) return;
  if (!cache.resp || !fresh(cache.respAt, 90 * 1000)) {
    try { const t0 = Date.now(); cache.resp = await build(); cache.resp.buildMs = Date.now() - t0; cache.respAt = Date.now(); }
    catch (e) { if (!cache.resp) { res.statusCode = 502; return send(res, { error: String(e.message || e) }, 0); } }
  }
  if (req.query && req.query.summary) {
    const r = cache.resp;
    return send(res, { playersMatched: r.playersMatched, playersTotal: r.playersTotal, props: r.props.length, withChance: r.props.filter((p) => p.chance !== null).length,
      byStat: r.props.reduce((t, p) => ({ ...t, [p.stat]: (t[p.stat] || 0) + 1 }), {}), unmatched: Object.values(r.players).filter((p) => !p.games).slice(0, 8).map((p) => [p.name, p.team]),
      sample: r.props.filter((p) => p.chance !== null).slice(0, 1), sampleShared: Object.entries(r.shared).slice(0, 1), bytes: JSON.stringify(r).length, errors: r.errors, buildMs: r.buildMs }, 0);
  }
  send(res, { serverTime: Date.now(), ...cache.resp }, 60);
};
