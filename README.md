# Investment Project

AMAGENCY tool: live odds, liquidity and edge for Kalshi's **BTC 15-minute** markets (series `KXBTC15M`).
It has its own GitHub repo and its own Vercel project (`investment-project`), separate from every client project.

## Simple and Pro
**Simple** (default) shows what you need to act: the call with a plain-English reason, *Is the price right?*
(our chance vs Kalshi's price for each side), *Why: the evidence*, *Price vs target*, *Trend & past rounds*,
the bet log and settings. **Pro** adds the full odds table, forecast and odds-over-time charts, Kalshi and spot
order books, and market pulse. Every card has a **?** that explains it in one sentence.

**Why: the evidence** lists each signal (distance to target, 5-minute momentum, 1-hour trend, order book,
who is trading, forced exits, futures positioning, Kalshi traders, past rounds), says which way it points and how
strongly, and tallies them. Distance and time decide most rounds; the rest is short-term pressure.

**Trend & past rounds** charts BTC over 1H / 4H / 24H with a moving average, shades every past 15-minute
round green (Up) or red (Down), and lists the last nine results with how far each one finished from its target.

**Alerts**: tap *Alert me* for a chime and vibration whenever a Buy call appears; the tab title also flags it.

## Sports (NBA player props) · `/sports`
- **Data:** every open Kalshi NBA player-prop market (points, rebounds, assists, threes, PRA and other combos,
  steals, blocks) from `/api/nba`, matched to ESPN rosters, game logs (this season and last), team defense
  (points allowed) and the injury report. Built in about 1–2 s and cached for 90 s.
- **Projection:** minutes (last 5 / season / last season blend) × production per minute (this season, leaning on
  last season until ~10 games, plus recent form), nudged by opponent defense for scoring props.
  Chance of hitting the line uses a normal model for points and combos and a negative-binomial model for counts,
  both widened for model uncertainty.
- **Value:** our chance vs Kalshi's ask plus fee, for both Yes and No. A suggestion only appears when the advantage
  clears your minimum (default 6 points), the spread is 10¢ or less, the player has 15+ games of history, isn't on
  the injury report, and the game hasn't started. Every prop shows our fair price for limit orders.
- **Evidence:** season and last-5 averages, hit rate over the last 10, minutes trend, opponent defense, last season,
  injury status and the model's projection, plus a last-10-games bar chart against the line.
- **Safety:** max bet (default $2), quarter-Kelly sizing and a daily loss limit (default $10, pending bets count as
  losses). Once reached, Buy suggestions stop until the next day.
- **Home Screen:** `/sports` has its own icon and manifest (`/api/manifest?app=sports`), installable separately.

## Home Screen app
- **iPhone:** open the site in Safari, tap Share, then *Add to Home Screen*. The app shows these steps itself.
  **Android / desktop Chrome:** tap *Install app* on the card, or use the browser menu.
- Manifests are served by `/api/manifest` (Desk) and `/api/manifest?app=sports` (Sports).
  The app is public, so no sign-in link is used. If production is ever made private again, home-screen apps need a
  signed-in start URL (see git history for the shareable-link approach) and the old link should be rotated.
- `sw.js` keeps a copy of the look and shows `offline.html` when there's no signal. Live data is never cached.
- If the app is ever made private and sign-in expires, the pages show a *Sign in again* banner instead of stalling.

## What it shows
- **The call**: Buy Up, Buy Down, Skip or Check data, with stake, contracts and edge.
- **Our odds vs Kalshi**: model probability, Kalshi ask, fee, edge, fair vs Kalshi payout, buyable depth.
- **Charts**: where BTC is forecast to settle, our odds vs Kalshi through the window, price vs target.
- **Liquidity**: Kalshi order book ladders, spot depth and imbalance (Coinbase + Kraken), taker flow.
- **Market pulse**: realized speed, Deribit DVOL, funding, open interest, perp premium, liquidations, exchange prices, index calibration.
- **Bet log**: logs trades placed in Kalshi and settles them automatically, comparing expected vs actual profit.

## Pages
- `/` the desk, `/status` live health of every data source (server and this device) plus the security setup, and a branded 404.
- Light and dark themes (follows the device, or tap the theme button). Installs to the home screen with its own icon.
- Accessibility: WCAG 2.2 AA contrast in both themes, skip link, labelled landmarks and tables, screen-reader announcements
  when the call changes, keyboard-explorable charts (focus a chart, use the arrow keys), 44px tap targets,
  reduced-motion and high-contrast support. Audited with axe-core on every page, at phone, tablet and desktop widths, in both themes.

## Speed
- BTC price streams tick-by-tick straight from Coinbase over WebSocket; the numbers repaint up to 4x a second.
- Charts and odds load from a small trend feed (~0.7 s to first evidence); heavier order-book data loads alongside.
  The last trend data is kept on the device, so charts appear instantly when you reopen the app.
- In the background the app sleeps (stream closed, polling paused) unless alerts are on; charts are drawn only
  when they're on screen.
- Kalshi's order book refreshes every second. The server keeps market details and spot prices warm in memory,
  so a typical refresh is a single upstream call. Functions run in `iad1` (US East), next to Kalshi and Coinbase.
- The header shows the live round-trip time. If the stream drops, the app falls back to 1-second polling and reconnects.

## Security
- Public and read-only: anyone with the link can view production. Preview deployments stay behind Vercel Authentication.
  Pages and API send `noindex`, and API responses are CDN-cached (1–90 s) so public traffic can't overload upstream sources.
- Strict headers on every response: Content-Security-Policy (scripts from this site only; connections only to this
  site and the Coinbase stream), no framing, no referrer, no camera/mic/location, nosniff, HSTS.
- Read-only API: GET/HEAD only, inputs validated. No API keys, no accounts, no third-party scripts, no dependencies.
- The bet log stays in the browser on your device.

## The model
Kalshi settles on the 60-second average of CF Benchmarks BRTI before the close, compared with the 60-second
average before the open (the target). BRTI is estimated as Coinbase plus the gap measured from Kalshi's last 8
targets. BTC is treated as a random walk with speed *s* (dollars per square-root minute, from Coinbase 1-minute candles):

- more than 60s left: settlement ~ Normal(now, s²/60 · (T − 40s))
- inside the final minute: the known part of the average is locked in; remaining variance is s²/60 · r³ / (3·60²)
- the calibration error is added to the variance

Edge = our probability − (Kalshi ask + fee), fee ≈ rate · p · (1 − p). Stake = bankroll × Kelly fraction × edge / (1 − cost), capped.
If our odds and Kalshi's differ by more than 25 points the call is **Check data**, never Buy.

## Endpoints
| Route | Refresh | Data |
|---|---|---|
| `/api/live` | 1s | open market, order book, spot prices, timing |
| `/api/trend` | 30s | 1-min and 5-min candles, speed, calibration, last 24h of Kalshi results |
| `/api/context` | 15s | spot depth, taker flow, Deribit, Hyperliquid, implied volatility, liquidations |
| `/api/history` | once per window | Kalshi minute prices for back-fill |
| `/api/result` | 30s | settlement of logged bets |
| `/api/nba` | 2 min | NBA props, projections, evidence (`?summary=1` for a health summary) |
| `/api/manifest` | on install | home-screen app manifests (`?app=sports` for Sports) |
| `/api/health` | on demand | latency and status of every upstream, including the Coinbase stream |
