importScripts('./version.js');
const CACHE_NAME = `schedule-v${APP_VERSION}`;

const PRECACHE_URLS = [
    './',
    './index.html',
    './manifest.json',
    './version.js',
    './icons/icon-180.png',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
            )
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    // API responses must never be cached: stale data would silently overwrite server state.
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return;

    event.respondWith(
        caches.match(req).then((cached) => {
            // iOS Safari refuses to serve cached responses whose `redirected` flag is true
            // ("Response served by service worker has redirections"). Drop them and refetch.
            const cachedSafe = (cached && !cached.redirected) ? cached : null;
            const fetchPromise = fetch(req)
                .then((res) => {
                    if (res && res.status === 200 && !res.redirected && (res.type === 'basic' || res.type === 'cors')) {
                        const copy = res.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
                    }
                    return res;
                })
                .catch(() => cachedSafe);
            return cachedSafe || fetchPromise;
        })
    );
});
