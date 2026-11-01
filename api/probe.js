// TEMPORARY: NFL data shapes (preview branch only).
const H = { 'User-Agent': 'Mozilla/5.0 (compatible; InvestmentProject/1.0)', Accept: 'application/json' };
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const j = async (u) => (await fetch(u, { headers: H, signal: AbortSignal.timeout(8000) })).json();
module.exports = async (req, res) => {
  const out = {};
  const all = (await j(K + '/series?category=Sports')).series || [];
  const nfl = all.filter((s) => /^KXNFL/.test(s.ticker) && /YDS|YARD|REC|RUSH|PASS|TD|TOUCH|ATT|CMP|COMP|INT|SACK|RECEPT|CARRY|PLAYER/i.test(s.ticker + ' ' + s.title));
  out.candidates = nfl.map((s) => [s.ticker, s.title]);
  out.open = [];
  await Promise.all(nfl.map(async (s) => {
    try {
      const m = (await j(`${K}/markets?series_ticker=${s.ticker}&status=open&limit=500`)).markets || [];
      if (!m.length) return;
      const x = m[0];
      out.open.push({ series: s.ticker, title: s.title, count: m.length, sample: { ticker: x.ticker, title: x.title, strike: x.floor_strike, type: x.strike_type, bid: x.yes_bid_dollars, ask: x.yes_ask_dollars, vol: x.volume_fp, close: x.close_time, rules: (x.rules_primary || '').slice(0, 200), rules2: (x.rules_secondary || '').slice(0, 160) } });
    } catch (e) { /* skip */ }
  }));
  out.open.sort((a, b) => b.count - a.count);
  const gl = await j('https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/3139477/gamelog');
  out.glKeys = Object.keys(gl); out.labels = gl.labels; out.names = gl.names; out.categories = gl.categories && gl.categories.map((c) => [c.name, c.displayName, c.count]);
  out.seasonTypes = (gl.seasonTypes || []).map((s) => [s.displayName, (s.categories || []).length, (s.categories || [])[0] && (s.categories[0].events || [])[0]]);
  const evk = Object.keys(gl.events || {}); out.eventSample = evk.length ? (({ gameDate, atVs, opponent, week }) => ({ gameDate, atVs, opp: opponent && opponent.abbreviation, week }))(gl.events[evk[0]]) : null;
  out.season = (gl.filters || []).find((f) => f.name === 'season');
  const wr = await j('https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/4241389/gamelog');
  out.wrNames = wr.names; out.wrSample = (wr.seasonTypes || [])[0] && (wr.seasonTypes[0].categories || [])[0] && (wr.seasonTypes[0].categories[0].events || [])[0];
  const teams = await j('https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams');
  out.teams = teams.sports[0].leagues[0].teams.map((t) => [t.team.id, t.team.abbreviation, t.team.location, t.team.name]);
  const st = await j('https://site.api.espn.com/apis/v2/sports/football/nfl/standings');
  const e0 = st.children && st.children[0].standings.entries[0];
  out.standingsStats = e0 && e0.stats.map((s) => [s.name, s.value]).slice(0, 20);
  const sb = await j('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard');
  out.scoreboard = (sb.events || []).slice(0, 3).map((e) => [e.date, e.status.type.state, e.competitions[0].competitors.map((c) => c.team.abbreviation)]);
  res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(out, null, 1));
};
