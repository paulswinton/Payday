// Payday offline support: the app's own files are kept on the phone so it opens
// with no signal. Your records are never cached here (they live in IndexedDB),
// and nothing from GitHub is cached.
const VERSION = 'payday-test-1.3.1';
const FILES = ['./', './index.html', './app.css', './manifest.webmanifest',
  './js/theme.js', './js/app.js', './js/ui.js', './js/model.js', './js/plan.js', './js/forecast.js', './js/commands.js',
  './js/money.js', './js/roles.js', './js/payrun.js', './js/calendar.js', './js/store.js', './js/crypto.js', './js/backup.js', './js/importer.js',
  './js/screens/today.js', './js/screens/plan.js', './js/screens/money.js', './js/screens/settings.js', './js/screens/forms.js', './js/screens/payday.js',
  './icons/apple-touch-icon.png', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit ||
    fetch(e.request).catch(() => (e.request.mode === 'navigate' ? caches.match('./index.html') : Response.error()))));
});
