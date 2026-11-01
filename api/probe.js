// TEMPORARY: shape of ESPN NBA data (preview branch only).
const H = { 'User-Agent': 'Mozilla/5.0 (investment-project probe)', Accept: 'application/json' };
const j = async (u) => (await fetch(u, { headers: H, signal: AbortSignal.timeout(8000) })).json();
const shape = (o, depth = 0) => {
  if (Array.isArray(o)) return o.length ? [shape(o[0], depth + 1), `len=${o.length}`] : [];
  if (o && typeof o === 'object') { if (depth > 4) return '{…}'; const r = {}; for (const k of Object.keys(o).slice(0, 25)) r[k] = shape(o[k], depth + 1); return r; }
  return typeof o === 'string' ? o.slice(0, 40) : o;
};
module.exports = async (req, res) => {
  const out = {};
  const gl = await j('https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/3112335/gamelog');
  out.gamelogKeys = Object.keys(gl);
  out.labels = gl.labels; out.names = gl.names;
  out.seasonTypes = shape(gl.seasonTypes);
  const evKeys = Object.keys(gl.events || {});
  out.eventsCount = evKeys.length;
  out.eventSample = gl.events && gl.events[evKeys[0]];
  const gl2 = await j('https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/3112335/gamelog?season=2026');
  out.prevSeasonEvents = Object.keys(gl2.events || {}).length;
  const teams = await j('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams');
  const t = teams.sports[0].leagues[0].teams.map((x) => [x.team.id, x.team.abbreviation, x.team.displayName]);
  out.teams = t;
  const roster = await j('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/12/roster');
  out.rosterShape = shape(roster.athletes);
  const st = await j('https://site.api.espn.com/apis/v2/sports/basketball/nba/standings');
  const e0 = st.children && st.children[0].standings.entries[0];
  out.standingsTeam = e0 && e0.team && [e0.team.abbreviation, e0.team.id];
  out.standingsStats = e0 && e0.stats.map((s) => [s.name, s.value]).slice(0, 40);
  const inj = await j('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries');
  out.injShape = shape(inj.injuries && inj.injuries[0]);
  res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(out, null, 1));
};
