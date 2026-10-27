/* Service worker: сайт открывается и без интернета (в поле, в подвале).
   - Оболочка приложения и файлы данных: сначала сеть, при отказе — кэш
     (так обновления видны сразу, а офлайн всё равно работает).
   - Тайлы карты: из кэша, в фоне обновляются; кэш ограничен по размеру.
   - Firebase/Firestore сюда не попадают — у Firestore свой офлайн-кэш. */
const VERSION = 'v6-embedded-app';
const APP_CACHE = `app-${VERSION}`;
const TILE_CACHE = 'tiles-v1';
const MAX_TILES = 2500;

const APP_SHELL = [
  './', 'index.html', 'css/app.css', 'icon.svg', 'manifest.webmanifest',
  'js/icons.js', 'js/i18n.js', 'js/core.js', 'js/sheet-sync.js', 'js/photos.js', 'js/registry.js', 'js/snapshot.js',
  'gis-control-data.js', 'repair-works-data.js', 'house-numbers-data.js', 'landmarks-data.js', 'playground-registry-data.js'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(APP_CACHE).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('app-') && k !== APP_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isTile = url => /arcgisonline\.com\/ArcGIS\/rest\/services\/.+\/tile\/|basemaps\.cartocdn\.com\//.test(url);
const isLib = url => /cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.(googleapis|gstatic)\.com|gstatic\.com\/firebasejs/.test(url);

async function trimTiles() {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  if (keys.length > MAX_TILES) await Promise.all(keys.slice(0, keys.length - MAX_TILES).map(k => cache.delete(k)));
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  if (req.headers.has('Authorization') || /firebasestorage\.googleapis\.com|storage\.googleapis\.com/.test(new URL(url).hostname)) return;

  if (isTile(url)) {
    event.respondWith(caches.open(TILE_CACHE).then(async cache => {
      const cached = await cache.match(req);
      const network = fetch(req).then(res => {
        if (res.ok || res.type === 'opaque') { cache.put(req, res.clone()); trimTiles(); }
        return res;
      }).catch(() => cached);
      return cached || network;
    }));
    return;
  }

  if (isLib(url)) {
    event.respondWith(caches.open(APP_CACHE).then(async cache => {
      const cached = await cache.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    }));
    return;
  }

  if (new URL(url).origin === self.location.origin) {
    event.respondWith(fetch(req).then(res => {
      if (res.ok) caches.open(APP_CACHE).then(cache => cache.put(req, res.clone()));
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
  }
});
