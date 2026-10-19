// The Airports preview now lives in the main app. This retires the preview's service worker:
// it clears the preview cache, unregisters itself and sends any open preview tab to the app.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('nycpv-')) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({type: 'window'})) try { await c.navigate('../'); } catch (_) {}
})()));
