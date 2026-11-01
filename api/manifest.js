// Web app manifests for "Add to Home Screen": the Desk (default) and Sports
// (?app=sports). The app is public, so no sign-in link is needed.
const { allowGet } = require('./_lib');

module.exports = (req, res) => {
  if (!allowGet(req, res)) return;
  const auth = '';
  const sports = req.query && req.query.app === 'sports';
  if (sports) {
    res.setHeader('content-type', 'application/manifest+json; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=0, s-maxage=3600');
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
  res.setHeader('cache-control', 'public, max-age=0, s-maxage=3600');
  res.end(JSON.stringify(manifest));
};
