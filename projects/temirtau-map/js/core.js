/* Ядро приложения: Firebase и вход администратора, карта и подложки, поиск,
   маршруты, геолокация и общие UI-примитивы (тосты, диалоги, панели).
   Всё, что связано с объектами реестра, — в registry.js. */
(function () {
  'use strict';
  const App = window.App = window.App || {};

  // ============================================================
  // Firebase — проект mapb-a3590. apiKey публичный по своей природе:
  // доступ на запись ограничивают правила firestore.rules / storage.rules.
  // ============================================================
  const firebaseConfig = {
    apiKey: 'AIzaSyCI3pGs2-zdQFPEJXFS1OVDfnElPKo2l-Q',
    authDomain: 'mapb-a3590.firebaseapp.com',
    projectId: 'mapb-a3590',
    storageBucket: 'mapb-a3590.firebasestorage.app',
    messagingSenderId: '149350634289',
    appId: '1:149350634289:web:fff14816c5bde28f499610'
  };

  const CENTER = [50.0546, 72.9647];
  const HOUSE_NUM_MIN_ZOOM = 17;
  const HOUSE_NUM_MAX_MARKERS = 450; // защита от лагов в плотных кварталах на слабых телефонах
  const LANDMARK_MIN_ZOOM = 15;
  const LANDMARK_COLORS = { mall: '#F59E0B', health: '#F87171', edu: '#A78BFA', park: '#34D399', culture: '#F472B6' };

  // ===== Мелкие утилиты =====
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Текст из KML/HTML-описаний: <br> → перевод строки, теги и сущности убираем
  function plainText(value) {
    return String(value == null ? '' : value)
      .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
      .replace(/\r/g, '').trim();
  }

  function debounce(fn, ms) {
    let timer = null;
    return function (...args) { clearTimeout(timer); timer = setTimeout(() => fn.apply(this, args), ms); };
  }

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function formatDate(value) {
    if (!value) return '—';
    const d = value && value.toDate ? value.toDate() : new Date(value);
    if (isNaN(d)) return '—';
    const locale = App.lang === 'kk' ? 'kk-KZ' : App.lang === 'en' ? 'en-GB' : 'ru-RU';
    return d.toLocaleString(locale, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // Настройки пользователя (язык, подложка, фильтры). Ключи с префиксом tmap.;
  // приватный режим/заблокированное хранилище не должны ломать сайт.
  const store = {
    get(key, def) {
      try { const v = localStorage.getItem('tmap.' + key); return v == null ? def : JSON.parse(v); } catch (e) { return def; }
    },
    set(key, value) {
      try { localStorage.setItem('tmap.' + key, JSON.stringify(value)); } catch (e) { /* хранилище недоступно */ }
    }
  };

  // Однократный перенос настроек со старой версии сайта (ключи trash-map-*)
  function migrateOldSettings() {
    try {
      if (store.get('lang') == null && localStorage.getItem('trash-map-lang')) store.set('lang', localStorage.getItem('trash-map-lang'));
      if (store.get('section') == null && localStorage.getItem('trash-map-section')) {
        const s = localStorage.getItem('trash-map-section');
        store.set('section', s === 'repair' ? 'repair' : 'gis');
      }
      if (store.get('tracking') == null && localStorage.getItem('trash-map-tracking')) store.set('tracking', localStorage.getItem('trash-map-tracking') === 'true');
      // Старый «админ-флаг» в браузере больше ничего не значит — удаляем
      ['trash-map-admin', 'trash-map-lang', 'trash-map-section', 'trash-map-tracking', 'trash-map-my-name'].forEach(k => localStorage.removeItem(k));
    } catch (e) { /* ignore */ }
  }

  // ===== Шина событий между модулями =====
  const listeners = {};
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function emit(evt, ...args) {
    (listeners[evt] || []).forEach(fn => { try { fn(...args); } catch (err) { console.error(`[${evt}]`, err); } });
  }

  Object.assign(App, { $, $$, esc, plainText, debounce, haversine, formatDate, store, on, emit, CENTER });

  // ===== Тосты =====
  let toastTimer = null;
  function toast(msg, opts = {}) {
    const el = $('#toast');
    el.innerHTML = `<span class="toast-text">${esc(msg)}</span>` +
      (opts.action ? `<button type="button" class="toast-action">${esc(opts.action.label)}</button>` : '');
    el.classList.toggle('toast-error', !!opts.error);
    el.classList.toggle('has-action', !!opts.action);
    if (opts.action) {
      el.querySelector('.toast-action').addEventListener('click', () => { hide(); opts.action.fn(); });
    }
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hide, opts.duration || (opts.action ? 7000 : 3200));
    function hide() { el.classList.remove('show'); }
  }

  // ===== Диалоги (вместо системных prompt/confirm) =====
  let dialogOpen = false;
  function dialog({ title, html, actions, onOpen, dismissValue = null, wide = false }) {
    actions = actions || [{ label: App.t('ok'), value: true, kind: 'primary' }];
    return new Promise(resolve => {
      const root = $('#dialog');
      root.innerHTML = `
        <div class="dialog-box${wide ? ' dialog-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
          ${title ? `<h3 class="dialog-title" id="dialog-title">${esc(title)}</h3>` : ''}
          <div class="dialog-body">${html || ''}</div>
          <div class="dialog-error hidden"></div>
          <div class="dialog-actions">
            ${actions.map((a, i) => `<button type="button" class="btn btn-${a.kind || 'secondary'}" data-i="${i}">${esc(a.label)}</button>`).join('')}
          </div>
        </div>`;
      root.classList.add('open');
      dialogOpen = true;
      const close = value => {
        root.classList.remove('open');
        root.innerHTML = '';
        dialogOpen = false;
        document.removeEventListener('keydown', onKey, true);
        resolve(value);
      };
      const run = async (a, btn) => {
        if (a.validate) {
          btn.disabled = true;
          let error = null;
          try { error = await a.validate(root); } catch (err) { error = String(err && err.message || err); }
          btn.disabled = false;
          if (error) {
            const box = root.querySelector('.dialog-error');
            box.textContent = error;
            box.classList.remove('hidden');
            return;
          }
        }
        close(typeof a.value === 'function' ? a.value(root) : a.value);
      };
      root.querySelectorAll('[data-i]').forEach(btn => btn.addEventListener('click', () => run(actions[+btn.dataset.i], btn)));
      root.onclick = e => { if (e.target === root) close(dismissValue); };
      const onKey = e => {
        if (e.key === 'Escape') { e.stopPropagation(); close(dismissValue); }
        if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
          const idx = actions.findIndex(a => a.kind === 'primary' || a.kind === 'danger');
          if (idx >= 0) { e.preventDefault(); root.querySelector(`[data-i="${idx}"]`).click(); }
        }
      };
      document.addEventListener('keydown', onKey, true);
      if (onOpen) onOpen(root);
      const focusEl = root.querySelector('input, textarea, select') || root.querySelector('.btn-primary, .btn-danger');
      if (focusEl) setTimeout(() => focusEl.focus(), 40);
    });
  }

  function confirmDialog(text, opts = {}) {
    return dialog({
      title: opts.title || '',
      html: `<p class="dialog-text">${esc(text)}</p>`,
      dismissValue: false,
      actions: [
        { label: opts.cancel || App.t('cancel'), value: false },
        { label: opts.ok || App.t('ok'), value: true, kind: opts.danger ? 'danger' : 'primary' }
      ]
    });
  }

  // ===== Боковая панель / нижняя шторка (на телефоне) =====
  let sheetState = {};
  function openSheet({ title, html, key, onClose, guard, onRender, wide }) {
    const sheet = $('#sheet');
    $('#sheet-title').textContent = title || '';
    const body = $('#sheet-body');
    body.innerHTML = html || '';
    body.scrollTop = 0;
    sheet.classList.toggle('sheet-wide', !!wide);
    sheet.classList.remove('sheet-hidden');
    sheet.classList.add('open');
    sheet.style.transform = '';
    $('#backdrop').classList.add('show');
    document.body.classList.add('sheet-open');
    if (sheetState.key !== key && sheetState.onClose) { const cb = sheetState.onClose; sheetState = {}; cb(); }
    sheetState = { key, onClose, guard };
    App.hydrateIcons(body);
    if (onRender) onRender(body);
  }
  function setSheetContent(html, onRender) {
    const body = $('#sheet-body');
    const scroll = body.scrollTop;
    body.innerHTML = html;
    App.hydrateIcons(body);
    if (onRender) onRender(body);
    body.scrollTop = scroll;
  }
  async function closeSheet(force) {
    const sheet = $('#sheet');
    if (!sheet.classList.contains('open')) return true;
    if (!force && sheetState.guard && !(await sheetState.guard())) return false;
    sheet.classList.remove('open');
    sheet.style.transform = '';
    document.body.classList.remove('sheet-open');
    if (!$('#drawer').classList.contains('open')) $('#backdrop').classList.remove('show');
    const cb = sheetState.onClose;
    sheetState = {};
    if (cb) cb();
    return true;
  }
  // Временно спрятать панель (например, чтобы выбрать место на карте), не теряя введённое
  function hideSheetTemporarily(hidden) {
    const sheet = $('#sheet');
    sheet.classList.toggle('sheet-hidden', hidden);
    $('#backdrop').classList.toggle('show', !hidden && sheet.classList.contains('open'));
  }
  const sheetKey = () => sheetState.key || null;
  const isSheetOpen = () => $('#sheet').classList.contains('open');

  function setupSheetDrag() {
    // На телефоне шторку можно смахнуть вниз за «ручку» или заголовок
    const sheet = $('#sheet');
    const handle = $('#sheet-grip');
    let start = null;
    const isMobile = () => window.matchMedia('(max-width: 760px)').matches;
    const down = e => {
      if (!isMobile() || e.target.closest('button')) return;
      start = { y: e.clientY, t: Date.now() };
      sheet.classList.add('dragging');
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    };
    const move = e => {
      if (!start) return;
      const dy = Math.max(0, e.clientY - start.y);
      sheet.style.transform = `translateY(${dy}px)`;
    };
    const up = e => {
      if (!start) return;
      const dy = e.clientY - start.y;
      const fast = dy > 40 && Date.now() - start.t < 250;
      start = null;
      sheet.classList.remove('dragging');
      if (dy > 120 || fast) closeSheet(); else sheet.style.transform = '';
    };
    [handle, $('#sheet-head')].forEach(el => {
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }

  // ===== Меню (левый выдвижной блок) =====
  function openDrawer() {
    emit('drawer-open');
    $('#drawer').classList.add('open');
    $('#backdrop').classList.add('show');
  }
  function closeDrawer() {
    $('#drawer').classList.remove('open');
    if (!isSheetOpen()) $('#backdrop').classList.remove('show');
  }

  Object.assign(App, {
    toast, dialog, confirmDialog,
    sheet: { open: openSheet, close: closeSheet, set: setSheetContent, hide: hideSheetTemporarily, key: sheetKey, isOpen: isSheetOpen },
    drawer: { open: openDrawer, close: closeDrawer }
  });

  // ===== Firebase =====
  App.fb = { ok: false, db: null, storage: null, auth: null };
  function initFirebase() {
    try {
      if (typeof firebase === 'undefined') throw new Error('Firebase SDK не загрузился');
      firebase.initializeApp(firebaseConfig);
      const db = firebase.firestore();
      // Офлайн-кэш: карта и правки работают без связи, а изменения
      // уходят в базу, как только интернет вернётся.
      db.enablePersistence({ synchronizeTabs: true }).catch(() => { /* другая вкладка/неподдерживаемый браузер */ });
      App.fb.db = db;
      App.fb.ok = true;
    } catch (err) {
      console.error('Ошибка инициализации Firebase:', err);
      return;
    }
    try { App.fb.storage = firebase.storage(); } catch (err) { console.warn('Firebase Storage недоступен:', err); }
    try { App.fb.auth = firebase.auth(); } catch (err) { console.warn('Firebase Auth недоступен:', err); }
  }

  // ===== Вход администратора (Firebase Authentication) =====
  // Права определяются НЕ браузером, а базой: документ admins/{uid} создаётся
  // вручную в консоли Firebase, и правила безопасности проверяют именно его.
  App.auth = { user: null, isAdmin: false, ready: false };

  async function checkAdmin(user) {
    if (!user || !App.fb.db) return false;
    try {
      const doc = await App.fb.db.collection('admins').doc(user.uid).get();
      return doc.exists;
    } catch (err) {
      console.warn('Не удалось проверить права администратора:', err);
      return false;
    }
  }

  function initAuth() {
    if (!App.fb.auth) { App.auth.ready = true; return; }
    let revision = 0;
    App.fb.auth.onAuthStateChanged(async user => {
      const current = ++revision;
      App.auth.user = user;
      App.auth.isAdmin = false;
      document.body.classList.remove('is-admin');
      emit('auth'); // revoke private previews immediately on account changes
      const admin = await checkAdmin(user);
      if (current !== revision) return;
      App.auth.user = user;
      App.auth.isAdmin = admin;
      App.auth.ready = true;
      document.body.classList.toggle('is-admin', admin);
      emit('auth');
    });
  }

  function authErrorText(err) {
    const code = err && err.code || '';
    if (/invalid-credential|wrong-password|user-not-found|invalid-email|invalid-login/.test(code)) return App.t('login_err_credentials');
    if (/too-many-requests/.test(code)) return App.t('login_err_many');
    if (/network/.test(code)) return App.t('login_err_network');
    if (/operation-not-allowed|configuration-not-found/.test(code)) return App.t('login_err_disabled');
    return App.t('login_err_generic') + (code ? ` (${code})` : '');
  }

  async function login() {
    if (!App.fb.auth) { toast(App.t('login_err_disabled'), { error: true }); return; }
    const ok = await dialog({
      title: App.t('login_title'),
      html: `
        <p class="dialog-text muted">${esc(App.t('login_hint'))}</p>
        <label class="field-label" for="login-email">${esc(App.t('login_email'))}</label>
        <input id="login-email" class="field" type="email" autocomplete="username" inputmode="email" placeholder="name@example.com">
        <label class="field-label" for="login-pass">${esc(App.t('login_password'))}</label>
        <input id="login-pass" class="field" type="password" autocomplete="current-password">`,
      dismissValue: false,
      actions: [
        { label: App.t('cancel'), value: false },
        {
          label: App.t('login_btn'), kind: 'primary', value: true,
          validate: async root => {
            const email = root.querySelector('#login-email').value.trim();
            const pass = root.querySelector('#login-pass').value;
            if (!email || !pass) return App.t('login_err_empty');
            try {
              const cred = await App.fb.auth.signInWithEmailAndPassword(email, pass);
              if (!(await checkAdmin(cred.user))) {
                await App.fb.auth.signOut();
                return App.t('login_err_not_admin');
              }
              return null;
            } catch (err) {
              return authErrorText(err);
            }
          }
        }
      ]
    });
    if (ok) toast(App.t('login_ok'));
  }

  async function logout() {
    if (!(await confirmDialog(App.t('logout_confirm'), { ok: App.t('logout') }))) return;
    try { await App.fb.auth.signOut(); toast(App.t('logout_ok')); } catch (err) { toast(App.t('error_generic'), { error: true }); }
  }

  Object.assign(App, { login, logout });

  // ===== Карта и подложки =====
  let map = null;
  let baseLayers = [];
  const BASEMAPS = {
    satellite: () => [
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxNativeZoom: 17, maxZoom: 22, crossOrigin: 'anonymous', attribution: 'Снимки © Esri'
      }),
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
        maxNativeZoom: 17, maxZoom: 22, crossOrigin: 'anonymous'
      })
    ],
    // Тёмная и светлая — тоже Esri: бесплатно и без ключа (CARTO стал требовать API-ключ).
    // Над Темиртау тёмная есть до z16, улицы — до z17; дальше Leaflet растягивает.
    dark: () => [
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
        maxNativeZoom: 16, maxZoom: 22, crossOrigin: 'anonymous', attribution: 'Карта © Esri, HERE, OpenStreetMap'
      }),
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
        maxNativeZoom: 16, maxZoom: 22, crossOrigin: 'anonymous'
      })
    ],
    light: () => [
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
        maxNativeZoom: 17, maxZoom: 22, crossOrigin: 'anonymous', attribution: 'Карта © Esri, HERE, OpenStreetMap'
      })
    ]
  };
  App.BASEMAP_TILES = {
    // Для экспорта снимка (snapshot.js) — те же источники, без Leaflet
    satellite: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxZoom: 17 },
    dark: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', maxZoom: 16 },
    light: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', maxZoom: 17 }
  };

  function setBasemap(key) {
    if (!BASEMAPS[key]) key = 'satellite';
    baseLayers.forEach(l => map.removeLayer(l));
    baseLayers = BASEMAPS[key]();
    baseLayers.forEach(l => { l.addTo(map); l.bringToBack(); });
    App.basemap = key;
    store.set('basemap', key);
    document.body.classList.remove('bm-satellite', 'bm-dark', 'bm-light');
    document.body.classList.add('bm-' + key);
    $$('[data-basemap]').forEach(b => b.classList.toggle('active', b.dataset.basemap === key));
    emit('basemap', key);
  }

  let houseLayer, landmarkLayer;
  function initMap() {
    map = App.map = L.map('map', {
      zoomControl: false,
      maxZoom: 22,
      rotate: true,
      touchRotate: true,
      rotateControl: false, // своя кнопка-компас (#compass-btn)
      attributionControl: true,
      worldCopyJump: false
    }).setView(CENTER, 13);
    map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');

    setBasemap(store.get('basemap', 'satellite'));
    houseLayer = L.layerGroup().addTo(map);
    landmarkLayer = L.layerGroup().addTo(map);

    map.on('moveend zoomend', debounce(renderContextLayers, 200));
    map.on('movestart move moveend zoomstart zoom zoomend rotatestart rotate rotateend', onMapGestureActivity);
    map.on('rotate', renderUserHeadingLive);
    map.on('rotate rotateend', () => {
      const bearing = mapBearing();
      const btn = $('#compass-btn');
      btn.classList.toggle('hidden', Math.abs(bearing) < 0.5 || Math.abs(bearing - 360) < 0.5);
      btn.querySelector('svg').style.transform = `rotate(${-bearing - 45}deg)`;
    });
    map.on('click', e => {
      // Сначала модуль реестра (режимы рисования/назначения), иначе — адрес под пальцем
      for (const handler of App.mapClickHandlers) { if (handler(e)) return; }
      showAddressAt(e.latlng.lat, e.latlng.lng);
    });
    renderContextLayers();
  }
  App.mapClickHandlers = [];
  App.setBasemap = setBasemap;

  function renderContextLayers() {
    renderHouseNumbers();
    renderLandmarks();
  }

  function renderHouseNumbers() {
    houseLayer.clearLayers();
    if (!window.HOUSE_NUMBERS_DATA || map.getZoom() < HOUSE_NUM_MIN_ZOOM) return;
    const bounds = map.getBounds().pad(0.25);
    let rendered = 0;
    for (const row of window.HOUSE_NUMBERS_DATA) {
      if (rendered >= HOUSE_NUM_MAX_MARKERS) break;
      if (!bounds.contains([row[0], row[1]])) continue;
      L.marker([row[0], row[1]], {
        icon: L.divIcon({ className: 'ctx-icon', html: `<span class="house-num">${esc(row[2])}</span>`, iconSize: null }),
        interactive: false, keyboard: false
      }).addTo(houseLayer);
      rendered++;
    }
  }

  function renderLandmarks() {
    landmarkLayer.clearLayers();
    if (!window.LANDMARKS_DATA || map.getZoom() < LANDMARK_MIN_ZOOM) return;
    const bounds = map.getBounds().pad(0.3);
    for (const row of window.LANDMARKS_DATA) {
      if (!bounds.contains([row[0], row[1]])) continue;
      const name = App.lang === 'kk' ? row[3] : row[2];
      L.marker([row[0], row[1]], {
        icon: L.divIcon({
          className: 'ctx-icon',
          html: `<span class="landmark"><i style="background:${LANDMARK_COLORS[row[4]] || LANDMARK_COLORS.mall}"></i>${esc(name)}</span>`,
          iconSize: null
        }),
        interactive: false, keyboard: false
      }).addTo(landmarkLayer);
    }
  }

  // ===== Пины поиска / маршрута =====
  function simplePin(color) {
    return L.divIcon({
      className: 'pin-wrap',
      html: `<div class="pin" style="--c:${color}"><svg viewBox="0 0 30 40" width="28" height="38"><path d="M15 1.5C7.5 1.5 1.5 7.4 1.5 14.8 1.5 24.9 15 38.5 15 38.5S28.5 24.9 28.5 14.8C28.5 7.4 22.5 1.5 15 1.5z" fill="var(--c)" stroke="#fff" stroke-width="2"/><circle cx="15" cy="15" r="5" fill="#fff"/></svg></div>`,
      iconSize: [28, 38], iconAnchor: [14, 38], popupAnchor: [0, -34]
    });
  }
  App.simplePin = simplePin;

  let searchMarker = null;
  function clearSearchMarker() {
    if (searchMarker) { map.removeLayer(searchMarker); searchMarker = null; }
  }

  function popupHtml(lat, lng, label) {
    const near = App.registry && App.registry.nearest(lat, lng, 70);
    return `
      <div class="popup-title">${esc(label)}</div>
      <div class="popup-coords">${lat.toFixed(6)}, ${lng.toFixed(6)}</div>
      <div class="popup-actions">
        <button type="button" class="btn btn-primary btn-sm" data-act="route">${App.ic('route')}${esc(App.t('route_here'))}</button>
        ${near ? `<button type="button" class="btn btn-secondary btn-sm" data-act="card" data-id="${esc(near.id)}">${App.ic('info')}${esc(App.t('open_card'))}</button>` : ''}
        <button type="button" class="btn btn-ghost btn-sm" data-act="copy">${App.ic('copy')}${esc(App.t('copy_coords'))}</button>
      </div>`;
  }

  function showPinAt(lat, lng, label, zoom) {
    clearSearchMarker();
    if (zoom) map.setView([lat, lng], zoom);
    searchMarker = L.marker([lat, lng], { icon: simplePin('#5C98D1') }).addTo(map);
    searchMarker.bindPopup(popupHtml(lat, lng, label), { className: 'dark-popup', maxWidth: 300 }).openPopup();
    const marker = searchMarker;
    marker.on('popupopen', e => bindPopupActions(e.popup, lat, lng, label));
    bindPopupActions(marker.getPopup(), lat, lng, label);
    marker.on('popupclose', () => { if (searchMarker === marker) clearSearchMarker(); });
  }

  function bindPopupActions(popup, lat, lng, label) {
    const el = popup.getElement();
    if (!el) return;
    el.querySelectorAll('[data-act]').forEach(btn => {
      btn.onclick = () => {
        const act = btn.dataset.act;
        if (act === 'route') openRoutePanelTo(lat, lng, label);
        if (act === 'card') { map.closePopup(); App.registry.select(btn.dataset.id); }
        if (act === 'copy') copyText(`${lat.toFixed(6)}, ${lng.toFixed(6)}`, App.t('coords_copied'));
      };
    });
  }

  async function showAddressAt(lat, lng) {
    const near = findNearestHouse(lat, lng, 35);
    if (near) { showPinAt(lat, lng, near.label); return; }
    showPinAt(lat, lng, App.t('address_detecting'));
    const address = await reverseGeocode(lat, lng);
    if (searchMarker) {
      const latlng = searchMarker.getLatLng();
      if (latlng.lat === lat && latlng.lng === lng) showPinAt(lat, lng, address || App.t('address_unknown'));
    }
  }

  function copyText(text, okMsg) {
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast(okMsg || App.t('copied')); } catch (e) { toast(text); }
      ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast(okMsg || App.t('copied')), fallback);
    } else fallback();
  }

  Object.assign(App, { showPinAt, clearSearchMarker, copyText });

  // ===== Поиск: объекты реестра, дома, ТЦ, координаты, Nominatim =====
  let SEARCH_INDEX = [];
  const LANDMARK_KINDS = { mall: 'kind_mall', health: 'kind_health', edu: 'kind_edu', park: 'kind_park', culture: 'kind_culture' };

  function normalizeSearch(s) {
    // Сглаживаем частые опечатки: а/о, е/и/ы/й, у/ю, удвоенные буквы, мягкий знак.
    // «/» оставляем — это номер корпуса (23/1).
    return String(s || '').toLowerCase()
      .replace(/ё/g, 'е').replace(/[ао]/g, 'а').replace(/[еиыйі]/g, 'и').replace(/[юү]/g, 'у').replace(/[ьъ]/g, '')
      .replace(/\\/g, '/').replace(/(.)\1+/g, '$1')
      .replace(/[^a-zа-яәғқңөұүһі0-9/\s]/g, ' ').replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();
  }
  App.normalizeSearch = normalizeSearch;

  function buildSearchIndex() {
    SEARCH_INDEX = [];
    (window.HOUSE_NUMBERS_DATA || []).forEach(row => {
      if (!row[3]) return;
      const label = `${row[3]}, ${row[2]}`;
      SEARCH_INDEX.push({ type: 'house', lat: row[0], lng: row[1], label, norm: normalizeSearch(label) });
    });
    (window.LANDMARKS_DATA || []).forEach(row => {
      SEARCH_INDEX.push({ type: 'landmark', lat: row[0], lng: row[1], label: row[2], labelKk: row[3], cat: row[4], norm: normalizeSearch(row[2]), normKk: normalizeSearch(row[3]) });
    });
  }

  function searchLocal(query, limit) {
    const terms = normalizeSearch(query).split(' ').filter(Boolean);
    if (!terms.length) return [];
    const scored = [];
    for (const item of SEARCH_INDEX) {
      const norm = item.normKk && item.normKk.includes(terms[0]) ? item.normKk : item.norm;
      if (!terms.every(term => norm.includes(term))) continue;
      let score = norm.startsWith(terms[0]) ? 0 : 1;
      if (item.type === 'landmark') score -= 0.5;
      scored.push({ item, score: score + norm.length * 0.001 });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, limit || 8).map(s => s.item);
  }

  function findNearestHouse(lat, lng, maxMeters) {
    let best = null, bestDist = Infinity;
    for (const item of SEARCH_INDEX) {
      if (item.type !== 'house') continue;
      if (Math.abs(item.lat - lat) > 0.002 || Math.abs(item.lng - lng) > 0.003) continue;
      const d = haversine(lat, lng, item.lat, item.lng);
      if (d < bestDist) { bestDist = d; best = item; }
    }
    return best && bestDist <= maxMeters ? best : null;
  }
  App.findNearestHouse = findNearestHouse;

  function parseCoords(q) {
    const m = q.trim().match(/^(-?\d{1,3}(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:[.,]\d+)?)$/);
    if (!m) return null;
    let a = parseFloat(m[1].replace(',', '.')), b = parseFloat(m[2].replace(',', '.'));
    if (Math.abs(a) > 60 && Math.abs(b) <= 60) [a, b] = [b, a]; // «долгота, широта» → меняем местами
    if (Math.abs(a) > 90 || Math.abs(b) > 180) return null;
    return { lat: a, lng: b };
  }

  // Nominatim — публичный сервис с лимитом 1 запрос/сек: только по Enter, с кэшем.
  const geocodeCache = new Map();
  let lastGeocodeAt = 0;
  async function geocode(query) {
    const key = query.toLowerCase().trim();
    if (geocodeCache.has(key)) return geocodeCache.get(key);
    const wait = 1100 - (Date.now() - lastGeocodeAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastGeocodeAt = Date.now();
    const q = /темиртау|temirtau/i.test(query) ? query : `${query}, Темиртау`;
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&countrycodes=kz&viewbox=72.75,50.20,73.20,49.90&bounded=1&limit=5`;
    const res = await fetch(url, { headers: { 'Accept-Language': App.lang === 'en' ? 'en' : 'ru' } });
    if (!res.ok) throw new Error('geocode ' + res.status);
    const data = (await res.json()).map(d => ({ lat: parseFloat(d.lat), lng: parseFloat(d.lon), label: d.display_name }));
    geocodeCache.set(key, data);
    return data;
  }

  const reverseCache = new Map();
  async function reverseGeocode(lat, lng) {
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (reverseCache.has(key)) return reverseCache.get(key);
    try {
      const wait = 1100 - (Date.now() - lastGeocodeAt);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      lastGeocodeAt = Date.now();
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18`, { headers: { 'Accept-Language': App.lang === 'en' ? 'en' : 'ru' } });
      if (!res.ok) return null;
      const name = (await res.json()).display_name || null;
      reverseCache.set(key, name);
      return name;
    } catch (err) { return null; }
  }

  let suggestions = [];
  let suggestIndex = -1;

  // Недавние запросы — показываются, когда строка поиска пустая
  function rememberSearch(entry) {
    const list = store.get('recent', []).filter(r => r.label !== entry.label);
    list.unshift(entry);
    store.set('recent', list.slice(0, 6));
  }

  function collectSuggestions(query) {
    const q = query.trim();
    if (!q) return store.get('recent', []).map(r => ({ ...r, recent: true, sub: App.t('recent') }));
    if (q.length < 2) return [];
    const out = [];
    if (App.registry) App.registry.search(q, 5).forEach(g => out.push({ type: 'object', id: g.id, label: g.title, sub: g.sub, color: g.color }));
    searchLocal(q, 6).forEach(r => {
      if (r.type === 'landmark') out.push({ type: 'landmark', lat: r.lat, lng: r.lng, label: App.lang === 'kk' ? r.labelKk : r.label, sub: App.t(LANDMARK_KINDS[r.cat] || 'kind_place') });
      else out.push({ type: 'house', lat: r.lat, lng: r.lng, label: r.label, sub: App.t('kind_house') });
    });
    return out.slice(0, 9);
  }

  function renderSuggestions(query) {
    const box = $('#search-suggest');
    suggestions = collectSuggestions(query);
    suggestIndex = -1;
    if (!suggestions.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    // Подсветка совпавшей части названия
    const first = query.trim().split(/\s+/)[0] || '';
    const mark = label => {
      const i = first.length >= 2 ? label.toLowerCase().indexOf(first.toLowerCase()) : -1;
      return i < 0 ? esc(label) : `${esc(label.slice(0, i))}<mark>${esc(label.slice(i, i + first.length))}</mark>${esc(label.slice(i + first.length))}`;
    };
    box.innerHTML = suggestions.map((s, i) => `
      <button type="button" class="suggest-item" data-i="${i}" role="option">
        <span class="suggest-ic" ${s.color ? `style="color:${s.color}"` : ''}>${App.ic(s.recent ? 'history' : s.type === 'object' ? 'pin' : s.type === 'house' ? 'grid' : 'tag')}</span>
        <span class="suggest-label">${mark(s.label)}</span>
        <span class="suggest-sub">${esc(s.sub || '')}</span>
      </button>`).join('');
    box.classList.remove('hidden');
    box.querySelectorAll('.suggest-item').forEach(el => el.addEventListener('mousedown', e => {
      e.preventDefault();
      chooseSuggestion(suggestions[+el.dataset.i]);
    }));
  }

  function hideSuggestions() {
    const box = $('#search-suggest');
    box.classList.add('hidden');
    box.innerHTML = '';
    suggestions = [];
  }

  function chooseSuggestion(s) {
    hideSuggestions();
    $('#search-input').blur();
    const { recent, sub, ...entry } = s;
    rememberSearch({ ...entry, sub: undefined });
    if (s.type === 'object') { App.registry.select(s.id); return; }
    $('#search-input').value = s.label;
    showPinAt(s.lat, s.lng, s.label, s.type === 'house' ? 18 : 17);
  }

  async function runSearch() {
    const input = $('#search-input');
    const q = input.value.trim();
    hideSuggestions();
    if (!q) { App.registry.openCatalog(); return; }
    const coords = parseCoords(q);
    if (coords) { showPinAt(coords.lat, coords.lng, `${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}`, 17); return; }
    const objects = App.registry.search(q, 50);
    const here = objects.filter(o => o.section === App.registry.section());
    if (here.length === 1 || (!here.length && objects.length)) { input.blur(); chooseSuggestion({ type: 'object', id: (here[0] || objects[0]).id, label: (here[0] || objects[0]).title }); return; }
    if (here.length > 1) { input.blur(); App.registry.openCatalog(q); return; }
    const local = searchLocal(q, 1);
    if (local.length) { chooseSuggestion({ ...local[0], label: local[0].type === 'landmark' && App.lang === 'kk' ? local[0].labelKk : local[0].label }); return; }
    setSearchBusy(true);
    try {
      const results = await geocode(q);
      if (!results.length) { toast(App.t('search_not_found')); return; }
      showPinAt(results[0].lat, results[0].lng, results[0].label, 17);
    } catch (err) {
      toast(App.t('search_error'), { error: true });
    } finally {
      setSearchBusy(false);
    }
  }

  function setSearchBusy(busy) {
    $('#search-wrap').classList.toggle('busy', busy);
  }

  function bindSearch() {
    const input = $('#search-input');
    const update = debounce(() => renderSuggestions(input.value), 120);
    input.addEventListener('input', () => {
      $('#search-clear').classList.toggle('hidden', !input.value);
      update();
    });
    input.addEventListener('focus', () => renderSuggestions(input.value)); // пустая строка — недавние запросы
    input.addEventListener('blur', () => setTimeout(hideSuggestions, 150));
    input.addEventListener('keydown', e => {
      const items = $$('#search-suggest .suggest-item');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!items.length) return;
        e.preventDefault();
        suggestIndex = (suggestIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items.forEach((el, i) => el.classList.toggle('active', i === suggestIndex));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (suggestIndex >= 0 && suggestions[suggestIndex]) chooseSuggestion(suggestions[suggestIndex]);
        else runSearch();
      } else if (e.key === 'Escape') {
        hideSuggestions();
        input.blur();
      }
    });
    $('#search-btn').addEventListener('click', runSearch);
    $('#search-clear').addEventListener('click', () => {
      input.value = '';
      $('#search-clear').classList.add('hidden');
      hideSuggestions();
      clearSearchMarker();
      input.focus();
    });
  }

  // ===== Маршрут (ORS → запасной OSRM) =====
  // Ключ openrouteservice виден в браузере — это осознанный компромисс
  // (бесплатный лимит 2000 запросов/день). Если станет проблемой — нужен прокси.
  const ORS_API_KEY = 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6ImFmZTRhZTEwNDY3MzRiMzZhMWE4ODBhMGNlMGM3YzY0IiwiaCI6Im11cm11cjY0In0=';
  const ORS_PROFILE = { driving: 'driving-car', foot: 'foot-walking' };
  const route = { layer: null, from: null, to: null, fromMarker: null, toMarker: null, profile: 'driving' };

  function clearRouteLine() {
    if (route.layer) { map.removeLayer(route.layer); route.layer = null; }
    $('#route-info').classList.add('hidden');
  }
  function clearRoute() {
    clearRouteLine();
    if (route.fromMarker) { map.removeLayer(route.fromMarker); route.fromMarker = null; }
    if (route.toMarker) { map.removeLayer(route.toMarker); route.toMarker = null; }
    route.from = route.to = null;
  }

  function showRouteResult(geometry, meters, seconds, label) {
    clearRouteLine();
    route.layer = L.geoJSON(geometry, { style: { color: '#5C98D1', weight: 6, opacity: 0.9 } }).addTo(map);
    // Route rendering never changes center, zoom or bearing.
    $('#route-info-text').textContent = `${label ? label + ' — ' : ''}${(meters / 1000).toFixed(1)} ${App.t('km')} · ${Math.max(1, Math.round(seconds / 60))} ${App.t('min')}`;
    $('#route-info').classList.remove('hidden');
  }

  async function buildRoute(from, to, label) {
    toast(route.profile === 'foot' ? App.t('route_building_foot') : App.t('route_building'));
    try {
      const res = await fetch(`https://api.openrouteservice.org/v2/directions/${ORS_PROFILE[route.profile]}?api_key=${ORS_API_KEY}&start=${from.lng},${from.lat}&end=${to.lng},${to.lat}`);
      if (res.ok) {
        const data = await res.json();
        const f = data.features && data.features[0];
        const seg = f && f.properties && f.properties.segments && f.properties.segments[0];
        if (f && seg) { showRouteResult(f.geometry, seg.distance, seg.duration, label); return; }
      }
    } catch (err) { /* уходим на запасной OSRM */ }
    try {
      const res = await fetch(`https://router.project-osrm.org/route/v1/${route.profile}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`);
      if (!res.ok) throw new Error('routing ' + res.status);
      const data = await res.json();
      if (!data.routes || !data.routes.length) { toast(App.t('route_not_found')); return; }
      showRouteResult(data.routes[0].geometry, data.routes[0].distance, data.routes[0].duration, label);
    } catch (err) {
      toast(App.t('route_error'), { error: true });
    }
  }

  async function resolvePlace(text) {
    const q = (text || '').trim();
    if (!q) return null;
    const c = parseCoords(q);
    if (c) return { ...c, label: q };
    const local = searchLocal(q, 1);
    if (local.length) return { lat: local[0].lat, lng: local[0].lng, label: local[0].label };
    const objects = App.registry.search(q, 1);
    if (objects.length) return { lat: objects[0].center.lat, lng: objects[0].center.lng, label: objects[0].title };
    try {
      const r = await geocode(q);
      if (r.length) return r[0];
    } catch (err) { /* ниже вернём null */ }
    return null;
  }

  function setRouteMarker(which, place) {
    const key = which === 'from' ? 'fromMarker' : 'toMarker';
    if (route[key]) map.removeLayer(route[key]);
    route[key] = L.marker([place.lat, place.lng], { icon: simplePin(which === 'from' ? '#55AE76' : '#E0675F') }).addTo(map);
  }

  function openRoutePanelTo(lat, lng, label) {
    map.closePopup();
    route.to = { lat, lng, label };
    setRouteMarker('to', route.to);
    $('#route-panel').classList.remove('hidden');
    $('#route-to').value = label;
    if (!$('#route-from').value) $('#route-from').focus({ preventScroll: true });
  }
  App.openRouteTo = openRoutePanelTo;

  function closeRoutePanel() {
    $('#route-panel').classList.add('hidden');
    if ($('#route-info').classList.contains('hidden')) clearRoute();
  }

  async function routeFromMyLocation() {
    toast(App.t('locating'));
    try {
      const pos = await currentPosition();
      route.from = { lat: pos.latitude, lng: pos.longitude, label: App.t('my_location') };
      $('#route-from').value = route.from.label;
      setRouteMarker('from', route.from);
    } catch (err) {
      toast(App.t('locate_failed'), { error: true });
    }
  }

  async function routeBuildClick(event) {
    if (event) event.preventDefault();
    if ($('#route-build').disabled) return;
    $('#route-build').disabled = true;
    try {
      const fromText = $('#route-from').value, toText = $('#route-to').value;
      if (!fromText.trim() || !toText.trim()) { toast(App.t('route_fill_both')); return; }
      const from = route.from && route.from.label === fromText ? route.from : await resolvePlace(fromText);
      const to = route.to && route.to.label === toText ? route.to : await resolvePlace(toText);
      if (!from) { toast(App.t('route_from_not_found')); return; }
      if (!to) { toast(App.t('route_to_not_found')); return; }
      route.from = from; route.to = to;
      setRouteMarker('from', from);
      setRouteMarker('to', to);
      await buildRoute(from, to, to.label);
    } catch (err) {
      toast(App.t('route_error'), { error: true });
    } finally { $('#route-build').disabled = false; }
  }

  function bindRoute() {
    $('#route-btn').addEventListener('click', () => {
      const panel = $('#route-panel');
      if (panel.classList.contains('hidden')) { panel.classList.remove('hidden'); $('#route-from').focus({ preventScroll: true }); } else closeRoutePanel();
    });
    $('#route-close').addEventListener('click', closeRoutePanel);
    $('#route-info-close').addEventListener('click', clearRoute);
    $('#route-geo').addEventListener('click', routeFromMyLocation);
    $('#route-build').addEventListener('click', routeBuildClick);
    $$('.route-profile').forEach(btn => btn.addEventListener('click', () => {
      route.profile = btn.dataset.profile;
      $$('.route-profile').forEach(b => b.classList.toggle('active', b === btn));
    }));
  }

  // ===== Геолокация с направлением (компас) =====
  const geo = { watchId: null, marker: null, circle: null, centered: false, heading: null, smooth: null, compass: false, handler: null, interacting: false, timer: null };

  function currentPosition() {
    return new Promise((resolve, reject) => {
      if (geo.watchId !== null && geo.marker) {
        const ll = geo.marker.getLatLng();
        resolve({ latitude: ll.lat, longitude: ll.lng });
        return;
      }
      if (!navigator.geolocation) { reject(new Error('unsupported')); return; }
      navigator.geolocation.getCurrentPosition(p => resolve(p.coords), reject, { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 });
    });
  }

  const normDeg = d => ((d % 360) + 360) % 360;
  const mapBearing = () => (map && typeof map.getBearing === 'function') ? (map.getBearing() || 0) : 0;

  function onMapGestureActivity() {
    // Пока карту крутят/двигают, конус «замирает», потом досчитывается
    geo.interacting = true;
    clearTimeout(geo.timer);
    geo.timer = setTimeout(() => { geo.interacting = false; renderUserHeading(); }, 180);
  }

  function coneEl() {
    const el = geo.marker && geo.marker.getElement();
    return el && el.querySelector('.loc-cone');
  }

  function renderUserHeadingLive() {
    const cone = coneEl();
    if (!cone || geo.heading == null) return;
    cone.style.display = 'block';
    geo.smooth = normDeg(geo.heading - mapBearing());
    cone.style.transform = `translate(-50%, -100%) rotate(${geo.smooth.toFixed(1)}deg)`;
  }

  function renderUserHeading() {
    const cone = coneEl();
    if (!cone || geo.heading == null) return;
    cone.style.display = 'block';
    const target = normDeg(geo.heading - mapBearing());
    if (geo.smooth === null) geo.smooth = target;
    else geo.smooth = normDeg(geo.smooth + (((target - geo.smooth + 540) % 360) - 180) * 0.25);
    cone.style.transform = `translate(-50%, -100%) rotate(${geo.smooth.toFixed(1)}deg)`;
  }

  function setHeading(deg) {
    if (!geo.marker) return;
    geo.heading = deg;
    if (!geo.interacting) renderUserHeading();
  }

  function bindCompass() {
    if (geo.handler) return;
    geo.handler = e => {
      let h = null;
      if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) h = e.webkitCompassHeading; // iOS
      else if (typeof e.alpha === 'number' && !isNaN(e.alpha)) h = 360 - e.alpha; // Android
      if (h != null) { geo.compass = true; setHeading(normDeg(h)); }
    };
    const attach = () => window.addEventListener('ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation', geo.handler);
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission().then(s => { if (s === 'granted') attach(); }).catch(() => { });
    } else attach();
  }

  function unbindCompass() {
    if (!geo.handler) return;
    window.removeEventListener('deviceorientationabsolute', geo.handler);
    window.removeEventListener('deviceorientation', geo.handler);
    geo.handler = null;
    geo.compass = false;
  }

  function geoErrorText(err) {
    if (!err) return '';
    if (err.code === 1) return App.t('geo_denied');
    if (err.code === 2) return App.t('geo_unavailable');
    if (err.code === 3) return App.t('geo_timeout');
    return '';
  }

  function stopTracking(silent) {
    if (geo.watchId !== null) navigator.geolocation.clearWatch(geo.watchId);
    geo.watchId = null;
    unbindCompass();
    geo.heading = geo.smooth = null;
    if (geo.circle) { map.removeLayer(geo.circle); geo.circle = null; }
    if (geo.marker) { map.removeLayer(geo.marker); geo.marker = null; }
    $('#locate-btn').classList.remove('active', 'busy');
    store.set('tracking', false);
    if (!silent) toast(App.t('tracking_off'));
  }

  function toggleTracking() {
    if (!navigator.geolocation) { toast(App.t('geo_unsupported')); return; }
    if (geo.watchId !== null) {
      // Повторное нажатие: если точка далеко за экраном — сначала вернуть к ней
      if (geo.marker && !map.getBounds().contains(geo.marker.getLatLng())) { map.setView(geo.marker.getLatLng(), Math.max(map.getZoom(), 17)); return; }
      stopTracking();
      return;
    }
    const btn = $('#locate-btn');
    btn.classList.add('busy');
    geo.centered = false;
    store.set('tracking', true);
    bindCompass();
    geo.watchId = navigator.geolocation.watchPosition(pos => {
      btn.classList.remove('busy');
      btn.classList.add('active');
      const { latitude, longitude, accuracy, heading, speed } = pos.coords;
      if (geo.marker) geo.marker.setLatLng([latitude, longitude]);
      else {
        geo.marker = L.marker([latitude, longitude], {
          icon: L.divIcon({ className: 'loc-wrap', iconSize: [46, 46], iconAnchor: [23, 23], html: '<div class="loc"><div class="loc-cone" style="display:none"></div><div class="loc-pulse"></div><div class="loc-dot"></div></div>' }),
          zIndexOffset: 1000, interactive: false
        }).addTo(map);
      }
      if (geo.circle) { geo.circle.setLatLng([latitude, longitude]); geo.circle.setRadius(accuracy || 0); }
      else geo.circle = L.circle([latitude, longitude], { radius: accuracy || 0, color: '#5C98D1', weight: 1, fillColor: '#5C98D1', fillOpacity: 0.12, interactive: false }).addTo(map);
      // Без компаса — берём курс движения GPS (валиден только в движении)
      if (!geo.compass && typeof heading === 'number' && !isNaN(heading) && (speed == null || speed > 0.3)) setHeading(normDeg(heading));
      if (!geo.centered) { map.setView([latitude, longitude], 18); geo.centered = true; }
    }, err => {
      stopTracking(true);
      toast(`${App.t('locate_failed')} ${geoErrorText(err)}`.trim(), { error: true });
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
  }

  // ===== Привязка общих кнопок =====
  function bindUI() {
    bindSearch();
    bindRoute();
    setupSheetDrag();
    $('#menu-btn').addEventListener('click', openDrawer);
    $('#drawer-close').addEventListener('click', closeDrawer);
    $('#sheet-close').addEventListener('click', () => closeSheet());
    $('#backdrop').addEventListener('click', () => {
      if ($('#drawer').classList.contains('open')) closeDrawer(); else closeSheet();
    });
    $('#locate-btn').addEventListener('click', toggleTracking);
    $('#zoom-in').addEventListener('click', () => map.zoomIn());
    $('#zoom-out').addEventListener('click', () => map.zoomOut());
    $('#compass-btn').addEventListener('click', () => { if (map.setBearing) map.setBearing(0); });

    const layersBtn = $('#layers-btn'), layersPop = $('#layers-pop');
    layersBtn.addEventListener('click', e => { e.stopPropagation(); layersPop.classList.toggle('hidden'); });
    document.addEventListener('click', e => { if (!layersPop.contains(e.target) && e.target !== layersBtn) layersPop.classList.add('hidden'); });
    $$('[data-basemap]').forEach(btn => btn.addEventListener('click', () => { setBasemap(btn.dataset.basemap); layersPop.classList.add('hidden'); }));
    $$('[data-lang]').forEach(btn => btn.addEventListener('click', () => App.setLang(btn.dataset.lang)));

    $('#data-warning-close').addEventListener('click', () => $('#data-warning').classList.add('hidden'));
    on('lang', renderContextLayers); // названия ТЦ на казахском/русском

    document.addEventListener('keydown', e => {
      if (dialogOpen) return;
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName);
      if (e.key === '/' && !typing) { e.preventDefault(); $('#search-input').focus(); return; }
      if (e.key !== 'Escape') return;
      if (App.registry && App.registry.cancelTool()) return;
      if ($('#drawer').classList.contains('open')) { closeDrawer(); return; }
      if (isSheetOpen()) { closeSheet(); return; }
      if (!$('#route-panel').classList.contains('hidden')) { closeRoutePanel(); return; }
      if (App.registry) App.registry.closeCard();
    });
  }

  function hideLoading() {
    const el = $('#loading');
    el.classList.add('hide');
    setTimeout(() => { el.style.display = 'none'; }, 400);
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW:', err)));
  }

  function boot() {
    migrateOldSettings();
    App.injectIconSprite();
    App.hydrateIcons();
    App.initLang(store.get('lang', 'ru'));
    initFirebase();
    initMap();
    buildSearchIndex();
    bindUI();
    initAuth();
    emit('ready');
    if (store.get('tracking', false)) toggleTracking();
    hideLoading();
    if (!App.fb.ok) toast(App.t('db_offline'), { error: true, duration: 6000 });
    registerServiceWorker();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

