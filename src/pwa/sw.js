/** Receives the build's static URLs and version stamp from the Vite plugin. */
const { cache, assets } = self.__HUB_BUILD__;
const assetPaths = new Set(assets);
const root = new URL('/', self.location.origin).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const storage = await caches.open(cache);
    await storage.addAll(assets.map(url => new Request(url, { cache: 'reload' })));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('agent-hub-shell-') && key !== cache) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  // API responses, streams and requests outside this build always use the network.
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.status < 500) return response;
        return await (await caches.open(cache)).match(root) ?? response;
      } catch {
        return await (await caches.open(cache)).match(root) ?? Response.error();
      }
    })());
  } else if (assetPaths.has(url.pathname)) {
    event.respondWith((async () => (await (await caches.open(cache)).match(request)) ?? fetch(request))());
  }
});
