const CACHE = 'review-room-v11';
const SHARE_CACHE = 'review-room-share-inbox';
const SHARE_KEY = './__shared-pgn__';
const ASSETS = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.json',
  'vendor/chess.mjs', 'vendor/stockfish.js', 'vendor/stockfish.wasm', 'vendor/stockfish.asm.js',
  'icons/icon-192.png', 'icons/icon-512.png',
  'pieces/wP.svg','pieces/wN.svg','pieces/wB.svg','pieces/wR.svg','pieces/wQ.svg','pieces/wK.svg',
  'pieces/bP.svg','pieces/bN.svg','pieces/bB.svg','pieces/bR.svg','pieces/bQ.svg','pieces/bK.svg'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(ASSETS.map(u => fetch(u, { cache: 'reload' }).then(r => c.put(u, r)))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // AI/font calls go straight to network
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target/')) {
    e.respondWith(handleShare(e.request));
    return;
  }
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
    const copy = r.clone();
    caches.open(CACHE).then(c => c.put(e.request, copy));
    return r;
  })));
});
async function handleShare(request) {
  let text = '';
  try {
    const formData = await request.formData();
    const file = formData.get('pgn');
    if (file) text = await file.text();
  } catch (err) { /* fall through with empty text */ }
  const cache = await caches.open(SHARE_CACHE);
  await cache.put(SHARE_KEY, new Response(text, { headers: { 'content-type': 'text/plain' } }));
  return Response.redirect('./?shared=1', 303);
}
