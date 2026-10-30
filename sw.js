/* PDS Contract 1161: keeps a copy of the app on the phone so it opens with poor or no signal.
   Driver data is not stored here. Firebase keeps its own offline copy of the records each person is allowed to see. */
const CACHE = 'pds-app-v1';
/* sw 3: a refresh for a new version always fetches the newest copy */
/* sw 2: saved copy first */
const SHELL = ['./', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
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

const timeout = (p, ms) => new Promise((ok, no) => { const t = setTimeout(() => no(new Error('slow')), ms); p.then(r => { clearTimeout(t); ok(r) }, x => { clearTimeout(t); no(x) }) });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  /* The app page itself: open the saved copy straight away so it starts fast,
     then fetch the newest copy in the background. If it is a newer version, tell the app so it can refresh. */
  if (req.mode === 'navigate' && url.origin === location.origin) {
    const fresh = (async () => {
      const c = await caches.open(CACHE);
      const r = await fetch(new Request(url.origin + url.pathname, { cache: 'no-cache', credentials: 'same-origin' }));
      if (!r.ok) return r;
      const saved = await c.match('./');
      await c.put('./', r.clone());
      if (saved) {
        const a = saved.headers.get('etag'), b = r.headers.get('etag');
        if (!(a && b && a === b)) {
          const [ot, nt] = await Promise.all([saved.clone().text(), r.clone().text()]);
          const ov = (ot.match(/const VERSION='(\d+)'/) || [])[1] || '', nv = (nt.match(/const VERSION='(\d+)'/) || [])[1] || '';
          if (nv && +nv > +ov) for (const cl of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) cl.postMessage({ type: 'c1161-update', v: nv });
        }
      }
      return r;
    })();
    e.respondWith((async () => {
      const saved = await (await caches.open(CACHE)).match('./');
      if (url.searchParams.has('v')) return fresh.catch(() => saved || Response.error());
      if (saved) { e.waitUntil(fresh.catch(() => {})); return saved }
      return fresh;
    })());
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
