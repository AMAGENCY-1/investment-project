/* Theme: Auto (follows the device), Light or Dark. Runs in <head> so there's no flash. */
(function () {
  var KEY = 'ip.theme';
  var NAMES = { auto: 'Auto', light: 'Light', dark: 'Dark' };
  function get() { try { return localStorage.getItem(KEY) || 'auto'; } catch (e) { return 'auto'; } }
  function apply(mode) {
    var root = document.documentElement;
    if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode);
    else root.removeAttribute('data-theme');
  }
  apply(get());
  // Detail level (Simple / Pro), applied early so Pro panels never flash.
  try { if (localStorage.getItem('ip.view') === 'pro') document.documentElement.setAttribute('data-view', 'pro'); } catch (e) { /* default Simple */ }
  // Offline support for the home-screen app.
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
  }
  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('themeBtn');
    function sync(mode) {
      var bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta && bg) meta.setAttribute('content', bg);
      if (!btn) return;
      var label = btn.querySelector('.theme-label');
      if (label) label.textContent = NAMES[mode];
      btn.setAttribute('aria-label', 'Theme: ' + NAMES[mode] + '. Switch theme');
    }
    sync(get());
    if (btn) btn.addEventListener('click', function () {
      var order = ['auto', 'light', 'dark'];
      var next = order[(order.indexOf(get()) + 1) % order.length];
      try { localStorage.setItem(KEY, next); } catch (e) { /* storage unavailable */ }
      apply(next); sync(next);
      window.dispatchEvent(new Event('themechange'));
    });
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: light)');
      var onChange = function () { sync(get()); window.dispatchEvent(new Event('themechange')); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
    }
  });
})();
