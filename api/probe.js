// TEMPORARY: finds which Kalshi NBA player-stat markets are open. Preview branch only.
const H = { 'User-Agent': 'investment-project probe', Accept: 'application/json' };
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const j = async (u) => (await fetch(u, { headers: H, signal: AbortSignal.timeout(8000) })).json();
module.exports = async (req, res) => {
  const out = {};
  const all = (await j(K + '/series?category=Sports')).series || [];
  const nba = all.filter((s) => /^KXNBA/.test(s.ticker) && /PTS|REB|AST|3PT|PRA|STL|BLK|PLAYER|THREE|POINT|REBOUND|ASSIST|DOUBLE/i.test(s.ticker + ' ' + s.title));
  out.candidates = nba.map((s) => [s.ticker, s.title]);
  out.open = [];
  await Promise.all(nba.map(async (s) => {
    try {
      const m = (await j(`${K}/markets?series_ticker=${s.ticker}&status=open&limit=200`)).markets || [];
      if (!m.length) return;
      const x = m[0];
      out.open.push({ series: s.ticker, title: s.title, count: m.length,
        sample: { ticker: x.ticker, event: x.event_ticker, title: x.title, yes: x.yes_sub_title, no: x.no_sub_title, strike: x.floor_strike, type: x.strike_type,
          bid: x.yes_bid_dollars, ask: x.yes_ask_dollars, vol: x.volume_fp, oi: x.open_interest_fp, close: x.close_time, occ: x.occurrence_datetime, cs: x.custom_strike, rules: (x.rules_primary || '').slice(0, 220) } });
    } catch (e) { /* skip */ }
  }));
  out.open.sort((a, b) => b.count - a.count);
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(out, null, 1));
};
