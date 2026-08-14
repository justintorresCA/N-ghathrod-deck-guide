/* Planeswalker's Field Guide — offline service worker
   v2: stale-while-revalidate for the document + "update available" signal.
   The page loads instantly from cache; a fresh copy is fetched in the background,
   and when it differs from what was served, the page is told so it can offer a refresh.
   Because the document is revalidated every load, re-uploading index.html is enough
   to trigger an update — this sw.js does not need to change per deploy. */
const CACHE = 'nghathrod-field-guide-v2';
const DOC = './index.html';
const ASSETS = ['./', './index.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    const old = keys.filter((k) => k !== CACHE);
    await Promise.all(old.map((k) => caches.delete(k)));
    await self.clients.claim();
    // If we replaced a previous version (old caches existed), a new app version is now live.
    if (old.length) {
      const clients = await self.clients.matchAll({ includeUncontrolled: true });
      clients.forEach((c) => c.postMessage({ type: 'UPDATE_AVAILABLE' }));
    }
  })());
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function isDoc(req) {
  if (req.mode === 'navigate') return true;
  try {
    const u = new URL(req.url);
    return u.pathname.endsWith('/') || u.pathname.endsWith('/index.html');
  } catch (err) { return false; }
}

// Cheap check first (validators), then an exact body compare as a guaranteed fallback.
async function hasChanged(oldResp, newResp) {
  if (!oldResp) return false;
  const oTag = oldResp.headers.get('etag') || oldResp.headers.get('last-modified');
  const nTag = newResp.headers.get('etag') || newResp.headers.get('last-modified');
  if (oTag && nTag) return oTag !== nTag;
  try {
    const a = await oldResp.clone().text();
    const b = await newResp.clone().text();
    return a !== b;
  } catch (err) { return false; }
}

async function notifyUpdated() {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach((c) => c.postMessage({ type: 'UPDATE_AVAILABLE' }));
}

// Document: serve cache immediately, revalidate in background, flag real changes.
async function docHandler(req) {
  const cache = await caches.open(CACHE);
  const cached = (await cache.match(req)) || (await cache.match(DOC));
  const network = fetch(req).then(async (resp) => {
    if (resp && resp.ok && resp.type !== 'opaque') {
      try {
        const changed = await hasChanged(cached, resp);
        await cache.put(req, resp.clone());
        await cache.put(DOC, resp.clone());
        if (cached && changed) await notifyUpdated();
      } catch (err) {}
    }
    return resp;
  }).catch(() => null);
  return cached || network || cache.match(DOC);
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const resp = await fetch(req);
    if (resp && resp.ok && resp.type !== 'opaque') cache.put(req, resp.clone());
    return resp;
  } catch (err) {
    return cache.match(DOC);
  }
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(isDoc(e.request) ? docHandler(e.request) : cacheFirst(e.request));
});
