// Web app manifest for "Add to Home Screen". Served dynamically (and only to
// signed-in visitors, behind Vercel Authentication) so the home-screen app can
// start with the private share link: an iPhone home-screen app keeps its own
// cookies, separate from Safari, so this signs it in on every launch.
const { allowGet } = require('./_lib');

module.exports = (req, res) => {
  if (!allowGet(req, res)) return;
  const token = process.env.HOME_SCREEN_SHARE || '';
  const auth = /^[A-Za-z0-9]{20,64}$/.test(token) ? `?_vercel_share=${token}` : '';
  const sports = req.query && req.query.app === 'sports';
  if (sports) {
    res.setHeader('content-type', 'application/manifest+json; charset=utf-8');
    res.setHeader('cache-control', 'private, no-store');
    return res.end(JSON.stringify({
      id: '/sports',
      name: 'Investment Sports',
      short_name: 'Sports',
      description: 'NBA player props on Kalshi: projections from raw stats, value and evidence.',
      start_url: '/sports' + auth,
      scope: '/',
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#0D0E12',
      theme_color: '#0D0E12',
      categories: ['sports', 'finance'],
      icons: [
        { src: '/icon-sports-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-sports-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icon-sports-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        { src: '/icon-sports.svg', sizes: 'any', type: 'image/svg+xml' },
      ],
    }));
  }
  const manifest = {
    id: '/',
    name: 'Investment Project',
    short_name: 'Investment',
    description: 'Live odds, liquidity and evidence for Kalshi BTC 15-minute markets.',
    start_url: '/' + auth,
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0D0E12',
    theme_color: '#0D0E12',
    categories: ['finance'],
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
    shortcuts: [
      { name: 'Desk', url: '/' + auth },
      { name: 'Status', url: '/status' + auth },
    ],
  };
  res.setHeader('content-type', 'application/manifest+json; charset=utf-8');
  res.setHeader('cache-control', 'private, no-store');
  res.end(JSON.stringify(manifest));
};
