/*
  Service worker для ТП Мониторинг.
  ВАЖНО: кэшируется только статическая "оболочка" приложения (сам index.html,
  манифест, иконки, внешние библиотеки с CDN). Все запросы к /wapi/* (Wialon)
  и к Supabase — ВСЕГДА идут напрямую в сеть, никогда не кэшируются, иначе
  можно было бы увидеть устаревшие координаты машин или старые данные.
*/

const CACHE_NAME = 'tp-monitoring-shell-v1';

const SHELL_FILES = [
  '/',
  '/index.html',
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
      // addAll может упасть, если хоть один ресурс недоступен (например, нет сети
      // при первой установке) — подстраховываемся, чтобы установка не срывалась целиком
      Promise.allSettled(SHELL_FILES.map((url) => cache.add(url)))
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
  if (req.method !== 'GET') return; // POST/PATCH/DELETE к Wialon/Supabase не трогаем

  const url = new URL(req.url);

  // никогда не кэшируем живые данные
  if (url.pathname.startsWith('/wapi/')) return;
  if (url.hostname.endsWith('.supabase.co')) return;
  if (url.hostname.includes('wialon')) return;
  if (url.hostname.includes('nominatim')) return;

  const isShellFile = SHELL_FILES.includes(req.url) || SHELL_FILES.includes(url.pathname);
  if (!isShellFile) return; // всё остальное — обычный сетевой запрос браузера

  // shell-файлы: кэш в приоритете, в фоне обновляем на случай нового деплоя
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
