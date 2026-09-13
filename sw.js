/*
  Service worker для ТП Мониторинг.
  ВАЖНО: кэшируется только статическая "оболочка" приложения. Все запросы к /wapi/*
  (Wialon) и к Supabase — ВСЕГДА идут напрямую в сеть, никогда не кэшируются.

  index.html и '/' — NETWORK-FIRST: всегда пытаемся взять свежую версию из сети
  (это же сам код приложения — если кэшировать его агрессивно, любое обновление
  приложения не будет доходить до пользователя, пока он сам не сбросит кэш).
  Кэш для них используется только как fallback, если реально нет сети (офлайн).

  Библиотеки с CDN (leaflet, qrcode) и иконки — CACHE-FIRST, они не меняются
  между деплоями, кэшировать их агрессивно безопасно и быстрее.
*/

const CACHE_NAME = 'tp-monitoring-shell-v2';

const NETWORK_FIRST = ['/', '/index.html'];
const CACHE_FIRST = [
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled([...NETWORK_FIRST, ...CACHE_FIRST].map((url) => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  if (url.pathname.startsWith('/wapi/')) return;
  if (url.hostname.endsWith('.supabase.co')) return;
  if (url.hostname.includes('wialon')) return;
  if (url.hostname.includes('nominatim')) return;

  const isNetworkFirst = NETWORK_FIRST.includes(url.pathname) || (url.origin === self.location.origin && url.pathname === '/');
  if (isNetworkFirst){
    event.respondWith(
      fetch(req, { cache: 'no-store' }).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  const isCacheFirst = CACHE_FIRST.includes(req.url) || CACHE_FIRST.includes(url.pathname);
  if (!isCacheFirst) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

