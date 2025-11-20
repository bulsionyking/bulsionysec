const CACHE_NAME = 'bulsionysec-v1';
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.webmanifest',
  './icon-512x512.png',
  './icon-192x192.png'
];

// ---------- IndexedDB QUEUE ----------
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('bulsionysec-sync-db', 1);
    request.onupgradeneeded = e => {
      e.target.result.createObjectStore('syncQueue', { autoIncrement: true });
    };
    request.onsuccess = e => resolve(e.target.result);
    request.onerror = reject;
  });
}

async function pushToQueue(payload) {
  const db = await openDB();
  const tx = db.transaction('syncQueue', 'readwrite');
  tx.objectStore('syncQueue').add(payload);
  return tx.complete;
}

async function popAllFromQueue() {
  const db = await openDB();
  const tx = db.transaction('syncQueue', 'readwrite');
  const store = tx.objectStore('syncQueue');

  let items = [];
  return new Promise(resolve => {
    const req = store.openCursor();
    req.onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) {
        items.push(cursor.value);
        cursor.delete(); // remove after reading
        cursor.continue();
      } else {
        resolve(items);
      }
    };
  });
}

// ---------- INSTALL ----------
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_ASSETS))
  );
});

// ---------- ACTIVATE ----------
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(key => key !== CACHE_NAME && caches.delete(key)))
    )
  );
  self.clients.claim();
});

// ---------- FETCH WITH BACKGROUND SYNC ----------
self.addEventListener('fetch', event => {
  const req = event.request;

  // Only sync POST requests to your API endpoint
  if (req.method === 'POST' && req.url.includes('/api/bulsionysec')) {
    event.respondWith(
      fetch(req.clone()).catch(async () => {
        // Save failed request to queue
        const body = await req.clone().text();
        await pushToQueue({
          url: req.url,
          body,
          headers: [...req.headers],
          method: req.method
        });
        
        // Register Background Sync
        const reg = await self.registration.sync.register('sync-bulsionysec');

        return new Response(
          JSON.stringify({ queued: true, offline: true }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  // Default: your network/cache logic for GETs
  if (req.method === 'GET') {
    event.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          return res;
        });
      })
    );
  }
});

// ---------- BACKGROUND SYNC EVENT ----------
self.addEventListener('sync', event => {
  if (event.tag === 'sync-bulsionysec') {
    event.waitUntil(flushQueue());
  }
});

async function flushQueue() {
  const items = await popAllFromQueue();
  for (let item of items) {
    try {
      await fetch(item.url, {
        method: item.method,
        headers: item.headers,
        body: item.body
      });
    } catch (err) {
      // Put back if still failing
      await pushToQueue(item);
    }
  }
}
  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Use network-first for same-origin navigation (so content updates)
  if (event.request.mode === 'navigate' || (event.request.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      fetch(event.request)
        .then(resp => {
          // Update cache with fresh HTML
          const respClone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, respClone));
          return resp;
        })
        .catch(() => caches.match('/index.html')) // fallback to cached shell
    );
    return;
  }

  // For static resources: cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request)
        .then(res => {
          // Put a copy in cache
          const resClone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, resClone));
          return res;
        })
        .catch(() => {
          // optional fallback for images
          if (event.request.destination === 'image') {
            return caches.match('/icon-192x192.png');
          }
        });
    })
  );
});                 
