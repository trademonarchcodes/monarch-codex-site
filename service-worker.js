const CACHE_NAME = 'monarch-codex-pwa-v4';
const APP_SHELL = ['/', '/manifest.webmanifest', '/app-icon.svg', '/assets/css/style.css', '/assets/js/main.js', '/assets/images/monarch-codex-logo.svg'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('monarch-codex-pwa-') && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Never cache sign-in, member pages, financial actions, or API responses.
  if (url.pathname.startsWith('/api/') || /^\/(login|register|logout|dashboard|deposit|withdraw|transactions|admin|kyc)(\/|$)/i.test(url.pathname)) return;
  if (request.mode === 'navigate') {
    if (url.pathname !== '/') return;
    event.respondWith(fetch(request).then(response => {
      if (response && response.ok) caches.open(CACHE_NAME).then(cache => cache.put('/', response.clone()));
      return response;
    }).catch(async () => (await caches.match('/')) || Response.error()));
    return;
  }
  if (APP_SHELL.includes(url.pathname) || url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.match(request).then(cached => {
      const fresh = fetch(request).then(response => {
        if (response && response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
        return response;
      });
      return cached || fresh;
    }));
  }
});
