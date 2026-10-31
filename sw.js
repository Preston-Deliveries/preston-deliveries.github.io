/* PDS Contract 1161: keeps a copy of the app on the phone so it opens with poor or no signal.
   Driver data is not stored here. Firebase keeps its own offline copy of the records each person is allowed to see. */
const CACHE = 'pds-app-v3';
/* sw 4: the app page always comes live from the internet; no saved copy of the app is kept */
const SHELL = ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
const LIBS = [
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check-compat.js'
];
/* Outside files worth keeping: the Firebase app code, the spreadsheet and screenshot tools, and the fonts */
const KEEP = [/^https:\/\/www\.gstatic\.com\/firebasejs\//, /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\//, /^https:\/\/fonts\.(googleapis|gstatic)\.com\//];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'no-cache' })).catch(() => {})));
    await Promise.all(LIBS.map(u => fetch(u, { mode: 'no-cors' }).then(r => c.put(u, r)).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

const OFFLINE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>No internet</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0F2A44;color:#fff;font:18px system-ui;text-align:center;padding:24px;box-sizing:border-box}h1{font-size:28px;margin:0 0 12px}p{margin:0 0 24px;opacity:.85}button{background:#F27A1A;color:#fff;border:0;border-radius:12px;padding:16px 28px;font:600 18px system-ui}</style></head><body><div><h1>No internet</h1><p>The app needs internet to open. Check your signal or WiFi, then try again.</p><button onclick="location.reload()">Try again</button></div></body></html>`;

const timeout = (p, ms) => new Promise((ok, no) => { const t = setTimeout(() => no(new Error('slow')), ms); p.then(r => { clearTimeout(t); ok(r) }, x => { clearTimeout(t); no(x) }) });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  /* The app page itself: always the live version from the internet. With no signal, say so plainly. */
  if (req.mode === 'navigate' && url.origin === location.origin) {
    e.respondWith(fetch(req, { cache: 'no-store' }).catch(() => new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
    return;
  }

  /* The app checking for a newer version must always ask the server */
  if (url.origin === location.origin && url.search) return;

  /* Icons and the install file: answer from the saved copy, refresh it in the background */
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const saved = await c.match(req);
      const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r }).catch(() => saved);
      return saved || net;
    })());
    return;
  }

  /* Firebase app code, tools and fonts: these addresses never change, so the saved copy is used first */
  if (KEEP.some(r => r.test(req.url))) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const saved = await c.match(req, { ignoreVary: true });
      if (saved) return saved;
      const r = await fetch(req);
      if (r.ok || r.type === 'opaque') c.put(req, r.clone());
      return r;
    })());
  }
  /* Everything else (sign in, the database, WhatsApp) goes straight to the internet as normal */
});


/* Phone notifications: show them even when the app is closed, and open the right page when tapped */
self.addEventListener('push', e => {
  let j = {};
  try { j = e.data ? e.data.json() : {}; } catch (x) { try { j = { data: { body: e.data.text() } }; } catch (y) {} }
  const d = j.data || j.notification || j;
  const title = d.title || 'Preston Delivery Service';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: d.kind ? 'pds-' + d.kind + '-' + Date.now() : undefined,
    data: { url: d.url || '' },
    vibrate: [200, 100, 200]
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const hash = (e.notification.data && e.notification.data.url) || '';
  const target = new URL('./' + (hash.startsWith('#') ? hash : ''), self.registration.scope).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(self.registration.scope)) { try { await c.focus(); if (hash) c.navigate(target); } catch (x) {} return; }
    }
    await self.clients.openWindow(target);
  })());
});
