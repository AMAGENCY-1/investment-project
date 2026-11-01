// TEMPORARY: checks which sports data sources respond from Vercel. Not deployed to production.
const H = { 'User-Agent': 'Mozilla/5.0 (investment-project probe)', Accept: 'application/json' };
async function grab(url, max = 900, headers = {}) {
  const t = Date.now();
  try {
    const r = await fetch(url, { headers: { ...H, ...headers }, signal: AbortSignal.timeout(7000) });
    const txt = await r.text();
    return { url: url.slice(0, 120), status: r.status, ms: Date.now() - t, body: txt.slice(0, max) };
  } catch (e) { return { url: url.slice(0, 120), error: String(e), ms: Date.now() - t }; }
}
module.exports = async (req, res) => {
  const K = 'https://api.elections.kalshi.com/trade-api/v2';
  const out = {};
  try {
    const r = await fetch(K + '/series?category=Sports', { headers: H, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const all = j.series || [];
    out.sportsSeriesCount = all.length;
    out.nbaSeries = all.filter((s) => /NBA|BASKET/i.test(s.ticker + ' ' + s.title)).map((s) => [s.ticker, s.title, s.frequency]).slice(0, 60);
  } catch (e) { out.series = String(e); }
  const probes = (out.nbaSeries || []).filter(([t, title]) => /PTS|POINT|REB|AST|PLAYER|PROP|3PT|THREE/i.test(t + ' ' + title)).slice(0, 4).map(([t]) => t);
  out.propSamples = await Promise.all(probes.map((t) => grab(`${K}/markets?series_ticker=${t}&status=open&limit=3`, 1600)));
  out.gameSample = await grab(`${K}/markets?series_ticker=KXNBAGAME&status=open&limit=2`, 1200);
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  out.espnScoreboard = await grab(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${d}`, 600);
  out.espnGamelog = await grab('https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/3112335/gamelog', 900);
  out.espnInjuries = await grab('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries', 500);
  out.nbaCdn = await grab('https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json', 400);
  out.nbaStats = await grab('https://stats.nba.com/stats/playergamelog?PlayerID=203999&Season=2026-27&SeasonType=Regular%20Season', 300,
    { Referer: 'https://www.nba.com/', Origin: 'https://www.nba.com', 'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true' });
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(out, null, 1));
};
