# Investment Project

Private AMAGENCY tool: live odds, liquidity and edge for Kalshi's **BTC 15-minute** markets (series `KXBTC15M`).
It has its own GitHub repo and its own Vercel project (`investment-project`), separate from every client project.

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
- Kalshi's order book refreshes every second. The server keeps market details and spot prices warm in memory,
  so a typical refresh is a single upstream call. Functions run in `iad1` (US East), next to Kalshi and Coinbase.
- The header shows the live round-trip time. If the stream drops, the app falls back to 1-second polling and reconnects.

## Security
- Vercel Authentication: only signed-in members of the AMAGENCY Vercel team can open the app or its API.
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
| `/api/context` | 15s | speed, calibration, spot depth, taker flow, Deribit, Hyperliquid, liquidations |
| `/api/history` | once per window | Kalshi minute prices for back-fill |
| `/api/result` | 30s | settlement of logged bets |
| `/api/health` | on demand | latency and status of every upstream, including the Coinbase stream |
