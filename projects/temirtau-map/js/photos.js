/* Private photos: authenticated requests only, no download-token URLs or disk cache. */
(function () {
  'use strict';
  const App = window.App;
  const cache = new Map();
  const requests = new Set();
  const MAX_CACHED = 12, TTL = 5 * 60 * 1000;
  let generation = 0;

  function reference(value) {
    if (!App.fb.storage) throw new Error('storage unavailable');
    const ref = /^(https?:|gs:)/.test(value)
      ? App.fb.storage.refFromURL(value) : App.fb.storage.ref(value);
    if (ref.bucket !== App.fb.storage.ref().bucket ||
        !/^(registry-photos|card-photos)\//.test(ref.fullPath)) throw new Error('invalid photo path');
    return ref;
  }

  function discard(key) {
    const entry = cache.get(key);
    if (entry && entry.controller) entry.controller.abort();
    if (entry && entry.url) URL.revokeObjectURL(entry.url);
    cache.delete(key);
  }

  function clear() {
    generation++;
    requests.forEach(controller => controller.abort());
    requests.clear();
    [...cache.keys()].forEach(discard);
    document.querySelectorAll('[data-private-photo]').forEach(img => img.removeAttribute('src'));
  }

  async function load(value) {
    const user = App.auth.user;
    if (!App.auth.isAdmin || !user) throw new Error('not admin');
    const ref = reference(value);
    const key = `${user.uid}|${ref.fullPath}`;
    const old = cache.get(key);
    if (old && Date.now() - old.at < TTL) return old.promise;
    discard(key);
    const epoch = generation;
    const controller = new AbortController();
    requests.add(controller);
    const timer = setTimeout(() => controller.abort(), 30000);
    const entry = { at: Date.now(), url: null, controller };
    entry.promise = (async () => {
      let token = await user.getIdToken();
      const endpoint = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(ref.bucket)}/o/${encodeURIComponent(ref.fullPath)}?alt=media`;
      const request = () => fetch(endpoint, {
        headers: { Authorization: `Firebase ${token}` }, cache: 'no-store', signal: controller.signal
      });
      let response = await request();
      if (response.status === 401) { token = await user.getIdToken(true); response = await request(); }
      if (!response.ok) throw new Error(`photo HTTP ${response.status}`);
      const blob = await response.blob();
      if (!/^image\/(jpeg|png|webp|gif|avif|heic|heif)$/i.test(blob.type)) throw new Error('invalid image');
      if (epoch !== generation || cache.get(key) !== entry || !App.auth.isAdmin || App.auth.user?.uid !== user.uid) throw new Error('session changed');
      entry.url = URL.createObjectURL(blob);
      return entry.url;
    })().catch(err => { if (cache.get(key) === entry) discard(key); throw err; })
      .finally(() => { clearTimeout(timer); requests.delete(controller); });
    cache.set(key, entry);
    for (const [otherKey, other] of cache) {
      if (cache.size <= MAX_CACHED) break;
      if (otherKey !== key && other.url) discard(otherKey);
    }
    return entry.promise;
  }

  function forget(value) {
    const path = reference(value).fullPath;
    for (const key of cache.keys()) if (key.endsWith('|' + path)) discard(key);
  }

  App.on('auth', clear);
  App.photos = { load, clear, forget, reference };
})();
