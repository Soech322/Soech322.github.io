/* Реестр объектов: ГИС-контроль и ремонтно-восстановительные работы (РВР).

   Исходные объекты загружены из KML (gis-control-data.js / repair-works-data.js).
   Все правки хранятся отдельно, в Firestore-коллекциях *_overrides, поэтому
   повторная выгрузка KML их не уничтожит.

   Площадка (иконка) и её кадастровая зона объединяются в один «объект»:
   точка внутри полигона (или с тем же кадастровым номером) — одно целое,
   у них общая карточка, общий цвет, общий ответственный.

   Защита описаний: пустое описание или «шаблон без значений» из импорт-тула
   никогда не перекрывает исходное описание из KML (см. isBrokenDescription),
   а каждое изменение пишется в журнал audit_log — его можно откатить. */
(function () {
  'use strict';
  const App = window.App;
  const { $, $$, esc, plainText, store, haversine } = App;
  const t = (...a) => App.t(...a);
  const ic = (...a) => App.ic(...a);
  const DELETE = { __delete: true }; // маркер «удалить поле» для saveOverride

  // ===== Разделы =====
  const SECTIONS = {
    gis: {
      key: 'gis',
      collection: 'gis_control_overrides',
      data: Array.isArray(window.GIS_CONTROL_DATA) ? window.GIS_CONTROL_DATA : null,
      dataFile: 'gis-control-data.js',
      color: '#2A9D8F',
      pointFolder: 'Детские площадки',
      zoneFolder: 'Кадастровые границы',
      sectorFolders: ['Административные сектора', 'Temirtau_Sektora.kml'],
      categories: ['Детские площадки', 'Кадастровые границы', 'Административные сектора', 'Без категории']
    },
    repair: {
      key: 'repair',
      collection: 'repair_works_overrides',
      data: Array.isArray(window.REPAIR_WORKS_DATA) ? window.REPAIR_WORKS_DATA : null,
      dataFile: 'repair-works-data.js',
      color: '#8A76CF',
      pointFolder: 'Площадки для РВР',
      zoneFolder: 'Кадастровые Зоны',
      sectorFolders: ['Temirtau_Sektora.kml', 'Административные сектора'],
      categories: ['Площадки для РВР', 'Кадастровые Зоны', 'Temirtau_Sektora.kml', 'Без категории']
    }
  };

  // Виды работ РВР. Какие работы есть у площадки — берётся из Google-таблицы
  // (sheet-sync.js), статус хранится в базе: true — выполнено, false — нет.
  // Старые типы из прежнего импорта (mow, rvr, tennis_board…) не показываем.
  const TASKS = {
    paint: { label: 'task_paint', icon: 'paint', done: 'status_done', pending: 'status_pending' },
    sand: { label: 'task_sand', icon: 'sand', done: 'status_done', pending: 'status_pending' },
    carousel: { label: 'task_carousel', icon: 'carousel', done: 'status_installed', pending: 'status_not_installed' }
  };

  // Спокойные, «приглушённые» цвета — хорошо читаются и на спутнике, и на тёмной карте
  const GRAY = '#6F7C83';
  const PENDING = '#D99A3E';
  const DONE = '#4FA872';
  const SELECT = '#FFFFFF';
  const TYPE_COLORS = { playground: '#2A9D8F', square: '#5FA83A', zone: '#7F8F99', rvr: '#8A76CF' };
  const PALETTE = ['#D9534F', '#3D7FD9', '#D9A23D', '#2E9E78', '#9A5BD9', '#D95A9A', '#2BA3B8', '#86A83A',
    '#D9773D', '#6B6BD9', '#1F8F80', '#C2A22E', '#B65BC9', '#3A93C9', '#4FA368', '#C9406B'];
  // Цвета, которые админ может задать объекту вручную
  const OBJECT_COLORS = ['#2A9D8F', '#5FA83A', '#3D7FD9', '#8A76CF', '#D9A23D', '#D9773D', '#D9534F', '#D95A9A', '#2BA3B8', '#7F8F99'];
  // Скверы, парки и зоны отдыха — отдельный тип (зеленее), а не «детская площадка»
  const SQUARE_RE = /сквер|парк|аллея|бульвар|музе|дворц|площадь «/i;

  // ===== Состояние =====
  let active = store.get('section', 'gis');
  if (!SECTIONS[active]) active = 'gis';
  const overrides = { gis: new Map(), repair: new Map() };
  const loaded = { gis: false, repair: false };
  const cache = { gis: null, repair: null };
  const assignees = new Map();
  let selectedId = null;
  let tool = null; // активный инструмент: { type: 'assign' | 'pick' | 'draw' | 'move' | 'vertices', ... }

  const savedFilters = store.get('filters', {});
  const filters = {
    assignMode: !!savedFilters.assignMode,
    assigneeIds: new Set(savedFilters.assigneeIds || []),
    onlyAssigned: !!savedFilters.onlyAssigned,
    assigneeLabels: savedFilters.assigneeLabels !== false,
    addressLabels: !!savedFilters.addressLabels,
    tasks: new Set(savedFilters.tasks || []),
    taskStatus: savedFilters.taskStatus || 'pending',
    // Что показывать в ГИС: детские площадки / скверы и парки / прочие зоны
    kinds: new Set(savedFilters.kinds || ['playground', 'square', 'zone']),
    showSectors: savedFilters.showSectors !== false,
    hideImported: !!savedFilters.hideImported
  };
  function saveFilters() {
    store.set('filters', {
      assignMode: filters.assignMode, assigneeIds: [...filters.assigneeIds], onlyAssigned: filters.onlyAssigned,
      assigneeLabels: filters.assigneeLabels, addressLabels: filters.addressLabels, tasks: [...filters.tasks], taskStatus: filters.taskStatus,
      kinds: [...filters.kinds], showSectors: filters.showSectors, hideImported: filters.hideImported
    });
  }

  const isAdmin = () => App.auth.isAdmin;

  // ===== Геометрия =====
  function normalizeGeometry(geo) {
    if (typeof geo === 'string') { try { geo = JSON.parse(geo); } catch (e) { return null; } }
    if (!geo || !geo.type || !geo.coordinates) return null;
    if (geo.type === 'Point') {
      const c = geo.coordinates;
      if (!c || typeof c.lat !== 'number' || typeof c.lng !== 'number' || isNaN(c.lat) || isNaN(c.lng) || c.lat === 0) return null;
      return geo;
    }
    if ((geo.type === 'Polygon' || geo.type === 'MultiPolygon') && Array.isArray(geo.coordinates) && geo.coordinates.length) {
      const rings = geo.coordinates.filter(r => Array.isArray(r) && r.length >= 3);
      return rings.length ? { type: geo.type, coordinates: rings } : null;
    }
    return null;
  }

  // Polygon в данных — массив колец; MultiPolygon здесь — массив внешних колец частей
  const outerRings = geo => geo.type === 'Polygon' ? [geo.coordinates[0]] : geo.coordinates;

  function ringArea(ring) {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j].lng + ring[i].lng) * (ring[j].lat - ring[i].lat);
    return Math.abs(a / 2);
  }

  function ringCentroid(ring) {
    let a = 0, x = 0, y = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const f = ring[j].lng * ring[i].lat - ring[i].lng * ring[j].lat;
      a += f; x += (ring[j].lng + ring[i].lng) * f; y += (ring[j].lat + ring[i].lat) * f;
    }
    if (Math.abs(a) < 1e-14) {
      return { lat: ring.reduce((s, p) => s + p.lat, 0) / ring.length, lng: ring.reduce((s, p) => s + p.lng, 0) / ring.length };
    }
    return { lat: y / (3 * a), lng: x / (3 * a) };
  }

  function rayInRing(lat, lng, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i].lat, yi = ring[i].lng, xj = ring[j].lat, yj = ring[j].lng;
      if (((yi > lng) !== (yj > lng)) && (lat < (xj - xi) * (lng - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  const pointInGeometry = (lat, lng, geo) => geo.type !== 'Point' && outerRings(geo).some(r => rayInRing(lat, lng, r));

  function centerOf(geo) {
    if (geo.type === 'Point') return { lat: geo.coordinates.lat, lng: geo.coordinates.lng };
    const rings = outerRings(geo);
    const biggest = rings.reduce((best, r) => ringArea(r) > ringArea(best) ? r : best, rings[0]);
    const c = ringCentroid(biggest);
    if (rayInRing(c.lat, c.lng, biggest)) return c;
    // Вогнутый полигон: центр тяжести снаружи — берём середину отрезка между двумя вершинами внутри
    const mean = { lat: biggest.reduce((s, p) => s + p.lat, 0) / biggest.length, lng: biggest.reduce((s, p) => s + p.lng, 0) / biggest.length };
    return rayInRing(mean.lat, mean.lng, biggest) ? mean : { lat: biggest[0].lat, lng: biggest[0].lng };
  }

  function bboxOf(geo) {
    if (geo.type === 'Point') { const c = geo.coordinates; return [c.lat, c.lng, c.lat, c.lng]; }
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    outerRings(geo).forEach(r => r.forEach(p => { a = Math.min(a, p.lat); b = Math.min(b, p.lng); c = Math.max(c, p.lat); d = Math.max(d, p.lng); }));
    return [a, b, c, d];
  }
  const inBbox = (lat, lng, bb) => lat >= bb[0] && lat <= bb[2] && lng >= bb[1] && lng <= bb[3];

  function leafletLatLngs(geo) {
    if (geo.type === 'Polygon') return geo.coordinates.map(r => r.map(p => [p.lat, p.lng]));
    return geo.coordinates.map(r => [r.map(p => [p.lat, p.lng])]);
  }

  // ===== Тексты =====
  function cleanName(name) {
    let s = String(name || '').replace(/№№/g, '№').replace(/\bN\s*N\b/gi, '').trim();
    if (s.startsWith('—')) s = s.replace(/^—\s*/, '');
    return s || String(name || '');
  }

  function shortAddress(name) {
    return String(name || '')
      .replace(/^Площадка:\s*/i, '').replace(/^№\d+\s*[—-]\s*/, '')
      .replace(/в районе жил(ого|ых) дом(а|ов)/gi, '').replace(/в районе (дома|д\.?)/gi, '').replace(/жилого дома/gi, '')
      .replace(/\s{2,}/g, ' ').replace(/,\s*,/g, ',').replace(/^[,\s]+|[,\s]+$/g, '').trim();
  }

  // «Испорченное» описание: пустое или шаблон импорт-тула без значений
  // («Кадастровый номер:  Площадь:  кв.м Категория: »).
  function isBrokenDescription(value) {
    const s = plainText(value).replace(/\s+/g, ' ').trim();
    if (!s) return true;
    return /^(Кадастровый номер:\s*)?(Площадь:\s*(кв\.?\s*м)?\s*)?(Категория:\s*)?$/i.test(s);
  }

  const CADASTRE_RE = /\d{2}-\d{3}-\d{3}-\d{3}/g;
  const cadastreNumbers = text => String(text || '').match(CADASTRE_RE) || [];
  const normName = s => App.normalizeSearch(shortAddress(s));

  function areaFrom(text) {
    const m = plainText(text).match(/Площадь[^:\n]*:\s*([\d\s.,]+)\s*(?:кв\.?\s*м|м²)/i);
    return m ? m[1].trim().replace(/\s+/g, '') : '';
  }

  // ===== Построение модели раздела =====
  function makeFeature(sec, base, ch) {
    const S = SECTIONS[sec];
    const name = cleanName((ch.name != null ? ch.name : base.name) || '').trim();
    if (!name || /^(N\s*N|№\s*№|N|№)$/i.test(name)) return null;
    const geometry = normalizeGeometry(ch.geometry || base.geometry);
    if (!geometry) return null;
    const folder = ch.folder || base.folder || 'Без категории';
    const baseDescription = base.description || '';
    const descBroken = !ch.descriptionHidden && ch.description != null && isBrokenDescription(ch.description) && !(plainText(ch.description) === '' && !baseDescription);
    const description = ch.descriptionHidden === true ? '' : ch.description != null && !isBrokenDescription(ch.description) ? ch.description : baseDescription;
    const kind = S.sectorFolders.includes(folder) ? 'sector' : geometry.type === 'Point' ? 'point' : 'zone';
    return {
      id: base.id, section: sec, name, folder, kind, geometry,
      description, baseDescription, descBroken,
      overrideDescription: ch.description,
      descriptionHidden: ch.descriptionHidden === true,
      style: ch.style || base.style || {},
      photo1Url: ch.photo1Url || null,
      photo2Url: ch.photo2Url || null,
      tasks: ch.tasks && typeof ch.tasks === 'object' ? ch.tasks : null,
      assigneeId: ch.assigneeId || null,
      color: /^#[0-9a-f]{6}$/i.test(ch.color || '') ? ch.color : null,
      isNew: !!ch.isNew,
      // Копии площадок, которые импорт-тул РВР добавил в ГИС (id …_g)
      imported: !!ch.isNew && /_g$/.test(base.id),
      updatedAt: ch.updatedAt || null,
      updatedBy: ch.updatedBy || null,
      center: centerOf(geometry),
      bbox: bboxOf(geometry)
    };
  }

  function buildModel(sec) {
    const S = SECTIONS[sec];
    const ov = overrides[sec];
    const bases = (S.data || []).slice();
    const ids = new Set(bases.map(b => b.id));
    ov.forEach((ch, id) => {
      if (ch.isNew && !ids.has(id) && ch.geometry && ch.name) {
        bases.push({ id, name: ch.name, folder: ch.folder || 'Без категории', description: '', geometry: ch.geometry, style: ch.style || {} });
        ids.add(id);
      }
    });
    const features = [];
    bases.forEach(base => {
      const ch = ov.get(base.id) || {};
      if (ch.deleted) return;
      const f = makeFeature(sec, base, ch);
      if (f) features.push(f);
    });
    const byId = new Map(features.map(f => [f.id, f]));
    const result = { sec, features, byId, ...buildGroups(sec, features), sheet: null };
    if (sec === 'repair') applySheet(result);
    return result;
  }

  // Google-таблица = список УЖЕ ВЫПОЛНЕННЫХ адресов (самые свежие данные).
  // Адрес есть в таблице → работа выполнена (на сайте это не переключить).
  // Нет в таблице → «не выполнено», если работа назначена площадке в базе
  // (или статус, отмеченный админом на сайте).
  // Карусель есть у каждой площадки: в таблице — «установлена», иначе — «не установлена».
  // Если таблица недоступна — работаем по сохранённым в базе статусам.
  function applySheet(m) {
    const S = App.sheetSync;
    if (!S || !S.state.hasData) return;
    const points = m.groups.filter(g => g.point).map(g => ({ id: g.point.id, name: g.point.name }));
    const res = S.match(points);
    m.sheet = res;
    m.groups.forEach(g => {
      if (!g.point) return;
      const stored = g.point.tasks || {};
      const doneInSheet = res.byPoint.get(g.point.id) || new Set();
      const tasks = {};
      ['paint', 'sand'].forEach(k => {
        if (doneInSheet.has(k)) tasks[k] = true;
        else if (stored[k] !== undefined) tasks[k] = stored[k] === true;
      });
      tasks.carousel = doneInSheet.has('carousel') || stored.carousel === true;
      g.storedTasks = stored;
      g.tasks = tasks;
      g.sheetDone = doneInSheet;
    });
  }

  function buildGroups(sec, features) {
    const points = features.filter(f => f.kind === 'point');
    const zones = features.filter(f => f.kind === 'zone');
    const zoneByCad = new Map(), zoneByName = new Map();
    zones.forEach(z => {
      cadastreNumbers(z.description + ' ' + z.baseDescription).forEach(c => { if (!zoneByCad.has(c)) zoneByCad.set(c, []); zoneByCad.get(c).push(z); });
      const n = normName(z.name);
      if (n) { if (!zoneByName.has(n)) zoneByName.set(n, []); zoneByName.get(n).push(z); }
    });
    const near = (a, b) => haversine(a.center.lat, a.center.lng, b.center.lat, b.center.lng) < 400;

    const groups = [];
    const claimed = new Set();
    points.forEach(p => {
      const { lat, lng } = p.center;
      // 1) точка внутри зоны — берём самую маленькую из содержащих
      let matched = zones.filter(z => inBbox(lat, lng, z.bbox) && pointInGeometry(lat, lng, z.geometry));
      if (matched.length > 1) matched = [matched.reduce((a, b) => ((a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]) <= (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]) ? a : b))];
      // 2) тот же кадастровый номер поблизости (зона из нескольких частей — все части)
      if (!matched.length) {
        const set = new Set();
        cadastreNumbers(p.description + ' ' + p.baseDescription).forEach(c => (zoneByCad.get(c) || []).forEach(z => { if (near(p, z)) set.add(z); }));
        matched = [...set];
      }
      // 3) то же название поблизости
      if (!matched.length) matched = (zoneByName.get(normName(p.name)) || []).filter(z => near(p, z));
      // Части одной зоны с тем же кадастровым номером присоединяем тоже
      const extra = new Set(matched);
      matched.forEach(z => cadastreNumbers(z.baseDescription).forEach(c => (zoneByCad.get(c) || []).forEach(o => { if (near(p, o)) extra.add(o); })));
      matched = [...extra];
      groups.push({ point: p, zones: matched, primary: p });
      matched.forEach(z => claimed.add(z.id));
    });
    zones.forEach(z => { if (!claimed.has(z.id)) { groups.push({ point: null, zones: [z], primary: z }); claimed.add(z.id); } });

    const byId = new Map(), memberToGroup = new Map(), zoneOwner = new Map();
    groups.forEach(g => {
      g.id = g.primary.id;
      g.section = sec;
      g.members = [g.point, ...g.zones].filter(Boolean);
      g.memberIds = g.members.map(m => m.id);
      g.name = g.primary.name;
      g.zoneName = g.point && g.zones[0] && normName(g.zones[0].name) !== normName(g.point.name) ? g.zones[0].name : '';
      g.folder = g.primary.folder;
      g.center = g.point ? g.point.center : g.primary.center;
      const withAssignee = g.members.find(m => m.assigneeId);
      g.assigneeId = g.primary.assigneeId || (withAssignee ? withAssignee.assigneeId : null);
      g.tasks = (g.point && g.point.tasks) || null;
      g.storedTasks = g.tasks || {};
      g.color = g.primary.color || (g.members.find(m => m.color) || {}).color || null;
      g.imported = !!(g.point && g.point.imported);
      g.type = sec === 'repair' ? 'rvr'
        : g.point ? 'playground'
          : SQUARE_RE.test(g.name) ? 'square' : 'zone';
      g.photos = [];
      g.members.forEach(m => ['photo1Url', 'photo2Url'].forEach(field => { if (m[field]) g.photos.push({ featureId: m.id, field, url: m[field] }); }));
      const texts = [];
      g.members.forEach(m => { const txt = plainText(m.description); if (txt && !texts.some(x => x.text === txt)) texts.push({ id: m.id, kind: m.kind, text: txt }); });
      g.descriptions = texts;
      g.searchText = App.normalizeSearch([g.name, g.zoneName, g.folder, texts.map(x => x.text).join(' '), g.id].join(' '));
      g.area = areaFrom(texts.map(x => x.text).join('\n'));
      g.cadastre = [...new Set(cadastreNumbers(texts.map(x => x.text).join(' ')))];
      byId.set(g.id, g);
      g.memberIds.forEach(id => { if (!memberToGroup.has(id)) memberToGroup.set(id, g.id); });
      g.zones.forEach(z => { if (!zoneOwner.has(z.id)) zoneOwner.set(z.id, g.id); });
    });
    return { groups, groupById: byId, memberToGroup, zoneOwner, sectors: features.filter(f => f.kind === 'sector') };
  }

  function model(sec) {
    sec = sec || active;
    if (!cache[sec]) cache[sec] = buildModel(sec);
    return cache[sec];
  }
  function invalidate(sec) { cache[sec] = null; }

  function findGroup(id, sec) {
    const m = model(sec);
    if (m.groupById.has(id)) return m.groupById.get(id);
    const gid = m.memberToGroup.get(id);
    return gid ? m.groupById.get(gid) : null;
  }

  // ===== Ответственные =====
  const assigneeOf = g => (g && g.assigneeId && assignees.get(g.assigneeId)) || null;
  function freeColor(exceptId) {
    const used = new Set([...assignees.values()].filter(a => a.id !== exceptId).map(a => (a.color || '').toUpperCase()));
    const free = PALETTE.find(c => !used.has(c.toUpperCase()));
    if (free) return free;
    const hue = Math.floor(Math.random() * 360);
    return hslToHex(hue, 80, 60);
  }
  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))).toString(16).padStart(2, '0');
    return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
  }
  function formatPhone(raw) {
    const d = String(raw || '').replace(/\D/g, '');
    if (d.length === 11 && /^[78]/.test(d)) return `+7 ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7, 9)} ${d.slice(9)}`;
    if (d.length === 10) return `+7 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6, 8)} ${d.slice(8)}`;
    return String(raw || '').trim();
  }
  const telHref = phone => 'tel:' + String(phone || '').replace(/[^\d+]/g, '');
  function groupsOfPerson(id, sec) { return model(sec).groups.filter(g => g.assigneeId === id); }

  // ===== Сохранение правок =====
  function sanitizeForLog(obj) {
    const out = {};
    Object.entries(obj || {}).forEach(([k, v]) => {
      if (v === DELETE || v === undefined) out[k] = null;
      else if (k === 'geometry' && v && typeof v === 'object') out[k] = JSON.stringify(v);
      else out[k] = v;
    });
    return out;
  }

  function logAudit(entry) {
    if (!App.fb.ok) return;
    App.fb.db.collection('audit_log').add({
      ...entry,
      by: (App.auth.user && App.auth.user.email) || null,
      at: firebase.firestore.FieldValue.serverTimestamp(),
      atIso: new Date().toISOString()
    }).catch(err => console.warn('audit_log:', err));
  }

  // Записывает изменения полей объекта. Значение DELETE удаляет поле.
  // Локально применяется сразу (карта не ждёт сервера), при отказе базы — откатывается.
  function saveOverride(sec, id, change, meta = {}) {
    if (!App.fb.ok) { App.toast(t('db_offline'), { error: true }); return Promise.reject(new Error('offline')); }
    if (!isAdmin()) { App.toast(t('need_admin'), { error: true }); return Promise.reject(new Error('not admin')); }
    const ov = overrides[sec];
    const prev = ov.get(id);
    const cur = prev || {};
    if ('descriptionHidden' in change && !('description' in change)) change = { ...change, description: cur.description === undefined ? DELETE : cur.description };
    const before = {};
    Object.keys(change).forEach(k => { before[k] = cur[k] === undefined ? null : cur[k]; });
    const next = { ...cur };
    Object.entries(change).forEach(([k, v]) => { if (v === DELETE) delete next[k]; else next[k] = v; });
    ov.set(id, next);
    invalidate(sec);
    scheduleRefresh(sec);

    const payload = {};
    Object.entries(change).forEach(([k, v]) => {
      if (v === DELETE) payload[k] = firebase.firestore.FieldValue.delete();
      else if (k === 'geometry' && v) payload[k] = JSON.stringify(v); // Firestore не хранит вложенные массивы
      else payload[k] = v;
    });
    payload.updatedAt = new Date().toISOString();
    payload.updatedBy = (App.auth.user && App.auth.user.email) || null;
    // mergeFields: перечисленные поля заменяются целиком (важно для tasks),
    // остальные поля документа не трогаются
    const ref = App.fb.db.collection(SECTIONS[sec].collection).doc(id);
    return ref.set(payload, { mergeFields: Object.keys(payload) })
      .then(() => {
        logAudit({ section: sec, featureId: id, action: meta.action || 'update', before: sanitizeForLog(before), after: sanitizeForLog(change) });
      })
      .catch(err => {
        console.error(err);
        if (prev) ov.set(id, prev); else ov.delete(id);
        invalidate(sec);
        scheduleRefresh(sec);
        App.toast(err && err.code === 'permission-denied' ? t('save_denied') : t('save_failed'), { error: true });
        throw err;
      });
  }

  // Возврат значений «как было» — для кнопки «Отменить»
  function revertChange(sec, id, before, meta) {
    const change = {};
    Object.entries(before).forEach(([k, v]) => { change[k] = v === null || v === undefined ? DELETE : v; });
    return saveOverride(sec, id, change, { action: meta || 'undo' });
  }
  function currentValues(sec, id, keys) {
    const cur = overrides[sec].get(id) || {};
    const out = {};
    keys.forEach(k => { out[k] = cur[k] === undefined ? null : cur[k]; });
    return out;
  }

  // ===== Firestore: подписки =====
  function attachOverrides(sec) {
    const S = SECTIONS[sec];
    if (!App.fb.ok) { loaded[sec] = true; scheduleRefresh(sec); return; }
    App.fb.db.collection(S.collection).onSnapshot(snapshot => {
      const next = new Map();
      snapshot.forEach(doc => next.set(doc.id, doc.data() || {}));
      overrides[sec] = next;
      loaded[sec] = true;
      invalidate(sec);
      scheduleRefresh(sec);
      App.emit('data', sec);
    }, err => {
      console.warn(`Не удалось получить правки раздела ${sec}:`, err);
      loaded[sec] = true;
      scheduleRefresh(sec);
      App.toast(t('db_read_failed'), { error: true });
    });
  }

  function attachAssignees() {
    if (!App.fb.ok) return;
    App.fb.db.collection('assignees').onSnapshot(snapshot => {
      assignees.clear();
      snapshot.forEach(doc => assignees.set(doc.id, { id: doc.id, ...doc.data() }));
      invalidate('gis'); invalidate('repair');
      scheduleRefresh(active);
    }, err => console.warn('assignees:', err));
  }

  let refreshTimer = null;
  function scheduleRefresh(sec) {
    if (sec && sec !== active) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 30);
  }
  function refresh() {
    render();
    updateCounters();
    if (selectedId) {
      const g = findGroup(selectedId);
      if (g) { selectedId = g.id; showCard(g, { keepPosition: true }); } else closeCard();
    }
    App.emit('registry-refresh');
  }

  // ===== Отрисовка на карте =====
  let layers = null;
  const zoneLayers = new Map();   // featureId → L.Polygon
  const markers = new Map();      // groupId → L.Marker

  function setupLayers() {
    const map = App.map;
    // leaflet-rotate rotates overlayPane with tiles; default createPane parent does not.
    const geographicPane = map.getPane('overlayPane');
    map.createPane('sectorsPane', geographicPane).style.zIndex = 380;
    map.createPane('zonesPane', geographicPane).style.zIndex = 400;
    layers = {
      sectors: L.layerGroup().addTo(map),
      zones: L.layerGroup().addTo(map),
      points: L.layerGroup().addTo(map),
      draft: L.layerGroup().addTo(map)
    };
  }

  function pinIcon(color, opts = {}) {
    const glyph = opts.zoneOnly
      ? '<rect x="10" y="10" width="10" height="10" rx="2.5" fill="#fff"/>'
      : '<circle cx="15" cy="15" r="5.2" fill="#fff"/>';
    const label = opts.label ? `<div class="pin-label" style="--c:${color}">${opts.label}</div>` : '';
    return L.divIcon({
      className: 'pin-wrap',
      html: `<div class="pin${opts.selected ? ' pin-sel' : ''}${opts.dim ? ' pin-dim' : ''}" style="--c:${color}">${label}<svg viewBox="0 0 30 40" width="28" height="38"><path d="M15 1.5C7.5 1.5 1.5 7.4 1.5 14.8 1.5 24.9 15 38.5 15 38.5S28.5 24.9 28.5 14.8C28.5 7.4 22.5 1.5 15 1.5z" fill="var(--c)" stroke="#fff" stroke-width="2"/>${glyph}</svg></div>`,
      iconSize: [28, 38], iconAnchor: [14, 38], popupAnchor: [0, -34]
    });
  }

  function taskState(g) {
    const tasks = g.tasks || {};
    const keys = Object.keys(TASKS).filter(k => tasks[k] !== undefined);
    return { keys, pending: keys.filter(k => tasks[k] === false), done: keys.filter(k => tasks[k] === true) };
  }

  // Цвет/видимость/подпись объекта с учётом всех фильтров
  // Базовый цвет: заданный админом вручную, иначе — по типу объекта
  const baseColor = g => g.color || TYPE_COLORS[g.type] || SECTIONS[g.section].color;

  function visualFor(g) {
    const S = SECTIONS[g.section];
    let color = baseColor(g), visible = true, dim = false, label = '';
    const person = assigneeOf(g);
    const assignView = filters.assignMode || (tool && tool.type === 'assign');

    if (g.section === 'gis' && !filters.kinds.has(g.type)) visible = false;
    if (g.imported && filters.hideImported) visible = false;

    if (g.section === 'repair' && filters.tasks.size) {
      const st = taskState(g);
      const pendingSel = st.pending.filter(k => filters.tasks.has(k));
      const doneSel = st.done.filter(k => filters.tasks.has(k));
      if (filters.taskStatus === 'pending') visible = visible && pendingSel.length > 0;
      else if (filters.taskStatus === 'done') visible = visible && doneSel.length > 0 && !pendingSel.length;
      else visible = visible && pendingSel.length + doneSel.length > 0;
      color = pendingSel.length ? PENDING : DONE;
    }
    if (assignView) {
      if (person) {
        color = person.color || S.color;
        if (filters.assigneeLabels) label = `<b>${esc(person.name)}</b>${person.phone ? `<span>${esc(person.phone)}</span>` : ''}`;
      } else {
        color = GRAY;
        dim = true;
        if (filters.onlyAssigned && !(tool && tool.type === 'assign')) visible = false;
      }
      if (filters.assigneeIds.size && !(tool && tool.type === 'assign') && !(person && filters.assigneeIds.has(person.id))) visible = false;
    }
    if (!label && filters.addressLabels) label = `<b>${esc(shortAddress(App.localizeData(g.name)))}</b>`;
    if (tool && tool.type === 'assign' && person && person.id === tool.personId) dim = false;
    return { color, visible, dim, label, selected: g.id === selectedId };
  }

  function render() {
    if (!layers) return;
    const m = model();
    layers.sectors.clearLayers();
    layers.zones.clearLayers();
    layers.points.clearLayers();
    zoneLayers.clear();
    markers.clear();

    // Границы микрорайонов: светлая линия поверх тёмной «подложки» — видно на любой карте
    if (filters.showSectors) m.sectors.forEach(f => {
      if (f.geometry.type !== 'Point') {
        const latlngs = leafletLatLngs(f.geometry);
        layers.sectors.addLayer(L.polygon(latlngs, {
          pane: 'sectorsPane', color: '#0B1012', weight: 5, opacity: 0.45, fill: false, interactive: false
        }));
        layers.sectors.addLayer(L.polygon(latlngs, {
          pane: 'sectorsPane', color: App.basemap === 'light' ? '#3E5C55' : '#E3EFEA', weight: 2.2, dashArray: '8 6', opacity: 0.9,
          fillColor: '#E3EFEA', fillOpacity: 0.025, interactive: false
        }));
      }
      layers.sectors.addLayer(L.marker([f.center.lat, f.center.lng], {
        icon: L.divIcon({ className: 'ctx-icon', html: `<span class="sector-label">${esc(App.localizeData(f.name))}</span>`, iconSize: null }),
        interactive: false, keyboard: false
      }));
    });

    m.groups.forEach(g => {
      const vis = visualFor(g);
      g.zones.forEach(z => {
        if (m.zoneOwner.get(z.id) !== g.id || zoneLayers.has(z.id)) return;
        const poly = L.polygon(leafletLatLngs(z.geometry), { pane: 'zonesPane', ...zoneStyle(vis) });
        poly.on('click', e => {
          L.DomEvent.stop(e);
          // При рисовании/выборе места клик по существующей зоне — это клик по карте
          if (tool && (tool.type === 'draw' || tool.type === 'pick')) toolMapClick(e);
          else onObjectClick(g.id);
        });
        zoneLayers.set(z.id, poly);
        if (vis.visible) layers.zones.addLayer(poly);
      });
      const marker = L.marker([g.center.lat, g.center.lng], {
        icon: pinIcon(vis.color, { ...vis, zoneOnly: !g.point }),
        title: g.name, riseOnHover: true, zIndexOffset: vis.selected ? 900 : vis.dim ? -100 : 0
      });
      marker._visKey = visKey(vis);
      marker.on('click', e => { L.DomEvent.stop(e); onObjectClick(g.id); });
      markers.set(g.id, marker);
      if (vis.visible) layers.points.addLayer(marker);
    });
    renderLegend();
  }

  const visKey = v => `${v.color}|${v.visible}|${v.dim}|${v.label}|${v.selected}`;
  function zoneStyle(vis) {
    return {
      color: vis.selected ? SELECT : vis.color,
      weight: vis.selected ? 4 : 2,
      opacity: vis.dim ? 0.55 : 0.95,
      fillColor: vis.color,
      fillOpacity: vis.selected ? 0.32 : vis.dim ? 0.06 : 0.18
    };
  }

  // Перекраска без пересоздания слоёв (фильтры, выделение)
  function applyVisual() {
    if (!layers) return;
    const m = model();
    m.groups.forEach(g => {
      const vis = visualFor(g);
      const marker = markers.get(g.id);
      if (marker) {
        const key = visKey(vis);
        if (marker._visKey !== key) {
          marker.setIcon(pinIcon(vis.color, { ...vis, zoneOnly: !g.point }));
          marker.setZIndexOffset(vis.selected ? 900 : vis.dim ? -100 : 0);
          marker._visKey = key;
        }
        if (vis.visible && !layers.points.hasLayer(marker)) layers.points.addLayer(marker);
        if (!vis.visible && layers.points.hasLayer(marker)) layers.points.removeLayer(marker);
      }
      g.zones.forEach(z => {
        if (m.zoneOwner.get(z.id) !== g.id) return;
        const poly = zoneLayers.get(z.id);
        if (!poly) return;
        poly.setStyle(zoneStyle(vis));
        if (vis.visible && !layers.zones.hasLayer(poly)) layers.zones.addLayer(poly);
        if (!vis.visible && layers.zones.hasLayer(poly)) layers.zones.removeLayer(poly);
        if (vis.selected) poly.bringToFront();
      });
    });
    renderLegend();
    updateCounters();
  }

  // ===== Легенда (внизу слева) =====
  function renderLegend() {
    const el = $('#legend');
    const assignView = filters.assignMode || (tool && tool.type === 'assign');
    const rows = [];
    if (assignView) {
      const counts = new Map();
      model().groups.forEach(g => { if (g.assigneeId) counts.set(g.assigneeId, (counts.get(g.assigneeId) || 0) + 1); });
      const people = [...assignees.values()].filter(a => counts.get(a.id)).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      people.forEach(a => {
        const off = filters.assigneeIds.size && !filters.assigneeIds.has(a.id);
        rows.push(`<button type="button" class="legend-row${off ? ' off' : ''}" data-person="${esc(a.id)}"><i style="background:${esc(a.color)}"></i><span>${esc(a.name)}</span><em>${counts.get(a.id)}</em></button>`);
      });
      rows.push(`<div class="legend-row static"><i style="background:${GRAY}"></i><span>${esc(t('not_assigned'))}</span></div>`);
    }
    let title = assignView ? t('legend_assignees') : t('legend_tasks');
    let kindsLegend = false;
    if (!assignView && active === 'repair' && filters.tasks.size) {
      const onlyCarousel = filters.tasks.size === 1 && filters.tasks.has('carousel');
      rows.push(`<div class="legend-row static"><i style="background:${PENDING}"></i><span>${esc(t(onlyCarousel ? 'status_not_installed' : 'status_pending'))}</span></div>`);
      rows.push(`<div class="legend-row static"><i style="background:${DONE}"></i><span>${esc(t(onlyCarousel ? 'status_installed' : 'status_done'))}</span></div>`);
    }
    if (!rows.length && active === 'gis') {
      // Подсказка, чем отличаются цвета: площадка / сквер / прочая зона
      kindsLegend = true;
      title = t('legend_kinds');
      const counts = kindCounts();
      ['playground', 'square', 'zone'].forEach(k => {
        const off = !filters.kinds.has(k);
        rows.push(`<button type="button" class="legend-row${off ? ' off' : ''}" data-kind="${k}"><i style="background:${TYPE_COLORS[k]}"></i><span>${esc(t('kind_' + k))}</span><em>${counts[k] || 0}</em></button>`);
      });
    }
    if (!rows.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.innerHTML = `<div class="legend-title">${esc(title)}</div><div class="legend-rows">${rows.join('')}</div>`;
    el.classList.toggle('legend-kinds', kindsLegend);
    el.classList.remove('hidden');
    el.querySelectorAll('[data-kind]').forEach(btn => btn.addEventListener('click', () => {
      const k = btn.dataset.kind;
      if (filters.kinds.has(k)) filters.kinds.delete(k); else filters.kinds.add(k);
      saveFilters();
      applyVisual();
    }));
    el.querySelectorAll('[data-person]').forEach(btn => btn.addEventListener('click', () => {
      const id = btn.dataset.person;
      if (filters.assigneeIds.has(id) && filters.assigneeIds.size === 1) filters.assigneeIds.clear();
      else { filters.assigneeIds.clear(); filters.assigneeIds.add(id); }
      saveFilters();
      applyVisual();
    }));
  }

  function kindCounts(sec) {
    const out = {};
    model(sec).groups.forEach(g => { if (!(g.imported && filters.hideImported)) out[g.type] = (out[g.type] || 0) + 1; });
    return out;
  }

  function activeFilterCount() {
    let n = 0;
    if (filters.assignMode) n++;
    if (filters.addressLabels) n++;
    if (!filters.showSectors) n++;
    if (active === 'repair' && filters.tasks.size) n++;
    if (active === 'gis' && (filters.kinds.size < 3 || filters.hideImported)) n++;
    return n;
  }

  function updateCounters() {
    const badge = $('#filter-badge');
    const n = activeFilterCount();
    badge.textContent = n;
    badge.classList.toggle('hidden', !n);
    const m = model();
    // В ГИС счётчик — именно детские площадки (скверы и прочие зоны считаются отдельно)
    const main = active === 'gis' ? m.groups.filter(g => g.type === 'playground' && !(g.imported && filters.hideImported)) : m.groups;
    const visible = main.filter(g => visualFor(g).visible).length;
    $('#object-count').textContent = visible === main.length ? `${main.length}` : `${visible} / ${main.length}`;
    const kc = kindCounts();
    $('#object-count-btn').title = active === 'gis'
      ? t('count_hint_gis', { n: main.length, square: kc.square || 0, zone: kc.zone || 0 })
      : t('count_hint_repair', { n: main.length });
  }

  // ===== Клик по объекту =====
  function onObjectClick(groupId) {
    if (tool && tool.type === 'assign') { toggleAssign(groupId); return; }
    if (tool && tool.type === 'link') {
      const g = findGroup(groupId);
      if (!g || !g.point) { App.toast(t('sync_need_point')); return; }
      const row = tool.row;
      App.sheetSync.setLink(row.key, [g.point.id], false)
        .then(() => App.toast(t('sync_linked', { name: shortAddress(g.name) })))
        .catch(err => App.toast(err && err.code === 'permission-denied' ? t('save_denied') : t('save_failed'), { error: true }));
      cancelTool();
      return;
    }
    if (tool) return; // во время рисования/перемещения клики по объектам игнорируем
    select(groupId);
  }

  function select(id, opts = {}) {
    let g = findGroup(id);
    if (!g) {
      const other = active === 'gis' ? 'repair' : 'gis';
      if (findGroup(id, other)) { switchSection(other); g = findGroup(id); }
    }
    if (!g) { App.toast(t('not_found')); return; }
    App.map.closePopup();
    selectedId = g.id;
    applyVisual();
    if (opts.fly !== false) {
      const target = [g.center.lat, g.center.lng];
      const zoom = Math.max(App.map.getZoom(), g.point ? 17 : 16);
      App.map.flyTo(target, zoom, { duration: 0.45 });
    }
    if (App.sheet.isOpen()) App.sheet.close(true);
    showCard(g);
    setHash(g);
    if (opts.details) openDetails(g.id);
  }

  function setHash(g) {
    const hash = g ? `#${g.section}/${encodeURIComponent(g.id)}` : ' ';
    try { history.replaceState(null, '', hash === ' ' ? location.pathname + location.search : hash); } catch (e) { /* file:// */ }
  }

  // ===== Плавающая карточка =====
  const isMobile = () => window.matchMedia('(max-width: 760px)').matches;
  let cardDrag = null;

  function chipsHtml(g, compact) {
    const out = [];
    const person = assigneeOf(g);
    if (person) out.push(`<span class="chip chip-person" style="--c:${esc(person.color)}"><i></i>${esc(person.name)}</span>`);
    if (g.area) out.push(`<span class="chip">${esc(g.area)} м²</span>`);
    if (g.section === 'repair') {
      const st = taskState(g);
      // Карусель в чипах показываем только установленную — иначе она была бы у всех площадок
      st.keys.filter(k => k !== 'carousel' || g.tasks[k]).forEach(k => out.push(`<span class="chip ${g.tasks[k] ? 'chip-ok' : 'chip-warn'}">${ic(g.tasks[k] ? 'check' : 'clock')}${esc(t(TASKS[k].label))}</span>`));
    }
    if (g.type === 'square') out.push(`<span class="chip chip-square">${esc(t('kind_square_one'))}</span>`);
    if (g.imported && !compact) out.push(`<span class="chip">${esc(t('imported_badge'))}</span>`);
    if (isAdmin() && !compact && g.photos.length) out.push(`<span class="chip">${ic('image')}${g.photos.length}</span>`);
    return out.join('');
  }

  function showCard(g, opts = {}) {
    // Пока открыта подробная панель, карточка не нужна (она под ней)
    if (App.sheet.key() === 'details') return;
    const card = $('#card');
    const firstText = g.descriptions[0] ? g.descriptions[0].text : '';
    card.innerHTML = `
      <div class="card-head" id="card-head">
        <div class="card-head-text">
          <div class="card-kicker">${esc(App.localizeData(g.folder))}</div>
          <div class="card-title">${esc(App.localizeData(g.name))}</div>
          ${g.zoneName ? `<div class="card-sub">${esc(App.localizeData(g.zoneName))}</div>` : ''}
        </div>
        <button type="button" class="icon-btn icon-btn-sm" id="card-close" aria-label="${esc(t('close'))}">${ic('x')}</button>
      </div>
      <div class="card-chips">${chipsHtml(g, true)}</div>
      ${firstText ? `<div class="card-desc">${esc(App.localizeData(firstText))}</div>` : `<div class="card-desc muted">${esc(t('no_desc'))}</div>`}
      <div class="card-actions">
        <button type="button" class="btn btn-primary" data-card="details">${ic('info')}${esc(t('details'))}</button>
        <button type="button" class="btn btn-secondary" data-card="route" aria-label="${esc(t('route_here'))}">${ic('route')}<span class="hide-xs">${esc(t('route_short'))}</span></button>
        ${isAdmin() ? `<button type="button" class="btn btn-secondary" data-card="assign" aria-label="${esc(t('assign'))}" title="${esc(t('assign'))}">${ic('userPlus')}</button>` : ''}
      </div>
      ${isAdmin() ? `
      <div class="card-admin">
        <button type="button" class="btn btn-ghost btn-sm" data-card="edit">${ic('edit')}${esc(t('edit'))}</button>
        ${g.point ? `<button type="button" class="btn btn-ghost btn-sm" data-card="move">${ic('move')}${esc(t('move_point'))}</button>` : ''}
        <button type="button" class="btn btn-ghost btn-sm" data-card="color" aria-label="${esc(t('object_color'))}" title="${esc(t('object_color'))}"><i class="color-dot" style="background:${esc(baseColor(g))}"></i>${esc(t('color_short'))}</button>
      </div>` : ''}`;
    card.classList.remove('hidden');
    card.classList.toggle('docked', isMobile());
    document.body.classList.add('card-open');
    $('#card-close').addEventListener('click', closeCard);
    card.querySelector('[data-card="details"]').addEventListener('click', () => openDetails(g.id));
    card.querySelector('[data-card="route"]').addEventListener('click', () => App.openRouteTo(g.center.lat, g.center.lng, g.name));
    const assignBtn = card.querySelector('[data-card="assign"]');
    if (assignBtn) assignBtn.addEventListener('click', () => pickAssigneeFor(g.id));
    const cardAct = (name, fn) => { const el = card.querySelector(`[data-card="${name}"]`); if (el) el.addEventListener('click', fn); };
    cardAct('edit', () => openEditor(g.id));
    cardAct('move', () => startMovePoint(g.id));
    cardAct('color', () => pickObjectColor(g.id));
    setupCardDrag();
    if (!isMobile() && !(opts.keepPosition && card.dataset.placed === g.id)) positionCard(g);
    card.dataset.placed = g.id;
    updateCardLine();
    App.map.once('moveend', updateCardLine);
  }

  function screenPoint(lat, lng) {
    const p = App.map.latLngToContainerPoint([lat, lng]);
    const r = App.map.getContainer().getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }

  function positionCard(g) {
    const card = $('#card');
    // Карточка ставится сбоку от объекта с учётом того, куда «прилетит» карта
    const w = card.offsetWidth, h = card.offsetHeight, margin = 16;
    const target = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    let left = target.x + 40, top = target.y - h / 2 - 40;
    if (left + w > window.innerWidth - margin) left = target.x - w - 40;
    left = Math.max(margin, left);
    top = Math.max(130, Math.min(window.innerHeight - h - margin, top));
    card.style.left = left + 'px';
    card.style.top = top + 'px';
  }

  function updateCardLine() {
    const wrap = $('#card-line');
    const card = $('#card');
    if (!selectedId || card.classList.contains('hidden') || isMobile()) { wrap.style.display = 'none'; return; }
    const g = findGroup(selectedId);
    if (!g) return;
    const target = screenPoint(g.center.lat, g.center.lng);
    const r = card.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const dx = target.x - cx, dy = target.y - cy;
    const scale = Math.min(dx ? (r.width / 2) / Math.abs(dx) : Infinity, dy ? (r.height / 2) / Math.abs(dy) : Infinity, 1e6);
    const sx = cx + dx * scale, sy = cy + dy * scale;
    const inside = target.x > r.left && target.x < r.right && target.y > r.top && target.y < r.bottom;
    wrap.style.display = inside ? 'none' : 'block';
    const line = $('#card-line-path'), dot = $('#card-line-dot');
    line.setAttribute('x1', sx); line.setAttribute('y1', sy); line.setAttribute('x2', target.x); line.setAttribute('y2', target.y);
    dot.setAttribute('cx', target.x); dot.setAttribute('cy', target.y);
  }

  function setupCardDrag() {
    const card = $('#card');
    const head = $('#card-head');
    head.addEventListener('pointerdown', e => {
      if (isMobile() || e.target.closest('button')) return;
      const r = card.getBoundingClientRect();
      cardDrag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      try { head.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    head.addEventListener('pointermove', e => {
      if (!cardDrag) return;
      const m = 8;
      card.style.left = Math.max(m, Math.min(window.innerWidth - card.offsetWidth - m, cardDrag.left + e.clientX - cardDrag.x)) + 'px';
      card.style.top = Math.max(m, Math.min(window.innerHeight - card.offsetHeight - m, cardDrag.top + e.clientY - cardDrag.y)) + 'px';
      updateCardLine();
    });
    const end = () => { cardDrag = null; };
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
  }

  function closeCard() {
    const had = !!selectedId;
    selectedId = null;
    $('#card').classList.add('hidden');
    $('#card').dataset.placed = '';
    $('#card-line').style.display = 'none';
    document.body.classList.remove('card-open');
    if (had) { applyVisual(); setHash(null); }
  }

  // ===== Описание: «Поле: значение» → аккуратная таблица, «•» → список =====
  function descriptionHtml(text) {
    const lines = App.localizeData(text).split('\n').map(s => s.trim()).filter(Boolean);
    const rows = [], free = [];
    lines.forEach(line => {
      const m = line.match(/^([^:•]{2,48}):\s*(.*)$/);
      if (m) {
        const key = m[1].replace(/_/g, ' ').trim();
        const value = m[2].trim();
        if (!value) return; // пустые поля шаблона не показываем
        const bullets = value.split(/\s*•\s*/).map(s => s.trim()).filter(Boolean);
        const valueHtml = bullets.length > 1 || /^•/.test(value)
          ? `<ul class="desc-list">${bullets.map(b => `<li>${esc(b)}</li>`).join('')}</ul>`
          : esc(value.replace(/кв\.?\s*м(?![а-яё])/gi, 'м²'));
        rows.push(`<div class="desc-row"><dt>${esc(key)}</dt><dd>${valueHtml}</dd></div>`);
      } else free.push(`<p>${esc(line)}</p>`);
    });
    return (rows.length ? `<dl class="desc-table">${rows.join('')}</dl>` : '') + free.join('');
  }

  // ===== Подробная карточка (панель) =====
  function openDetails(id) {
    const g = findGroup(id);
    if (!g) return;
    selectedId = g.id;
    applyVisual();
    $('#card').classList.add('hidden');
    $('#card-line').style.display = 'none';
    App.sheet.open({
      title: App.localizeData(g.folder),
      key: 'details',
      html: detailsHtml(g),
      onRender: body => bindDetails(body, g),
      onClose: () => { if (selectedId === g.id) { const fresh = findGroup(g.id); if (fresh) showCard(fresh, { keepPosition: true }); } }
    });
  }

  function detailsHtml(g) {
    const person = assigneeOf(g);
    const admin = isAdmin();
    const st = taskState(g);
    const broken = g.members.some(m => m.descBroken);
    const multiDesc = g.descriptions.length > 1;
    const sheetOk = g.section === 'repair' && !!model('repair').sheet;
    return `
      <div class="detail-head">
        <h2 class="detail-title">${esc(App.localizeData(g.name))}</h2>
        ${g.zoneName ? `<div class="detail-sub">${ic('polygon')}${esc(App.localizeData(g.zoneName))}</div>` : ''}
        <div class="card-chips">${chipsHtml(g)}</div>
      </div>

      <div class="quick-actions">
        <button type="button" class="qa" data-act="route">${ic('route')}<span>${esc(t('route_short'))}</span></button>
        <button type="button" class="qa" data-act="share">${ic('link')}<span>${esc(t('share'))}</span></button>
        <button type="button" class="qa" data-act="coords">${ic('copy')}<span>${esc(t('coords'))}</span></button>
        <a class="qa" href="https://www.google.com/maps/search/?api=1&query=${g.center.lat},${g.center.lng}" target="_blank" rel="noopener">${ic('external')}<span>Google Maps</span></a>
      </div>

      <section class="block">
        <div class="block-title">${ic('user')}${esc(t('assignee'))}</div>
        ${person ? `
          <div class="person-row">
            <span class="person-dot" style="background:${esc(person.color)}"></span>
            <div class="person-text"><b>${esc(person.name)}</b>${person.phone ? `<span>${esc(person.phone)}</span>` : ''}</div>
            ${person.phone ? `<a class="btn btn-secondary btn-sm" href="${esc(telHref(person.phone))}">${ic('phone')}${esc(t('call'))}</a>` : ''}
          </div>` : `<div class="muted">${esc(t('not_assigned'))}</div>`}
        ${admin ? `<div class="row-actions"><button type="button" class="btn btn-secondary btn-sm" data-act="assign">${ic('userPlus')}${esc(person ? t('reassign') : t('assign'))}</button>
          ${person ? `<button type="button" class="btn btn-ghost btn-sm" data-act="unassign">${ic('x')}${esc(t('unassign'))}</button>` : ''}</div>` : ''}
      </section>

      ${g.section === 'repair' && g.point ? `
      <section class="block">
        <div class="block-title">${ic('list')}${esc(t('tasks_title'))}</div>
        ${sheetOk ? `<div class="source-note">${ic('grid')}<span>${esc(t('tasks_from_sheet'))}</span></div>` : ''}
        ${st.keys.length ? st.keys.map(k => {
          const label = esc(g.tasks[k] ? t(TASKS[k].done) : t(TASKS[k].pending));
          const bySheet = g.sheetDone && g.sheetDone.has(k);
          return `
          <div class="task-row">
            <span class="task-name">${ic(TASKS[k].icon)}${esc(t(TASKS[k].label))}${bySheet ? `<em class="by-sheet">${esc(t('by_sheet'))}</em>` : ''}</span>
            ${admin && !bySheet
              ? `<button type="button" class="status-toggle ${g.tasks[k] ? 'is-done' : 'is-pending'}" data-task-toggle="${k}">${ic(g.tasks[k] ? 'check' : 'clock')}${label}</button>
                 ${k === 'carousel' && sheetOk ? '' : `<button type="button" class="icon-btn icon-btn-sm" data-task-remove="${k}" aria-label="${esc(t('task_remove'))}">${ic('trash')}</button>`}`
              : `<span class="status-pill ${g.tasks[k] ? 'is-done' : 'is-pending'}">${ic(g.tasks[k] ? 'check' : 'clock')}${label}</span>`}
          </div>`;
        }).join('') : `<div class="muted">${esc(t(sheetOk ? 'tasks_none_sheet' : 'tasks_none'))}</div>`}
        ${admin ? `<div class="row-actions">${Object.keys(TASKS).filter(k => !st.keys.includes(k)).map(k => `<button type="button" class="btn btn-ghost btn-sm" data-task-add="${k}">${ic('plus')}${esc(t(TASKS[k].label))}</button>`).join('')}</div>` : ''}
      </section>` : ''}

      <section class="block">
        <div class="block-title">${ic('info')}${esc(t('description'))}</div>
        ${broken && admin ? `<div class="notice">${ic('shield')}<span>${esc(t('desc_restored_notice'))}</span></div>` : ''}
        ${g.descriptions.length ? g.descriptions.map(d => `
          ${multiDesc ? `<div class="desc-caption">${esc(d.kind === 'point' ? t('desc_point') : t('desc_zone'))}</div>` : ''}
          <div class="desc">${descriptionHtml(d.text)}</div>`).join('') : `<div class="muted">${esc(t('no_desc'))}</div>`}
      </section>

      ${admin ? `<details class="block photo-section">
        <summary class="block-title">${ic('image')}${esc(t('photos'))}</summary>
        ${g.photos.length ? `<div class="photo-grid" id="photo-grid">${g.photos.map((p, i) => `
          <div class="photo-cell"><button type="button" class="photo-open" data-photo="${i}"><span class="photo-ph">${ic('image')}${esc(t('show_photo'))} ${i + 1}</span></button>
          ${admin ? `<button type="button" class="icon-btn icon-btn-sm photo-del" data-photo-del="${i}" aria-label="${esc(t('delete'))}">${ic('trash')}</button>` : ''}</div>`).join('')}</div>`
          : `<div class="muted">${esc(t('no_photos'))}</div>`}
        ${admin ? `<div class="row-actions">
          ${[1, 2].map(slot => `<label class="btn btn-secondary btn-sm file-btn">${ic('camera')}${esc(t('photo_slot'))} ${slot}${g.primary['photo' + slot + 'Url'] ? ' · ' + esc(t('replace')) : ''}
            <input type="file" accept="image/*" data-upload="${slot}" hidden></label>`).join('')}
        </div>` : ''}
      </details>` : ''}

      <section class="block meta">
        <div>${ic('pin')}${g.center.lat.toFixed(6)}, ${g.center.lng.toFixed(6)}</div>
        <div>ID: ${g.memberIds.map(esc).join(', ')}</div>
        ${g.primary.updatedAt ? `<div>${esc(t('updated'))}: ${esc(App.formatDate(g.primary.updatedAt))}${g.primary.updatedBy && admin ? ' · ' + esc(g.primary.updatedBy) : ''}</div>` : ''}
      </section>

      ${admin ? `
      <section class="block admin-block">
        <div class="block-title">${ic('lock')}${esc(t('admin_actions'))}</div>
        <div class="admin-grid">
          <button type="button" class="btn btn-primary" data-act="edit">${ic('edit')}${esc(t('edit'))}</button>
          ${g.point ? `<button type="button" class="btn btn-secondary" data-act="move">${ic('move')}${esc(t('move_point'))}</button>` : ''}
          ${g.zones.length === 1 && g.zones[0].geometry.type === 'Polygon' ? `<button type="button" class="btn btn-secondary" data-act="vertices">${ic('polygon')}${esc(t('edit_bounds'))}</button>` : ''}
          ${!g.point ? `<button type="button" class="btn btn-secondary" data-act="add-point">${ic('pin')}${esc(t('add_icon_here'))}</button>` : ''}
          <button type="button" class="btn btn-secondary" data-act="history">${ic('history')}${esc(t('history'))}</button>
          <button type="button" class="btn btn-danger-outline" data-act="delete">${ic('trash')}${esc(t('delete'))}</button>
        </div>
      </section>` : ''}`;
  }

  function bindDetails(body, g) {
    const on = (sel, fn) => body.querySelectorAll(sel).forEach(el => el.addEventListener('click', () => fn(el)));
    on('[data-act="route"]', () => { App.sheet.close(true); App.openRouteTo(g.center.lat, g.center.lng, g.name); });
    on('[data-act="share"]', () => App.copyText(`${location.origin}${location.pathname}#${g.section}/${encodeURIComponent(g.id)}`, t('link_copied')));
    on('[data-act="coords"]', () => App.copyText(`${g.center.lat.toFixed(6)}, ${g.center.lng.toFixed(6)}`, t('coords_copied')));
    on('[data-act="assign"]', () => pickAssigneeFor(g.id));
    on('[data-act="unassign"]', () => setAssignee(g, null));
    on('[data-act="edit"]', () => openEditor(g.id));
    on('[data-act="move"]', () => startMovePoint(g.id));
    on('[data-act="vertices"]', () => startEditVertices(g.id));
    on('[data-act="add-point"]', () => addPointInZone(g.id));
    on('[data-act="history"]', () => openHistory(g.id));
    on('[data-act="delete"]', () => deleteGroup(g.id));
    on('[data-task-toggle]', el => toggleTask(g, el.dataset.taskToggle));
    on('[data-task-remove]', el => removeTask(g, el.dataset.taskRemove));
    on('[data-task-add]', el => addTask(g, el.dataset.taskAdd));
    on('[data-photo]', el => showPrivatePhoto(el, g.photos[+el.dataset.photo]));
    on('[data-photo-del]', el => deletePhoto(g, g.photos[+el.dataset.photoDel]));
    body.querySelectorAll('[data-upload]').forEach(input => input.addEventListener('change', e => uploadPhoto(g, +input.dataset.upload, e)));
  }

  function rerenderDetails(id) {
    if (App.sheet.key() !== 'details') return;
    const g = findGroup(id);
    if (!g) { App.sheet.close(true); return; }
    App.sheet.set(detailsHtml(g), body => bindDetails(body, g));
  }
  App.on('registry-refresh', () => { if (App.sheet.key() === 'details' && selectedId) rerenderDetails(selectedId); });

  // ===== Виды работ =====
  function saveTasks(g, tasks) {
    return saveOverride(g.section, g.point.id, { tasks }, { action: 'tasks' }).catch(() => { });
  }
  // Пишем поверх сохранённых статусов, чтобы не потерять отметки по другим работам
  function toggleTask(g, key) {
    if (g.sheetDone && g.sheetDone.has(key)) { App.toast(t('done_in_sheet')); return; }
    saveTasks(g, { ...(g.storedTasks || {}), [key]: !g.tasks[key] });
  }
  function addTask(g, key) { saveTasks(g, { ...(g.storedTasks || {}), [key]: false }); }
  async function removeTask(g, key) {
    if (!(await App.confirmDialog(t('task_remove_confirm'), { danger: true, ok: t('delete') }))) return;
    const tasks = { ...(g.storedTasks || {}) };
    delete tasks[key];
    saveTasks(g, tasks);
  }

  // ===== Фото (до 2 на объект, WebP на устройстве → Firebase Storage) =====
  const PHOTO_MAX_DIM = 1920;
  const PHOTO_TARGET_BYTES = 380000;

  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        let dim = PHOTO_MAX_DIM, quality = 0.82;
        const attempt = type => {
          let { width, height } = img;
          if (width > dim || height > dim) {
            if (width > height) { height = Math.round(height * dim / width); width = dim; } else { width = Math.round(width * dim / height); height = dim; }
          }
          canvas.width = width; canvas.height = height;
          ctx.drawImage(img, 0, 0, width, height);
          canvas.toBlob(blob => {
            if (!blob) { reject(new Error('toBlob')); return; }
            if (type === 'image/webp' && blob.type !== 'image/webp') { attempt('image/jpeg'); return; } // старый Safari
            if (blob.size <= PHOTO_TARGET_BYTES || (dim <= 480 && quality <= 0.35)) { resolve(blob); return; }
            if (quality > 0.35) quality = Math.max(0.35, quality - 0.12); else dim = Math.round(dim * 0.8);
            attempt(type);
          }, type, quality);
        };
        attempt('image/webp');
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
      img.src = url;
    });
  }

  async function showPrivatePhoto(button, photo) {
    if (!photo || !isAdmin() || button.disabled || button.querySelector('img')) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.innerHTML = '<span class="photo-ph" role="status"><i class="photo-loader"></i>' + esc(t('loading')) + '</span>';
    try {
      const url = await App.photos.load(photo.url);
      if (!isAdmin() || !button.isConnected) return;
      const image = new Image();
      image.alt = t('photos');
      image.loading = 'lazy';
      image.decoding = 'async';
      image.dataset.privatePhoto = '';
      image.onerror = () => {
        if (!button.isConnected) return;
        App.photos.forget(photo.url);
        button.onclick = null;
        button.innerHTML = '<span class="photo-ph photo-error">' + esc(t('photo_load_failed')) + '</span>';
        button.disabled = false;
      };
      image.src = url;
      button.replaceChildren(image);
      // Full-size view also uses the in-memory blob, never a public download URL.
      button.onclick = () => { if (isAdmin()) window.open(url, '_blank', 'noopener'); };
    } catch (err) {
      if (button.isConnected && isAdmin()) button.innerHTML = '<span class="photo-ph photo-error">' + esc(t('photo_load_failed')) + '</span>';
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }

  async function uploadPhoto(g, slot, event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file || !isAdmin()) return;
    if (!App.fb.storage) { App.toast(t('storage_off'), { error: true }); return; }
    App.toast(t('uploading'), { duration: 20000 });
    let uploadedRef = null, committed = false;
    try {
      const blob = await compressImage(file);
      const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
      const suffix = crypto.randomUUID();
      const ref = App.fb.storage.ref(`registry-photos/${g.section}/${g.primary.id}/photo${slot}-${suffix}.${ext}`);
      await ref.put(blob, { contentType: blob.type, cacheControl: 'private, no-store' });
      uploadedRef = ref;
      const field = `photo${slot}Url`;
      const old = g.primary[field];
      await saveOverride(g.section, g.primary.id, { [field]: ref.fullPath }, { action: 'photo' });
      committed = true;
      if (old) {
        App.photos.forget(old);
        await App.photos.reference(old).delete().catch(err => console.warn('Old photo cleanup:', err));
      }
      App.toast(t('photo_saved'));
    } catch (err) {
      if (uploadedRef && !committed) await uploadedRef.delete().catch(() => {});
      console.error(err);
      App.toast(err && err.code === 'storage/unauthorized' ? t('save_denied') : t('photo_failed'), { error: true });
    }
  }

  async function deletePhoto(g, photo) {
    if (!isAdmin() || !photo || !(await App.confirmDialog(t('photo_delete_confirm'), { danger: true, ok: t('delete') }))) return;
    try {
      // Unlink first: a failed database write must never leave a broken live reference.
      await saveOverride(g.section, photo.featureId, { [photo.field]: DELETE }, { action: 'photo-delete' });
      App.photos.forget(photo.url);
      if (App.fb.storage) await App.photos.reference(photo.url).delete().catch(err => console.warn('Photo cleanup:', err));
      App.toast(t('photo_deleted'));
    } catch (err) { /* saveOverride reports database errors */ }
  }

  // ===== Назначение ответственных =====
  async function setAssignee(g, personId, silent) {
    const sec = g.section;
    const writes = [];
    const before = g.assigneeId;
    // Ответственный хранится у главного объекта группы; у остальных частей — снимаем
    writes.push(saveOverride(sec, g.primary.id, { assigneeId: personId || DELETE }, { action: 'assign' }));
    g.members.forEach(m => { if (m.id !== g.primary.id && m.assigneeId) writes.push(saveOverride(sec, m.id, { assigneeId: DELETE }, { action: 'assign' })); });
    try {
      await Promise.all(writes);
      if (!silent) {
        const p = personId && assignees.get(personId);
        App.toast(p ? t('assigned_to', { name: p.name }) : t('unassigned'), {
          action: { label: t('undo'), fn: () => { const fresh = findGroup(g.id, sec); if (fresh) setAssignee(fresh, before, true); } }
        });
      }
    } catch (err) { /* тост уже показан */ }
  }

  async function pickAssigneeFor(groupId) {
    const g = findGroup(groupId);
    if (!g) return;
    const people = [...assignees.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const choice = await App.dialog({
      title: t('assign_title'),
      html: `
        <p class="dialog-text muted">${esc(shortAddress(g.name))}</p>
        <div class="choice-list">
          ${people.map(p => `<label class="choice"><input type="radio" name="assignee" value="${esc(p.id)}" ${g.assigneeId === p.id ? 'checked' : ''}>
            <i style="background:${esc(p.color)}"></i><span><b>${esc(p.name)}</b>${p.phone ? `<em>${esc(p.phone)}</em>` : ''}</span></label>`).join('')}
          ${people.length ? '' : `<div class="muted">${esc(t('no_assignees'))}</div>`}
        </div>`,
      dismissValue: null,
      actions: [
        { label: t('cancel'), value: null },
        { label: t('new_person'), value: '__new__' },
        { label: t('save'), kind: 'primary', value: root => { const r = root.querySelector('input[name="assignee"]:checked'); return r ? r.value : null; } }
      ]
    });
    if (choice === '__new__') {
      const id = await editPerson();
      if (id) setAssignee(findGroup(groupId), id);
      return;
    }
    if (choice && choice !== g.assigneeId) setAssignee(g, choice);
  }

  async function editPerson(personId) {
    if (!isAdmin()) return null;
    const person = personId ? assignees.get(personId) : null;
    let color = person ? person.color : freeColor();
    const id = await App.dialog({
      title: person ? t('person_edit') : t('person_new'),
      html: `
        <label class="field-label" for="p-name">${esc(t('person_name'))}</label>
        <input id="p-name" class="field" autocomplete="off" placeholder="${esc(t('person_name_ph'))}" value="${esc(person ? person.name : '')}">
        <label class="field-label" for="p-phone">${esc(t('person_phone'))}</label>
        <input id="p-phone" class="field" type="tel" inputmode="tel" placeholder="+7 700 000 00 00" value="${esc(person ? person.phone || '' : '')}">
        <label class="field-label">${esc(t('person_color'))}</label>
        <div class="swatches" id="p-swatches">
          ${PALETTE.map(c => `<button type="button" class="swatch" data-c="${c}" style="background:${c}" aria-label="${c}"></button>`).join('')}
          <label class="swatch swatch-custom" aria-label="${esc(t('custom_color'))}">${ic('plus')}<input type="color" id="p-color" value="${esc(color)}"></label>
        </div>
        <div class="field-hint">${esc(t('person_color_hint'))}</div>`,
      onOpen: root => {
        const mark = () => root.querySelectorAll('.swatch[data-c]').forEach(s => s.classList.toggle('active', s.dataset.c.toUpperCase() === String(color).toUpperCase()));
        const used = new Set([...assignees.values()].filter(a => a.id !== personId).map(a => (a.color || '').toUpperCase()));
        root.querySelectorAll('.swatch[data-c]').forEach(s => {
          if (used.has(s.dataset.c.toUpperCase())) s.classList.add('used');
          s.addEventListener('click', () => { color = s.dataset.c; root.querySelector('#p-color').value = color; mark(); });
        });
        root.querySelector('#p-color').addEventListener('input', e => { color = e.target.value.toUpperCase(); mark(); });
        root.querySelector('#p-phone').addEventListener('blur', e => { e.target.value = formatPhone(e.target.value); });
        mark();
      },
      dismissValue: null,
      actions: [
        { label: t('cancel'), value: null },
        {
          label: t('save'), kind: 'primary',
          validate: async root => {
            const name = root.querySelector('#p-name').value.trim().replace(/\s+/g, ' ');
            if (!name) return t('person_name_required');
            const phone = formatPhone(root.querySelector('#p-phone').value);
            const data = { name, phone, color: String(color).toUpperCase(), updatedAt: new Date().toISOString() };
            try {
              if (person) await App.fb.db.collection('assignees').doc(person.id).set(data, { merge: true });
              else { data.createdAt = data.updatedAt; const ref = await App.fb.db.collection('assignees').add(data); root.dataset.newId = ref.id; }
              logAudit({ section: 'assignees', featureId: person ? person.id : root.dataset.newId, action: person ? 'person-update' : 'person-create', before: person || null, after: data });
              return null;
            } catch (err) {
              return err && err.code === 'permission-denied' ? t('save_denied') : t('save_failed');
            }
          },
          value: root => person ? person.id : root.dataset.newId
        }
      ]
    });
    return id;
  }

  async function deletePerson(personId) {
    const person = assignees.get(personId);
    if (!person) return;
    const count = groupsOfPerson(personId, 'gis').length + groupsOfPerson(personId, 'repair').length;
    if (!(await App.confirmDialog(t('person_delete_confirm', { name: person.name, n: count }), { danger: true, ok: t('delete') }))) return;
    try {
      for (const sec of ['gis', 'repair']) {
        model(sec).features.filter(f => f.assigneeId === personId).forEach(f => saveOverride(sec, f.id, { assigneeId: DELETE }, { action: 'assign' }).catch(() => { }));
      }
      await App.fb.db.collection('assignees').doc(personId).delete();
      logAudit({ section: 'assignees', featureId: personId, action: 'person-delete', before: person, after: null });
      filters.assigneeIds.delete(personId);
      saveFilters();
      App.toast(t('person_deleted'));
    } catch (err) {
      App.toast(err && err.code === 'permission-denied' ? t('save_denied') : t('save_failed'), { error: true });
    }
  }

  // Режим «назначение на карте»: тапаете по площадкам — они закрепляются за человеком
  function startAssignTool(personId) {
    const person = assignees.get(personId);
    if (!person) return;
    App.sheet.close(true);
    App.drawer.close();
    closeCard();
    tool = { type: 'assign', personId };
    applyVisual();
    renderToolbar();
  }

  function toggleAssign(groupId) {
    const g = findGroup(groupId);
    if (!g || !tool) return;
    const next = g.assigneeId === tool.personId ? null : tool.personId;
    if (g.assigneeId && next) {
      const other = assignees.get(g.assigneeId);
      if (other) App.toast(t('reassigned_from', { name: other.name }));
    }
    setAssignee(g, next, true).then(renderToolbar);
  }

  function showPersonOnMap(personId) {
    const person = assignees.get(personId);
    if (!person) return;
    let groups = groupsOfPerson(personId);
    if (!groups.length) {
      const other = active === 'gis' ? 'repair' : 'gis';
      if (groupsOfPerson(personId, other).length) { switchSection(other); groups = groupsOfPerson(personId); }
    }
    filters.assignMode = true;
    filters.assigneeIds = new Set([personId]);
    filters.assigneeLabels = true;
    saveFilters();
    App.sheet.close(true);
    App.drawer.close();
    closeCard();
    applyVisual();
    if (!groups.length) { App.toast(t('person_no_objects')); return; }
    App.map.fitBounds(L.latLngBounds(groups.map(g => [g.center.lat, g.center.lng])).pad(0.15), { maxZoom: 17, paddingTopLeft: [20, 140], paddingBottomRight: [20, 40] });
    App.toast(t('person_shown', { name: person.name, n: groups.length }));
  }

  function exportPersonSnapshot(personId) {
    const person = assignees.get(personId);
    if (!person) return;
    const groups = groupsOfPerson(personId);
    if (!groups.length) { App.toast(t('person_no_objects')); return; }
    App.snapshot.exportPerson({
      person, groups,
      sectionTitle: t(active === 'gis' ? 'section_gis' : 'section_repair'),
      zones: groups.flatMap(g => g.zones)
    });
  }

  // ===== Инструменты на карте: тулбар =====
  function renderToolbar() {
    const bar = $('#toolbar');
    if (!tool) { bar.classList.add('hidden'); bar.innerHTML = ''; document.body.classList.remove('tool-active'); return; }
    document.body.classList.add('tool-active');
    let html = '';
    if (tool.type === 'assign') {
      const p = assignees.get(tool.personId);
      const n = groupsOfPerson(tool.personId).length;
      html = `<span class="tb-dot" style="background:${esc(p ? p.color : GRAY)}"></span>
        <div class="tb-text"><b>${esc(p ? p.name : '')}</b><span>${esc(t('assign_tool_hint'))} · ${n}</span></div>
        <button type="button" class="btn btn-primary" data-tb="done">${ic('check')}${esc(t('done'))}</button>`;
    } else if (tool.type === 'link') {
      html = `${ic('grid', 'tb-ic')}<div class="tb-text"><b>${esc(tool.row.raw)}</b><span>${esc(t('sync_link_tool'))}</span></div>
        <button type="button" class="btn btn-secondary" data-tb="cancel">${esc(t('cancel'))}</button>`;
    } else if (tool.type === 'pick') {
      html = `${ic('pin', 'tb-ic')}<div class="tb-text"><b>${esc(t('pick_title'))}</b><span>${esc(t('pick_hint'))}</span></div>
        <button type="button" class="btn btn-secondary" data-tb="cancel">${esc(t('cancel'))}</button>`;
    } else if (tool.type === 'draw') {
      html = `<div class="tb-count">${tool.vertices.length}</div><div class="tb-text"><b>${esc(t('draw_title'))}</b><span>${esc(t('draw_hint'))}</span></div>
        <button type="button" class="icon-btn" data-tb="undo" aria-label="${esc(t('undo'))}">${ic('undo')}</button>
        <button type="button" class="btn btn-secondary" data-tb="cancel">${esc(t('cancel'))}</button>
        <button type="button" class="btn btn-primary" data-tb="finish" ${tool.vertices.length < 3 ? 'disabled' : ''}>${ic('check')}${esc(t('done'))}</button>`;
    } else if (tool.type === 'move' || tool.type === 'vertices') {
      html = `${ic(tool.type === 'move' ? 'move' : 'polygon', 'tb-ic')}<div class="tb-text"><b>${esc(t(tool.type === 'move' ? 'move_title' : 'vertices_title'))}</b><span>${esc(t(tool.type === 'move' ? 'move_hint' : 'vertices_hint'))}</span></div>
        <button type="button" class="btn btn-secondary" data-tb="cancel">${esc(t('cancel'))}</button>
        <button type="button" class="btn btn-primary" data-tb="save">${ic('check')}${esc(t('save'))}</button>`;
    }
    bar.innerHTML = html;
    bar.classList.remove('hidden');
    bar.querySelectorAll('[data-tb]').forEach(btn => btn.addEventListener('click', () => toolAction(btn.dataset.tb)));
  }

  function toolAction(action) {
    if (!tool) return;
    if (action === 'done' || action === 'cancel') { cancelTool(); return; }
    if (tool.type === 'draw') {
      if (action === 'undo') { tool.vertices.pop(); drawPreview(); renderToolbar(); }
      if (action === 'finish') finishDraw();
    }
    if (action === 'save' && tool.onSave) tool.onSave();
  }

  // Esc / «Отмена»: возвращает true, если инструмент был активен
  function cancelTool() {
    if (!tool) return false;
    const cur = tool;
    tool = null;
    layers.draft.clearLayers();
    App.map.getContainer().classList.remove('crosshair');
    if (cur.onCancel) cur.onCancel();
    renderToolbar();
    render();
    return true;
  }

  function toolMapClick(e) {
    if (!tool) return false;
    if (tool.type === 'pick') { const cb = tool.onPick; tool = null; App.map.getContainer().classList.remove('crosshair'); renderToolbar(); cb(e.latlng); return true; }
    if (tool.type === 'draw') { tool.vertices.push({ lat: e.latlng.lat, lng: e.latlng.lng }); drawPreview(); renderToolbar(); return true; }
    return true; // в остальных режимах клик по пустой карте ничего не делает
  }
  App.mapClickHandlers.push(toolMapClick);

  // ===== Добавление точки =====
  function startPick(onPick, onCancel) {
    App.sheet.hide(true);
    closeCard();
    tool = { type: 'pick', onPick, onCancel };
    App.map.getContainer().classList.add('crosshair');
    renderToolbar();
  }

  function openAddPoint(prefill = {}) {
    if (!isAdmin()) { App.toast(t('need_admin')); return; }
    App.drawer.close();
    if (!prefill.lat) {
      startPick(latlng => openAddPoint({ ...prefill, lat: latlng.lat, lng: latlng.lng }));
      return;
    }
    const S = SECTIONS[active];
    const house = App.findNearestHouse(prefill.lat, prefill.lng, 60);
    const zoneGroup = model().groups.find(g => !g.point && pointInGeometry(prefill.lat, prefill.lng, g.zones[0].geometry));
    const name = prefill.name || (zoneGroup ? zoneGroup.name : house ? house.label : '');
    App.sheet.open({
      title: t('add_point_title'),
      key: 'add-point',
      html: `
        ${zoneGroup ? `<div class="notice">${ic('polygon')}<span>${esc(t('will_merge_with', { name: zoneGroup.name }))}</span></div>` : ''}
        <label class="field-label" for="np-name">${esc(t('name_label'))}</label>
        <input id="np-name" class="field" value="${esc(name)}" placeholder="${esc(t('name_ph'))}">
        <label class="field-label" for="np-folder">${esc(t('category'))}</label>
        <select id="np-folder" class="field">${categoryOptions(S.pointFolder, active)}</select>
        <label class="field-label">${esc(t('location'))}</label>
        <div class="coords-box"><span id="np-coords">${prefill.lat.toFixed(6)}, ${prefill.lng.toFixed(6)}</span>
          <button type="button" class="btn btn-ghost btn-sm" id="np-repick">${ic('pin')}${esc(t('change_place'))}</button></div>
        <label class="field-label" for="np-desc">${esc(t('description'))}</label>
        <textarea id="np-desc" class="field" rows="5" placeholder="${esc(t('desc_ph'))}">${esc(prefill.description || '')}</textarea>
        <div class="field-hint">${esc(t('desc_hint'))}</div>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" id="np-cancel">${esc(t('cancel'))}</button>
          <button type="button" class="btn btn-primary" id="np-save">${ic('check')}${esc(t('save'))}</button>
        </div>`,
      onRender: body => {
        body.querySelector('#np-cancel').addEventListener('click', () => App.sheet.close(true));
        body.querySelector('#np-repick').addEventListener('click', () => {
          const keep = { name: body.querySelector('#np-name').value, description: body.querySelector('#np-desc').value };
          App.sheet.close(true);
          startPick(latlng => openAddPoint({ ...keep, lat: latlng.lat, lng: latlng.lng }));
        });
        body.querySelector('#np-save').addEventListener('click', async () => {
          const nameVal = body.querySelector('#np-name').value.trim();
          if (!nameVal) { App.toast(t('name_required')); return; }
          const id = 'new_pt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
          const now = new Date().toISOString();
          try {
            await saveOverride(active, id, {
              id, name: nameVal, folder: body.querySelector('#np-folder').value,
              description: body.querySelector('#np-desc').value.trim(),
              geometry: { type: 'Point', coordinates: { lat: prefill.lat, lng: prefill.lng } },
              style: {}, deleted: false, isNew: true, createdAt: now
            }, { action: 'create' });
            App.sheet.close(true);
            App.toast(t('point_added'));
            setTimeout(() => select(id), 80);
          } catch (err) { /* тост уже показан */ }
        });
      }
    });
  }

  function addPointInZone(groupId) {
    const g = findGroup(groupId);
    if (!g) return;
    App.sheet.close(true);
    const z = g.zones[0];
    openAddPoint({ lat: z.center.lat, lng: z.center.lng, name: z.name, description: plainText(z.description) });
  }

  // ===== Рисование новой зоны =====
  function openAddZone() {
    if (!isAdmin()) { App.toast(t('need_admin')); return; }
    App.drawer.close();
    App.sheet.close(true);
    closeCard();
    tool = { type: 'draw', vertices: [], onCancel: () => App.map.doubleClickZoom.enable() };
    // Двойной клик завершает зону, а не приближает карту
    App.map.doubleClickZoom.disable();
    App.map.getContainer().classList.add('crosshair');
    renderToolbar();
    App.toast(t('draw_hint'));
  }

  function onDrawDblClick() {
    if (!tool || tool.type !== 'draw') return;
    // dblclick приходит после двух click — второй дублирует вершину
    const v = tool.vertices;
    if (v.length >= 2) {
      const a = v[v.length - 1], b = v[v.length - 2];
      if (Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lng - b.lng) < 1e-7) v.pop();
    }
    if (v.length >= 3) finishDraw(); else { drawPreview(); renderToolbar(); }
  }

  function drawPreview() {
    layers.draft.clearLayers();
    const v = tool.vertices;
    if (v.length >= 2) layers.draft.addLayer(L.polygon(v.map(p => [p.lat, p.lng]), { color: '#3BA982', weight: 3, dashArray: '8 6', fillColor: '#3BA982', fillOpacity: 0.2, interactive: false }));
    v.forEach(p => layers.draft.addLayer(L.circleMarker([p.lat, p.lng], { radius: 6, color: '#fff', weight: 2, fillColor: '#3BA982', fillOpacity: 1, interactive: false })));
  }

  function finishDraw() {
    const vertices = tool.vertices.slice();
    if (vertices.length < 3) { App.toast(t('draw_min')); return; }
    tool = null;
    App.map.doubleClickZoom.enable();
    App.map.getContainer().classList.remove('crosshair');
    renderToolbar();
    const S = SECTIONS[active];
    App.sheet.open({
      title: t('add_zone_title'),
      key: 'add-zone',
      html: `
        <label class="field-label" for="nz-name">${esc(t('name_label'))}</label>
        <input id="nz-name" class="field" placeholder="${esc(t('name_ph'))}">
        <label class="field-label" for="nz-folder">${esc(t('category'))}</label>
        <select id="nz-folder" class="field">${categoryOptions(S.zoneFolder, active)}</select>
        <label class="field-label" for="nz-desc">${esc(t('description'))}</label>
        <textarea id="nz-desc" class="field" rows="5" placeholder="${esc(t('desc_ph'))}"></textarea>
        <div class="field-hint">${esc(t('desc_hint'))}</div>
        <label class="switch-row"><input type="checkbox" id="nz-point" checked><span class="switch"></span><span>${esc(t('zone_add_icon'))}</span></label>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" id="nz-cancel">${esc(t('cancel'))}</button>
          <button type="button" class="btn btn-primary" id="nz-save">${ic('check')}${esc(t('save'))}</button>
        </div>`,
      onClose: () => layers.draft.clearLayers(),
      onRender: body => {
        body.querySelector('#nz-cancel').addEventListener('click', () => App.sheet.close(true));
        body.querySelector('#nz-save').addEventListener('click', async () => {
          const name = body.querySelector('#nz-name').value.trim();
          if (!name) { App.toast(t('name_required')); return; }
          const folder = body.querySelector('#nz-folder').value;
          const description = body.querySelector('#nz-desc').value.trim();
          const now = new Date().toISOString();
          const id = 'new_zone_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
          const geometry = { type: 'Polygon', coordinates: [vertices] };
          try {
            await saveOverride(active, id, { id, name, folder, description, geometry, style: {}, deleted: false, isNew: true, createdAt: now }, { action: 'create' });
            if (body.querySelector('#nz-point').checked) {
              const c = centerOf(geometry);
              const pid = 'new_pt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
              await saveOverride(active, pid, { id: pid, name, folder: S.pointFolder, description: '', geometry: { type: 'Point', coordinates: c }, style: {}, deleted: false, isNew: true, createdAt: now }, { action: 'create' });
            }
            layers.draft.clearLayers();
            App.sheet.close(true);
            App.toast(t('zone_added'));
            setTimeout(() => select(id), 80);
          } catch (err) { /* тост уже показан */ }
        });
      }
    });
  }

  // ===== Перемещение точки и правка границ =====
  function startMovePoint(groupId) {
    const g = findGroup(groupId);
    if (!g || !g.point) return;
    App.sheet.close(true);
    closeCard();
    const marker = L.marker([g.center.lat, g.center.lng], { icon: pinIcon('#FFFFFF', { selected: true }), draggable: true, zIndexOffset: 2000 });
    layers.draft.addLayer(marker);
    const original = markers.get(g.id);
    if (original) layers.points.removeLayer(original);
    tool = {
      type: 'move',
      onSave: async () => {
        const ll = marker.getLatLng();
        const before = currentValues(g.section, g.point.id, ['geometry']);
        cancelTool();
        try {
          await saveOverride(g.section, g.point.id, { geometry: { type: 'Point', coordinates: { lat: ll.lat, lng: ll.lng } } }, { action: 'move' });
          App.toast(t('saved'), { action: { label: t('undo'), fn: () => revertChange(g.section, g.point.id, before) } });
          select(g.id, { fly: false });
        } catch (err) { /* тост уже показан */ }
      }
    };
    renderToolbar();
  }

  function startEditVertices(groupId) {
    const g = findGroup(groupId);
    if (!g || g.zones.length !== 1 || g.zones[0].geometry.type !== 'Polygon') return;
    const zone = g.zones[0];
    App.sheet.close(true);
    closeCard();
    let ring = zone.geometry.coordinates[0].map(p => ({ lat: p.lat, lng: p.lng }));
    // KML-кольца часто замкнуты (последняя вершина = первая) — для правки убираем дубль
    if (ring.length > 3) { const a = ring[0], b = ring[ring.length - 1]; if (a.lat === b.lat && a.lng === b.lng) ring.pop(); }
    const poly = zoneLayers.get(zone.id);
    if (poly) layers.zones.removeLayer(poly);
    const handleIcon = cls => L.divIcon({ className: 'vx-wrap', html: `<span class="${cls}"></span>`, iconSize: [22, 22], iconAnchor: [11, 11] });

    const redraw = () => {
      layers.draft.clearLayers();
      const shape = L.polygon(ring.map(p => [p.lat, p.lng]), { color: '#FFFFFF', weight: 3, fillColor: '#3BA982', fillOpacity: 0.22, interactive: false });
      layers.draft.addLayer(shape);
      ring.forEach((p, i) => {
        const h = L.marker([p.lat, p.lng], { icon: handleIcon('vx'), draggable: true, zIndexOffset: 2000 });
        h.on('drag', e => { ring[i] = { lat: e.latlng.lat, lng: e.latlng.lng }; shape.setLatLngs(ring.map(q => [q.lat, q.lng])); });
        h.on('dragend', redraw);
        h.on('dblclick', e => { L.DomEvent.stop(e); if (ring.length > 3) { ring.splice(i, 1); redraw(); } else App.toast(t('draw_min')); });
        layers.draft.addLayer(h);
        const n = ring[(i + 1) % ring.length];
        const mid = L.marker([(p.lat + n.lat) / 2, (p.lng + n.lng) / 2], { icon: handleIcon('vx vx-mid'), zIndexOffset: 1900 });
        mid.on('click', e => { L.DomEvent.stop(e); ring.splice(i + 1, 0, { lat: (p.lat + n.lat) / 2, lng: (p.lng + n.lng) / 2 }); redraw(); });
        layers.draft.addLayer(mid);
      });
    };
    redraw();
    tool = {
      type: 'vertices',
      onSave: async () => {
        const before = currentValues(g.section, zone.id, ['geometry']);
        const geometry = { type: 'Polygon', coordinates: [ring.concat([ring[0]])] };
        cancelTool();
        try {
          await saveOverride(g.section, zone.id, { geometry }, { action: 'geometry' });
          App.toast(t('saved'), { action: { label: t('undo'), fn: () => revertChange(g.section, zone.id, before) } });
          select(g.id, { fly: false });
        } catch (err) { /* тост уже показан */ }
      }
    };
    renderToolbar();
  }

  // ===== Редактирование =====
  function categoryOptions(current, sec) {
    const cats = SECTIONS[sec].categories.slice();
    if (current && !cats.includes(current)) cats.unshift(current); // никогда не меняем категорию «молча»
    return cats.map(c => `<option value="${esc(c)}" ${c === current ? 'selected' : ''}>${esc(App.localizeData(c))}</option>`).join('');
  }

  function editableText(m) { return plainText(m.description); }

  function openEditor(groupId) {
    const g = findGroup(groupId);
    if (!g || !isAdmin()) return;
    const people = [...assignees.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const members = g.members;
    const html = `
      <div class="form-section">
        <label class="field-label" for="ed-name">${esc(g.point ? t('name_point') : t('name_label'))}</label>
        <input id="ed-name" class="field" value="${esc(g.primary.name)}">
        <label class="field-label" for="ed-folder">${esc(t('category'))}</label>
        <select id="ed-folder" class="field">${categoryOptions(g.primary.folder, g.section)}</select>
        <label class="field-label" for="ed-person">${esc(t('assignee'))}</label>
        <select id="ed-person" class="field">
          <option value="">${esc(t('not_assigned'))}</option>
          ${people.map(p => `<option value="${esc(p.id)}" ${g.assigneeId === p.id ? 'selected' : ''}>${esc(p.name)}${p.phone ? ' · ' + esc(p.phone) : ''}</option>`).join('')}
        </select>
        <label class="field-label">${esc(t('object_color'))}</label>
        ${colorSwatchesHtml(g.color)}
        <div class="field-hint">${esc(t('object_color_hint'))}</div>
      </div>
      <div class="form-section">
        <div class="form-section-title">${ic('move')}${esc(t('location'))}</div>
        <div class="coords-box"><span>${g.center.lat.toFixed(6)}, ${g.center.lng.toFixed(6)}</span></div>
        <div class="desc-tools">
          ${g.point ? `<button type="button" class="btn btn-secondary btn-sm" id="ed-move">${ic('move')}${esc(t('move_point'))}</button>` : ''}
          ${g.zones.length === 1 && g.zones[0].geometry.type === 'Polygon' ? `<button type="button" class="btn btn-secondary btn-sm" id="ed-bounds">${ic('polygon')}${esc(t('edit_bounds'))}</button>` : ''}
          ${!g.point ? `<button type="button" class="btn btn-secondary btn-sm" id="ed-add-icon">${ic('pin')}${esc(t('add_icon_here'))}</button>` : ''}
        </div>
      </div>
      ${members.map(m => `
        <div class="form-section">
          <div class="form-section-title">${ic(m.kind === 'point' ? 'pin' : 'polygon')}${esc(m.kind === 'point' ? t('desc_point') : t('desc_zone'))}</div>
          ${m.kind === 'zone' && g.point ? `
            <label class="field-label" for="ed-zname-${esc(m.id)}">${esc(t('name_zone'))}</label>
            <input id="ed-zname-${esc(m.id)}" class="field" data-zname="${esc(m.id)}" value="${esc(m.name)}">` : ''}
          <label class="field-label" for="ed-desc-${esc(m.id)}">${esc(t('description'))}</label>
          <textarea id="ed-desc-${esc(m.id)}" class="field autogrow" data-desc="${esc(m.id)}" rows="5">${esc(editableText(m))}</textarea>
          <div class="desc-tools">
            <button type="button" class="btn btn-ghost btn-sm" data-insert="${esc(m.id)}" data-line="${esc(t('ins_cadastre'))}">${ic('plus')}${esc(t('ins_cadastre_btn'))}</button>
            <button type="button" class="btn btn-ghost btn-sm" data-insert="${esc(m.id)}" data-line="${esc(t('ins_area'))}">${ic('plus')}${esc(t('ins_area_btn'))}</button>
            ${m.baseDescription && plainText(m.baseDescription) !== editableText(m) ? `<button type="button" class="btn btn-ghost btn-sm" data-restore="${esc(m.id)}">${ic('undo')}${esc(t('restore_original'))}</button>` : ''}
          </div>
        </div>`).join('')}
      <div class="field-hint">${esc(t('desc_hint'))}</div>
      <div class="form-actions sticky">
        <button type="button" class="btn btn-secondary" id="ed-cancel">${esc(t('cancel'))}</button>
        <button type="button" class="btn btn-primary" id="ed-save">${ic('check')}${esc(t('save'))}</button>
      </div>`;

    let dirty = false;
    App.sheet.open({
      title: t('edit_title'),
      key: 'edit',
      html,
      guard: async () => !dirty || App.confirmDialog(t('unsaved_confirm'), { ok: t('discard'), danger: true }),
      onRender: body => {
        body.addEventListener('input', () => { dirty = true; });
        const grow = ta => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 420) + 'px'; };
        body.querySelectorAll('textarea.autogrow').forEach(ta => { grow(ta); ta.addEventListener('input', () => grow(ta)); });
        body.querySelectorAll('[data-insert]').forEach(btn => btn.addEventListener('click', () => {
          const ta = body.querySelector(`[data-desc="${CSS.escape(btn.dataset.insert)}"]`);
          ta.value = (ta.value.trim() ? ta.value.trimEnd() + '\n' : '') + btn.dataset.line;
          ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); grow(ta); dirty = true;
        }));
        body.querySelectorAll('[data-restore]').forEach(btn => btn.addEventListener('click', () => {
          const m = members.find(x => x.id === btn.dataset.restore);
          const ta = body.querySelector(`[data-desc="${CSS.escape(m.id)}"]`);
          ta.value = plainText(m.baseDescription); grow(ta); dirty = true;
          App.toast(t('restore_original_hint'));
        }));
        let colorValue = g.color || '';
        bindColorSwatches(body, v => { colorValue = v; dirty = true; });
        const geoBtn = (id, fn) => { const el = body.querySelector(id); if (el) el.addEventListener('click', async () => { if (await App.sheet.close()) fn(g.id); }); };
        geoBtn('#ed-move', startMovePoint);
        geoBtn('#ed-bounds', startEditVertices);
        geoBtn('#ed-add-icon', addPointInZone);
        body.querySelector('#ed-cancel').addEventListener('click', () => App.sheet.close());
        body.querySelector('#ed-save').addEventListener('click', async () => {
          const name = body.querySelector('#ed-name').value.trim().replace(/\s+/g, ' ');
          if (!name) { App.toast(t('name_required')); return; }
          const changes = new Map(); // featureId → change
          const add = (id, k, v) => { if (!changes.has(id)) changes.set(id, {}); changes.get(id)[k] = v; };
          if (name !== g.primary.name) add(g.primary.id, 'name', name);
          const folder = body.querySelector('#ed-folder').value;
          if (folder !== g.primary.folder) add(g.primary.id, 'folder', folder);
          if ((colorValue || null) !== (g.color || null)) add(g.primary.id, 'color', colorValue || DELETE);
          let emptied = false;
          members.forEach(m => {
            const zn = body.querySelector(`[data-zname="${CSS.escape(m.id)}"]`);
            if (zn && zn.value.trim() && zn.value.trim() !== m.name) add(m.id, 'name', zn.value.trim());
            const text = body.querySelector(`[data-desc="${CSS.escape(m.id)}"]`).value.replace(/\r/g, '').split('\n').map(s => s.trimEnd()).join('\n').trim();
            if (text === editableText(m)) return;
            if (!text) { add(m.id, 'descriptionHidden', true); add(m.id, 'description', DELETE); }
            else if (m.descriptionHidden) add(m.id, 'descriptionHidden', DELETE);
            if (!text && editableText(m)) emptied = true;
            // Совпадает с исходным описанием из KML — просто убираем правку
            if (!text) return;
            if (text === plainText(m.baseDescription) && m.overrideDescription != null) add(m.id, 'description', DELETE);
            else if (text !== plainText(m.baseDescription) || m.overrideDescription != null) add(m.id, 'description', text.replace(/\n/g, '<br>'));
          });
          if (emptied && !(await App.confirmDialog(t('desc_empty_confirm'), { danger: true, ok: t('save') }))) return;
          const personId = body.querySelector('#ed-person').value || null;
          const personChanged = personId !== (g.assigneeId || null);
          if (!changes.size && !personChanged) { dirty = false; App.sheet.close(true); select(g.id, { fly: false, details: true }); return; }
          const befores = [...changes.entries()].map(([id, ch]) => ({ id, before: currentValues(g.section, id, Object.keys(ch)) }));
          try {
            await Promise.all([...changes.entries()].map(([id, ch]) => saveOverride(g.section, id, ch, { action: 'update' })));
            if (personChanged) await setAssignee(findGroup(g.id, g.section) || g, personId, true);
            dirty = false;
            App.sheet.close(true);
            select(g.id, { fly: false, details: true });
            App.toast(t('saved'), { action: { label: t('undo'), fn: () => befores.forEach(b => revertChange(g.section, b.id, b.before)) } });
          } catch (err) { /* тост уже показан */ }
        });
      }
    });
  }

  // ===== Цвет объекта (задаёт админ) =====
  function colorSwatchesHtml(current) {
    const cur = (current || '').toUpperCase();
    return `<div class="swatches swatches-sm" data-swatches>
      <button type="button" class="swatch swatch-auto ${cur ? '' : 'active'}" data-c="" title="${esc(t('color_auto'))}">${ic('undo')}</button>
      ${OBJECT_COLORS.map(c => `<button type="button" class="swatch ${cur === c.toUpperCase() ? 'active' : ''}" data-c="${c}" style="background:${c}" aria-label="${c}"></button>`).join('')}
      <label class="swatch swatch-custom" title="${esc(t('custom_color'))}">${ic('plus')}<input type="color" value="${esc(current || '#2A9D8F')}"></label>
    </div>`;
  }

  function bindColorSwatches(root, onPick) {
    const box = root.querySelector('[data-swatches]');
    if (!box) return;
    const mark = v => box.querySelectorAll('.swatch[data-c]').forEach(s => s.classList.toggle('active', s.dataset.c.toUpperCase() === (v || '').toUpperCase()));
    box.querySelectorAll('.swatch[data-c]').forEach(s => s.addEventListener('click', () => { mark(s.dataset.c); onPick(s.dataset.c); }));
    box.querySelector('input[type=color]').addEventListener('input', e => { const v = e.target.value.toUpperCase(); mark(v); onPick(v); });
  }

  async function pickObjectColor(groupId) {
    const g = findGroup(groupId);
    if (!g || !isAdmin()) return;
    let value = g.color || '';
    const ok = await App.dialog({
      title: t('object_color'),
      html: `<p class="dialog-text muted">${esc(shortAddress(g.name))}</p>${colorSwatchesHtml(g.color)}<div class="field-hint">${esc(t('object_color_hint'))}</div>`,
      onOpen: root => bindColorSwatches(root, v => { value = v; }),
      dismissValue: false,
      actions: [{ label: t('cancel'), value: false }, { label: t('save'), kind: 'primary', value: true }]
    });
    if (!ok || (value || null) === (g.color || null)) return;
    const before = currentValues(g.section, g.primary.id, ['color']);
    saveOverride(g.section, g.primary.id, { color: value || DELETE }, { action: 'update' })
      .then(() => App.toast(t('saved'), { action: { label: t('undo'), fn: () => revertChange(g.section, g.primary.id, before) } }))
      .catch(() => { });
  }

  async function deleteGroup(groupId) {
    const g = findGroup(groupId);
    if (!g) return;
    const ok = await App.dialog({
      title: t('delete_title'),
      html: `<p class="dialog-text">${esc(t('delete_text', { name: shortAddress(g.name) }))}</p>
        <div class="choice-list">${g.members.map(m => `
          <label class="choice"><input type="checkbox" value="${esc(m.id)}" checked>
          <span>${ic(m.kind === 'point' ? 'pin' : 'polygon')}<b>${esc(m.kind === 'point' ? t('member_point') : t('member_zone'))}</b><em>${esc(m.name)}</em></span></label>`).join('')}</div>
        <p class="field-hint">${esc(t('delete_hint'))}</p>`,
      dismissValue: null,
      actions: [
        { label: t('cancel'), value: null },
        { label: t('delete'), kind: 'danger', value: root => [...root.querySelectorAll('input:checked')].map(i => i.value) }
      ]
    });
    if (!ok || !ok.length) return;
    try {
      await Promise.all(ok.map(id => saveOverride(g.section, id, { deleted: true }, { action: 'delete' })));
      App.sheet.close(true);
      closeCard();
      App.toast(t('deleted'), { action: { label: t('undo'), fn: () => ok.forEach(id => saveOverride(g.section, id, { deleted: false }, { action: 'restore' }).catch(() => { })) } });
    } catch (err) { /* тост уже показан */ }
  }

  // ===== Журнал изменений =====
  const ACTION_KEYS = { update: 'act_update', create: 'act_create', delete: 'act_delete', restore: 'act_restore', assign: 'act_assign', tasks: 'act_tasks', photo: 'act_photo', 'photo-delete': 'act_photo_delete', move: 'act_move', geometry: 'act_geometry', undo: 'act_undo', 'repair-description': 'act_repair', 'person-create': 'act_person', 'person-update': 'act_person', 'person-delete': 'act_person_delete' };

  function changeSummary(entry) {
    const fields = Object.keys(entry.after || {}).filter(k => !['updatedAt', 'updatedBy'].includes(k));
    const names = { name: t('f_name'), description: t('f_description'), folder: t('f_folder'), assigneeId: t('f_assignee'), tasks: t('f_tasks'), geometry: t('f_geometry'), deleted: t('f_deleted'), photo1Url: t('f_photo'), photo2Url: t('f_photo') };
    return [...new Set(fields.map(f => names[f] || f))].join(', ');
  }

  function entryHtml(e, withObject) {
    const g = withObject && e.section && SECTIONS[e.section] ? findGroup(e.featureId, e.section) : null;
    const canRestore = e.before && Object.prototype.hasOwnProperty.call(e.before, 'description');
    return `<div class="log-item">
      <div class="log-top"><b>${esc(t(ACTION_KEYS[e.action] || 'act_update'))}</b><span>${esc(App.formatDate(e.at || e.atIso))}</span></div>
      ${withObject ? `<div class="log-obj">${esc(g ? shortAddress(g.name) : e.featureId || '')}</div>` : ''}
      <div class="log-meta">${esc(changeSummary(e))}${e.by ? ' · ' + esc(e.by) : ''}</div>
      ${canRestore ? `<details class="log-details"><summary>${esc(t('show_before'))}</summary><pre>${esc(e.before.description == null ? t('restore_original') : plainText(e.before.description))}</pre>
        <button type="button" class="btn btn-secondary btn-sm" data-restore-log="${esc(e._id)}">${ic('undo')}${esc(t('restore_this'))}</button></details>` : ''}
      ${withObject && g ? `<button type="button" class="btn btn-ghost btn-sm" data-open="${esc(g.id)}" data-sec="${esc(e.section)}">${ic('eye')}${esc(t('open'))}</button>` : ''}
    </div>`;
  }

  async function loadLog(query) {
    const snap = await query.get();
    const list = [];
    snap.forEach(doc => list.push({ _id: doc.id, ...doc.data() }));
    list.sort((a, b) => String(b.atIso || '').localeCompare(String(a.atIso || '')));
    return list;
  }

  function bindLog(body, list) {
    body.querySelectorAll('[data-restore-log]').forEach(btn => btn.addEventListener('click', async () => {
      const e = list.find(x => x._id === btn.dataset.restoreLog);
      if (!e || !(await App.confirmDialog(t('restore_confirm')))) return;
      const before = { description: e.before.description };
      if (Object.prototype.hasOwnProperty.call(e.before, 'descriptionHidden')) before.descriptionHidden = e.before.descriptionHidden;
      else before.descriptionHidden = null;
      revertChange(e.section, e.featureId, before, 'restore')
        .then(() => App.toast(t('restored'))).catch(() => { });
    }));
    body.querySelectorAll('[data-open]').forEach(btn => btn.addEventListener('click', () => {
      if (btn.dataset.sec !== active) switchSection(btn.dataset.sec);
      App.sheet.close(true);
      select(btn.dataset.open);
    }));
  }

  async function openHistory(groupId) {
    const g = findGroup(groupId);
    if (!g) return;
    App.sheet.open({ title: t('history'), key: 'history', html: `<div class="muted">${esc(t('loading'))}</div>` });
    try {
      const list = (await loadLog(App.fb.db.collection('audit_log').where('featureId', 'in', g.memberIds.slice(0, 10)))).filter(e => e.section === g.section);
      App.sheet.set(`
        <div class="detail-head"><h2 class="detail-title">${esc(shortAddress(g.name))}</h2></div>
        ${list.length ? list.map(e => entryHtml(e, false)).join('') : `<div class="empty">${esc(t('history_empty'))}</div>`}
        <button type="button" class="btn btn-secondary wide" id="hist-back">${ic('chevronRight')}${esc(t('back_to_card'))}</button>`,
        body => { bindLog(body, list); body.querySelector('#hist-back').addEventListener('click', () => openDetails(g.id)); });
    } catch (err) {
      App.sheet.set(`<div class="notice notice-error">${esc(t('history_failed'))}</div>`);
    }
  }

  async function openAuditLog() {
    App.drawer.close();
    App.sheet.open({ title: t('audit_title'), key: 'audit', html: `<div class="muted">${esc(t('loading'))}</div>` });
    try {
      const list = await loadLog(App.fb.db.collection('audit_log').orderBy('at', 'desc').limit(150));
      App.sheet.set(list.length ? list.map(e => entryHtml(e, true)).join('') : `<div class="empty">${esc(t('history_empty'))}</div>`, body => bindLog(body, list));
    } catch (err) {
      App.sheet.set(`<div class="notice notice-error">${esc(t('history_failed'))}</div>`);
    }
  }

  // ===== Проверка данных: восстановление испорченных описаний =====
  function brokenOverrides() {
    const out = [];
    ['gis', 'repair'].forEach(sec => overrides[sec].forEach((ch, id) => {
      if (ch.description != null && !ch.deleted && isBrokenDescription(ch.description) && plainText(ch.description) !== '') out.push({ sec, id, ch });
    }));
    return out;
  }

  function openDataCheck() {
    App.drawer.close();
    const broken = brokenOverrides();
    const withBase = broken.filter(b => (SECTIONS[b.sec].data || []).some(f => f.id === b.id)).length;
    App.sheet.open({
      title: t('datacheck_title'),
      key: 'datacheck',
      html: `
        <div class="stat-card ${broken.length ? 'warn' : 'ok'}">
          <div class="stat-num">${broken.length}</div>
          <div class="stat-label">${esc(t('datacheck_broken'))}</div>
        </div>
        <p class="dialog-text">${esc(t('datacheck_explain'))}</p>
        ${broken.length ? `
          <p class="field-hint">${esc(t('datacheck_detail', { base: withBase, other: broken.length - withBase }))}</p>
          <button type="button" class="btn btn-primary wide" id="dc-fix">${ic('shield')}${esc(t('datacheck_fix', { n: broken.length }))}</button>` : `<div class="notice">${ic('check')}<span>${esc(t('datacheck_ok'))}</span></div>`}
        ${registryCheckHtml()}
        ${importedCheckHtml()}`,
      onRender: body => {
        bindRegistryCheck(body);
        bindImportedCheck(body);
        const btn = body.querySelector('#dc-fix');
        if (!btn) return;
        btn.addEventListener('click', async () => {
          if (!(await App.confirmDialog(t('datacheck_confirm', { n: broken.length })))) return;
          btn.disabled = true;
          let ok = 0;
          for (const b of broken) {
            try { await saveOverride(b.sec, b.id, { description: DELETE }, { action: 'repair-description' }); ok++; } catch (err) { /* продолжаем */ }
            btn.textContent = `${ok} / ${broken.length}`;
          }
          App.toast(t('datacheck_done', { n: ok }));
          openDataCheck();
        });
      }
    });
  }

  // ===== Сверка с реестром 133 детских площадок (playground-registry-data.js) =====
  // Примерные места для площадок, которых нет в KML (уточняются кнопкой «Изменить место»)
  const REGISTRY_HINTS = { '09-145-125-044': { lat: 50.05572, lng: 72.92740 } }; // ул. 8-е Марта, рядом с кв. 125

  function registryMissing() {
    const reg = Array.isArray(window.PLAYGROUND_REGISTRY) ? window.PLAYGROUND_REGISTRY : [];
    const onMap = new Set();
    model('gis').groups.filter(g => g.type === 'playground').forEach(g => g.cadastre.forEach(c => onMap.add(c)));
    return reg.filter(([, , cads]) => cads.length && !cads.some(c => onMap.has(c)));
  }

  function registryCheckHtml() {
    const reg = Array.isArray(window.PLAYGROUND_REGISTRY) ? window.PLAYGROUND_REGISTRY : [];
    if (!reg.length) return '';
    const missing = registryMissing();
    return `
      <div class="block-title dc-sep">${ic('list')}${esc(t('reg_title'))}</div>
      <div class="stat-card ${missing.length ? 'warn' : 'ok'}"><div class="stat-num">${reg.length - missing.length} / ${reg.length}</div>
        <div class="stat-label">${esc(t('reg_label'))}</div></div>
      ${missing.length ? missing.map(([n, name, cads, area]) => `
        <div class="sync-row bad">
          <div class="sync-main"><span class="sync-task">№${n}</span><b>${esc(name)}</b><em>${esc(cads.join(', '))} · ${area} м²</em></div>
          ${isAdmin() ? `<div class="sync-actions"><button type="button" class="btn btn-primary btn-sm" data-reg-add="${n}">${ic('plus')}${esc(t('reg_add'))}</button></div>` : ''}
        </div>`).join('') : `<div class="notice">${ic('check')}<span>${esc(t('reg_ok'))}</span></div>`}`;
  }

  function bindRegistryCheck(body) {
    body.querySelectorAll('[data-reg-add]').forEach(btn => btn.addEventListener('click', () => {
      const row = (window.PLAYGROUND_REGISTRY || []).find(r => r[0] === +btn.dataset.regAdd);
      if (!row) return;
      const [, name, cads, area] = row;
      if (active !== 'gis') switchSection('gis');
      // Место: известная подсказка → ближайший дом из индекса по адресу → центр города
      let place = REGISTRY_HINTS[cads[0]];
      if (!place) {
        const hit = App.registry.search(name, 1)[0];
        place = hit ? hit.center : { lat: App.CENTER[0], lng: App.CENTER[1] };
      }
      App.sheet.close(true);
      App.map.setView([place.lat, place.lng], 18);
      openAddPoint({
        lat: place.lat, lng: place.lng, name: `Площадка: ${name}`,
        description: `Кадастровый номер: ${cads.join(', ')}\nПлощадь: ${area} кв.м\nНазначение: для благоустройства и установки детских площадок`
      });
      App.toast(t('reg_add_hint'), { duration: 6000 });
    }));
  }

  // Площадки, которые импорт-тул РВР скопировал в ГИС (из-за них площадок больше, чем в реестре)
  function importedCheckHtml() {
    const groups = model('gis').groups.filter(g => g.imported);
    const playgrounds = model('gis').groups.filter(g => g.type === 'playground');
    return `
      <div class="block-title dc-sep">${ic('pin')}${esc(t('dc_count_title'))}</div>
      <div class="stat-card"><div class="stat-num">${playgrounds.length - groups.length} + ${groups.length}</div>
        <div class="stat-label">${esc(t('dc_count_label'))}</div></div>
      <p class="dialog-text">${esc(t('dc_imported_explain', { n: groups.length }))}</p>
      ${groups.length ? `
        <details class="sync-details"><summary>${esc(t('dc_imported_list', { n: groups.length }))}</summary>
          ${groups.map(g => `<button type="button" class="cat-item" data-open-g="${esc(g.id)}"><span class="cat-dot" style="background:${TYPE_COLORS.playground}"></span><span class="cat-text"><b>${esc(g.name)}</b><em>${esc(g.id)}</em></span>${ic('chevronRight', 'cat-chev')}</button>`).join('')}
        </details>
        <button type="button" class="btn btn-danger-outline wide" id="dc-imported">${ic('trash')}${esc(t('dc_imported_delete', { n: groups.length }))}</button>
        <p class="field-hint">${esc(t('dc_imported_hint'))}</p>` : ''}`;
  }

  function bindImportedCheck(body) {
    body.querySelectorAll('[data-open-g]').forEach(el => el.addEventListener('click', () => {
      if (active !== 'gis') switchSection('gis');
      App.sheet.close(true);
      select(el.dataset.openG);
    }));
    const btn = body.querySelector('#dc-imported');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const groups = model('gis').groups.filter(g => g.imported);
      if (!(await App.confirmDialog(t('dc_imported_confirm', { n: groups.length }), { danger: true, ok: t('delete') }))) return;
      btn.disabled = true;
      // «Мягкое» удаление (deleted: true) — вернуть можно через журнал изменений
      const ids = groups.flatMap(g => g.members.filter(m => m.isNew).map(m => m.id));
      let ok = 0;
      for (const id of ids) {
        try { await saveOverride('gis', id, { deleted: true }, { action: 'delete' }); ok++; } catch (err) { /* продолжаем */ }
      }
      App.toast(t('dc_imported_done', { n: ok }), { action: { label: t('undo'), fn: () => ids.forEach(id => saveOverride('gis', id, { deleted: false }, { action: 'restore' }).catch(() => { })) } });
      openDataCheck();
    });
  }

  // ===== Фильтры =====
  function openFilters() {
    App.sheet.open({ title: t('filters'), key: 'filters', html: filtersHtml(), onRender: bindFilters });
  }

  function filtersHtml() {
    const m = model();
    const counts = new Map();
    m.groups.forEach(g => { if (g.assigneeId) counts.set(g.assigneeId, (counts.get(g.assigneeId) || 0) + 1); });
    const people = [...assignees.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const assignedTotal = m.groups.filter(g => g.assigneeId && assignees.has(g.assigneeId)).length;
    const taskCounts = {};
    if (active === 'repair') {
      m.groups.forEach(g => {
        const st = taskState(g);
        st.keys.forEach(k => {
          taskCounts[k] = taskCounts[k] || { pending: 0, done: 0 };
          taskCounts[k][g.tasks[k] ? 'done' : 'pending']++;
        });
      });
    }
    const sw = (id, checked, label, hint) => `
      <label class="switch-row"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><span class="switch"></span>
      <span class="switch-text"><b>${esc(label)}</b>${hint ? `<em>${esc(hint)}</em>` : ''}</span></label>`;
    return `
      <section class="block">
        <div class="block-title">${ic('users')}${esc(t('f_assign_title'))}</div>
        ${sw('f-assign', filters.assignMode, t('f_assign'), t('f_assign_hint', { n: assignedTotal, total: m.groups.length }))}
        ${filters.assignMode ? `
          <div class="person-chips">
            <button type="button" class="pchip ${filters.assigneeIds.size ? '' : 'active'}" data-pchip="">${esc(t('everyone'))}</button>
            ${people.map(p => `<button type="button" class="pchip ${filters.assigneeIds.has(p.id) ? 'active' : ''}" data-pchip="${esc(p.id)}" style="--c:${esc(p.color)}"><i></i>${esc(p.name)}<em>${counts.get(p.id) || 0}</em></button>`).join('')}
          </div>
          ${people.length ? '' : `<div class="muted">${esc(t('no_assignees'))}</div>`}
          ${sw('f-only', filters.onlyAssigned, t('f_only_assigned'))}
          ${sw('f-plabels', filters.assigneeLabels, t('f_person_labels'), t('f_person_labels_hint'))}
        ` : ''}
        <button type="button" class="btn btn-ghost btn-sm" id="f-people">${ic('users')}${esc(t('assignees_open'))}</button>
      </section>
      ${active === 'gis' ? (() => {
        const kc = kindCounts();
        const imported = m.groups.filter(g => g.imported).length;
        return `
      <section class="block">
        <div class="block-title">${ic('grid')}${esc(t('f_kinds_title'))}</div>
        <div class="task-chips">
          ${['playground', 'square', 'zone'].map(k => `<button type="button" class="tchip kchip ${filters.kinds.has(k) ? 'active' : ''}" data-kind="${k}" style="--c:${TYPE_COLORS[k]}"><i></i><span>${esc(t('kind_' + k))}</span><em>${kc[k] || 0}</em></button>`).join('')}
        </div>
        ${imported ? sw('f-imported', filters.hideImported, t('f_hide_imported', { n: imported }), t('f_hide_imported_hint')) : ''}
      </section>`;
      })() : ''}
      ${active === 'repair' ? `
      <section class="block">
        <div class="block-title">${ic('list')}${esc(t('f_tasks_title'))}</div>
        ${sheetStatusHtml()}
        <div class="seg seg-full" role="radiogroup">
          ${['pending', 'done', 'all'].map(s => `<button type="button" class="${filters.taskStatus === s ? 'active' : ''}" data-tstatus="${s}">${esc(t('ts_' + s))}</button>`).join('')}
        </div>
        <div class="task-stats">
          ${Object.keys(TASKS).map(k => {
            const c = taskCounts[k] || { pending: 0, done: 0 };
            const total = c.pending + c.done;
            const n = filters.taskStatus === 'pending' ? c.pending : filters.taskStatus === 'done' ? c.done : total;
            const pct = total ? Math.round(c.done / total * 100) : 0;
            return `<button type="button" class="tstat ${filters.tasks.has(k) ? 'active' : ''}" data-task="${k}">
              <span class="tstat-top">${ic(TASKS[k].icon)}<b>${esc(t(TASKS[k].label))}</b><em>${n}</em></span>
              <span class="tstat-bar"><i style="width:${pct}%"></i></span>
              <span class="tstat-sub">${esc(t(TASKS[k].done))}: ${c.done} · ${esc(t(TASKS[k].pending))}: ${c.pending}</span>
            </button>`;
          }).join('')}
        </div>
        <div class="field-hint">${esc(t('f_tasks_hint'))}</div>
      </section>` : ''}
      <section class="block">
        <div class="block-title">${ic('tag')}${esc(t('f_labels_title'))}</div>
        ${sw('f-sectors', filters.showSectors, t('f_sectors'))}
        ${sw('f-alabels', filters.addressLabels, t('f_address_labels'))}
      </section>
      <button type="button" class="btn btn-secondary wide" id="f-reset">${ic('undo')}${esc(t('f_reset'))}</button>`;
  }

  function bindFilters(body) {
    const rerender = () => { saveFilters(); applyVisual(); App.sheet.set(filtersHtml(), bindFilters); };
    const chk = (id, fn) => { const el = body.querySelector('#' + id); if (el) el.addEventListener('change', () => { fn(el.checked); rerender(); }); };
    chk('f-assign', v => { filters.assignMode = v; });
    chk('f-only', v => { filters.onlyAssigned = v; });
    chk('f-plabels', v => { filters.assigneeLabels = v; });
    chk('f-alabels', v => { filters.addressLabels = v; });
    chk('f-imported', v => { filters.hideImported = v; });
    const sectors = body.querySelector('#f-sectors');
    if (sectors) sectors.addEventListener('change', () => { filters.showSectors = sectors.checked; saveFilters(); render(); App.sheet.set(filtersHtml(), bindFilters); updateCounters(); });
    body.querySelectorAll('[data-kind]').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.kind;
      if (filters.kinds.has(k)) filters.kinds.delete(k); else filters.kinds.add(k);
      rerender();
    }));
    bindSheetStatus(body);
    body.querySelectorAll('[data-pchip]').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.pchip;
      if (!id) filters.assigneeIds.clear();
      else if (filters.assigneeIds.has(id)) filters.assigneeIds.delete(id);
      else filters.assigneeIds.add(id);
      rerender();
    }));
    body.querySelectorAll('[data-task]').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.task;
      if (filters.tasks.has(k)) filters.tasks.delete(k); else filters.tasks.add(k);
      rerender();
    }));
    body.querySelectorAll('[data-tstatus]').forEach(b => b.addEventListener('click', () => { filters.taskStatus = b.dataset.tstatus; rerender(); }));
    body.querySelector('#f-people').addEventListener('click', openAssignees);
    body.querySelector('#f-reset').addEventListener('click', () => {
      filters.assignMode = false; filters.assigneeIds.clear(); filters.onlyAssigned = false; filters.assigneeLabels = true;
      filters.addressLabels = false; filters.tasks.clear(); filters.taskStatus = 'pending';
      filters.kinds = new Set(['playground', 'square', 'zone']); filters.hideImported = false;
      const sectorsWereOff = !filters.showSectors;
      filters.showSectors = true;
      if (sectorsWereOff) render();
      rerender();
    });
  }

  // ===== Google-таблица РВР: статус и сверка =====
  function sheetUnmatched() {
    const s = model('repair').sheet;
    return s ? s.rows.filter(r => !r.ids.length && !r.ignored).length : 0;
  }

  function sheetStatusHtml() {
    const S = App.sheetSync;
    if (!S) return '';
    const st = S.state;
    const m = model('repair');
    const rows = m.sheet ? m.sheet.rows : [];
    const unmatched = rows.filter(r => !r.ids.length && !r.ignored).length;
    let text;
    if (st.status === 'loading') text = t('sheet_loading');
    else if (st.status === 'error') text = t('sheet_error') + (st.error ? ` (${st.error})` : '');
    else if (st.status === 'ok') text = t(st.fromCache ? 'sheet_cached' : 'sheet_ok', { time: App.formatDate(st.at) });
    else text = t('sheet_loading');
    return `<div class="sheet-status ${st.status === 'error' ? 'error' : st.fromCache ? 'warn' : ''}">
      ${ic('grid')}<span><b>${esc(t('sheet_title'))}</b><em>${esc(text)}</em>${unmatched && isAdmin() ? `<em class="warn-text">${esc(t('sheet_unmatched', { n: unmatched }))}</em>` : ''}</span>
      <button type="button" class="icon-btn icon-btn-sm" data-sheet="reload" title="${esc(t('sheet_reload'))}" aria-label="${esc(t('sheet_reload'))}">${ic('undo')}</button>
    </div>
    <div class="row-actions sheet-actions">
      <a class="btn btn-ghost btn-sm" href="${esc(S.url)}" target="_blank" rel="noopener">${ic('external')}${esc(t('sheet_open'))}</a>
      ${isAdmin() && rows.length ? `<button type="button" class="btn btn-ghost btn-sm" data-sheet="report">${ic('list')}${esc(t('sheet_report'))}</button>` : ''}
    </div>`;
  }

  function bindSheetStatus(body) {
    body.querySelectorAll('[data-sheet="reload"]').forEach(b => b.addEventListener('click', () => App.sheetSync.load(true)));
    body.querySelectorAll('[data-sheet="report"]').forEach(b => b.addEventListener('click', openSheetReport));
  }

  // Сверка: какие строки таблицы на какие площадки легли, какие не нашлись
  function openSheetReport() {
    App.drawer.close();
    if (active !== 'repair') switchSection('repair');
    App.sheet.open({ title: t('sheet_report'), key: 'sheet-report', html: sheetReportHtml(), onRender: bindSheetReport });
  }

  function sheetReportHtml() {
    const m = model('repair');
    if (!m.sheet) return `<div class="notice notice-error">${ic('alert')}<span>${esc(t('sheet_error'))}</span></div>`;
    const rows = m.sheet.rows;
    const bad = rows.filter(r => !r.ids.length && !r.ignored);
    const ok = rows.filter(r => r.ids.length);
    const ignored = rows.filter(r => r.ignored);
    const name = id => { const g = findGroup(id, 'repair'); return g ? shortAddress(g.name) : id; };
    const rowHtml = (r, i) => `
      <div class="sync-row ${r.ids.length ? '' : 'bad'}">
        <div class="sync-main">
          <span class="sync-task">${ic(TASKS[r.task].icon)}${esc(t(TASKS[r.task].label))}</span>
          <b>${esc(r.raw)}</b>
          ${r.ids.length ? `<em>→ ${r.ids.map(id => esc(name(id))).join('; ')}${r.manual ? ' · ' + esc(t('sync_manual')) : ''}</em>` : `<em>${esc(r.ignored ? t('sync_ignored') : t('sync_not_found'))}</em>`}
        </div>
        ${isAdmin() ? `<div class="sync-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-link="${i}">${ic('pin')}${esc(t('sync_link'))}</button>
          ${r.manual || r.ignored ? `<button type="button" class="btn btn-ghost btn-sm" data-unlink="${i}">${ic('undo')}${esc(t('sync_auto'))}</button>`
            : !r.ids.length ? `<button type="button" class="btn btn-ghost btn-sm" data-ignore="${i}">${ic('x')}${esc(t('sync_ignore'))}</button>` : ''}
        </div>` : ''}
      </div>`;
    const indexed = rows.map((r, i) => ({ r, i }));
    return `
      <div class="stat-card ${bad.length ? 'warn' : 'ok'}"><div class="stat-num">${ok.length} / ${rows.length}</div><div class="stat-label">${esc(t('sync_matched'))}</div></div>
      <p class="field-hint">${esc(t('sync_explain'))}</p>
      ${bad.length ? `<div class="block-title">${ic('alert')}${esc(t('sync_bad_title', { n: bad.length }))}</div>${indexed.filter(x => !x.r.ids.length && !x.r.ignored).map(x => rowHtml(x.r, x.i)).join('')}` : ''}
      <details class="sync-details"><summary>${esc(t('sync_ok_title', { n: ok.length }))}</summary>${indexed.filter(x => x.r.ids.length).map(x => rowHtml(x.r, x.i)).join('')}</details>
      ${ignored.length ? `<details class="sync-details"><summary>${esc(t('sync_ignored_title', { n: ignored.length }))}</summary>${indexed.filter(x => x.r.ignored).map(x => rowHtml(x.r, x.i)).join('')}</details>` : ''}`;
  }

  function bindSheetReport(body) {
    const rows = () => (model('repair').sheet || { rows: [] }).rows;
    const done = p => p.then(() => App.toast(t('saved'))).catch(err => App.toast(err && err.code === 'permission-denied' ? t('save_denied') : t('save_failed'), { error: true }));
    body.querySelectorAll('[data-link]').forEach(b => b.addEventListener('click', () => {
      const r = rows()[+b.dataset.link];
      if (!r) return;
      // Привязка: закрываем панель, админ нажимает на нужную площадку
      App.sheet.close(true);
      tool = {
        type: 'link', row: r,
        onCancel: () => openSheetReport()
      };
      renderToolbar();
      App.toast(t('sync_link_hint', { name: r.raw }));
    }));
    body.querySelectorAll('[data-unlink]').forEach(b => b.addEventListener('click', () => { const r = rows()[+b.dataset.unlink]; if (r) done(App.sheetSync.setLink(r.key, null, false)); }));
    body.querySelectorAll('[data-ignore]').forEach(b => b.addEventListener('click', () => { const r = rows()[+b.dataset.ignore]; if (r) done(App.sheetSync.setLink(r.key, null, true)); }));
  }

  App.on('sheet', () => {
    invalidate('repair');
    if (active === 'repair') scheduleRefresh('repair');
    const key = App.sheet.key();
    if (key === 'filters') App.sheet.set(filtersHtml(), bindFilters);
    if (key === 'sheet-report') App.sheet.set(sheetReportHtml(), bindSheetReport);
  });

  // ===== Ответственные: список =====
  function openAssignees() {
    App.drawer.close();
    App.sheet.open({ title: t('assignees_title'), key: 'assignees', html: assigneesHtml(), onRender: bindAssignees });
  }

  function assigneesHtml() {
    const people = [...assignees.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const admin = isAdmin();
    return `
      ${admin ? `<button type="button" class="btn btn-primary wide" id="as-new">${ic('userPlus')}${esc(t('person_new'))}</button>` : ''}
      ${people.length ? people.map(p => {
        const nGis = groupsOfPerson(p.id, 'gis').length, nRep = groupsOfPerson(p.id, 'repair').length;
        return `
        <div class="person-card" style="--c:${esc(p.color)}">
          <div class="person-row">
            <span class="person-dot" style="background:${esc(p.color)}"></span>
            <div class="person-text"><b>${esc(p.name)}</b>${p.phone ? `<a href="${esc(telHref(p.phone))}">${esc(p.phone)}</a>` : ''}
              <em>${esc(t('section_gis'))}: ${nGis} · ${esc(t('section_repair'))}: ${nRep}</em></div>
          </div>
          <div class="person-actions">
            <button type="button" class="btn btn-secondary btn-sm" data-show="${esc(p.id)}">${ic('eye')}${esc(t('show_on_map'))}</button>
            <button type="button" class="btn btn-secondary btn-sm" data-snap="${esc(p.id)}">${ic('camera')}${esc(t('snapshot'))}</button>
            <button type="button" class="btn btn-secondary btn-sm" data-list="${esc(p.id)}">${ic('copy')}${esc(t('copy_list'))}</button>
            ${admin ? `
              <button type="button" class="btn btn-primary btn-sm" data-tool="${esc(p.id)}">${ic('pin')}${esc(t('assign_on_map'))}</button>
              <button type="button" class="icon-btn icon-btn-sm" data-edit="${esc(p.id)}" aria-label="${esc(t('edit'))}">${ic('edit')}</button>
              <button type="button" class="icon-btn icon-btn-sm danger" data-del="${esc(p.id)}" aria-label="${esc(t('delete'))}">${ic('trash')}</button>` : ''}
          </div>
        </div>`;
      }).join('') : `<div class="empty">${ic('users', 'empty-ic')}<p>${esc(t('no_assignees'))}</p>${admin ? '' : `<p class="muted">${esc(t('no_assignees_guest'))}</p>`}</div>`}`;
  }

  function bindAssignees(body) {
    const on = (sel, fn) => body.querySelectorAll(sel).forEach(el => el.addEventListener('click', () => fn(el)));
    const newBtn = body.querySelector('#as-new');
    if (newBtn) newBtn.addEventListener('click', async () => { await editPerson(); App.sheet.set(assigneesHtml(), bindAssignees); });
    on('[data-show]', el => showPersonOnMap(el.dataset.show));
    on('[data-snap]', el => exportPersonSnapshot(el.dataset.snap));
    on('[data-list]', el => {
      const p = assignees.get(el.dataset.list);
      const list = groupsOfPerson(p.id).map((g, i) => `${i + 1}. ${g.name}`);
      if (!list.length) { App.toast(t('person_no_objects')); return; }
      App.copyText(`${p.name}${p.phone ? ' · ' + p.phone : ''}\n${t(active === 'gis' ? 'section_gis' : 'section_repair')}: ${list.length}\n\n${list.join('\n')}`, t('list_copied', { n: list.length }));
    });
    on('[data-tool]', el => startAssignTool(el.dataset.tool));
    on('[data-edit]', async el => { await editPerson(el.dataset.edit); App.sheet.set(assigneesHtml(), bindAssignees); });
    on('[data-del]', async el => { await deletePerson(el.dataset.del); App.sheet.set(assigneesHtml(), bindAssignees); });
  }
  App.on('registry-refresh', () => { if (App.sheet.key() === 'assignees') App.sheet.set(assigneesHtml(), bindAssignees); });

  // ===== Каталог объектов =====
  const microGroupsCache = { key: null, list: null };
  function microdistricts() {
    // Сектора берём из раздела РВР (там подробная нарезка), как и раньше
    const sectors = model('repair').sectors.filter(f => f.geometry.type !== 'Point');
    return sectors.slice().sort((a, b) => (/^мкр/i.test(a.name) ? 0 : 1) - (/^мкр/i.test(b.name) ? 0 : 1) || a.name.localeCompare(b.name, 'ru'));
  }

  function groupByMicrodistrict(groups) {
    const polys = microdistricts();
    const out = new Map();
    const other = [];
    groups.forEach(g => {
      const poly = polys.find(p => inBbox(g.center.lat, g.center.lng, p.bbox) && pointInGeometry(g.center.lat, g.center.lng, p.geometry));
      if (poly) { if (!out.has(poly.name)) out.set(poly.name, []); out.get(poly.name).push(g); } else other.push(g);
    });
    const ordered = [];
    polys.forEach(p => { if (out.has(p.name)) ordered.push({ name: p.name, items: out.get(p.name) }); });
    if (other.length) ordered.push({ name: t('other_outside'), items: other, other: true });
    return ordered;
  }

  // ===== Поиск: с опечатками, по ответственному, по виду работ, по обоим разделам =====
  function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let best = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        best = Math.min(best, cur[j]);
      }
      if (best > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }

  // Текст для поиска: адрес, описание + ответственный, виды работ, тип
  function searchIndexOf(g) {
    const person = assigneeOf(g);
    const st = taskState(g);
    const extra = [
      person ? `${person.name} ${String(person.phone || '').replace(/\D/g, '')}` : '',
      st.keys.map(k => `${t(TASKS[k].label)} ${App._dict.ru[TASKS[k].label]}`).join(' '),
      t('kind_' + g.type + '_one'), App._dict.ru['kind_' + g.type + '_one'] || '',
      g.cadastre.map(c => c.replace(/\D/g, '')).join(' ')
    ].join(' ');
    const text = g.searchText + ' ' + App.normalizeSearch(extra);
    const name = App.normalizeSearch(g.name + ' ' + g.zoneName);
    return { text, name, words: [...new Set(text.split(' ').filter(w => w.length >= 4))] };
  }

  // 0 — точное совпадение в названии, 1 — где-то в тексте, 2 — с опечаткой, null — нет
  function termScore(idx, term) {
    if (idx.name.includes(term)) return 0;
    if (idx.text.includes(term)) return 1;
    if (term.length < 4 || /\d/.test(term)) return null;
    const max = term.length >= 7 ? 2 : 1;
    return idx.words.some(w => editDistance(term, w.slice(0, term.length), max) <= max) ? 2 : null;
  }

  function search(query, limit) {
    const terms = App.normalizeSearch(query).split(' ').filter(Boolean);
    if (!terms.length) return [];
    const results = [];
    [active, active === 'gis' ? 'repair' : 'gis'].forEach((sec, si) => {
      model(sec).groups.forEach(g => {
        const idx = searchIndexOf(g);
        let score = si * 10; // текущий раздел — выше
        for (const term of terms) {
          const s = termScore(idx, term);
          if (s === null) return;
          score += s;
        }
        if (idx.name.startsWith(terms[0])) score -= 0.5;
        results.push({ g, score });
      });
    });
    results.sort((a, b) => a.score - b.score || a.g.name.localeCompare(b.g.name, 'ru'));
    return results.slice(0, limit || 50).map(({ g }) => {
      const person = assigneeOf(g);
      const secLabel = g.section !== active ? ` · ${t(g.section === 'gis' ? 'section_gis' : 'section_repair')}` : '';
      return {
        id: g.id, section: g.section, title: g.name, center: g.center, color: g.section === active ? visualFor(g).color : baseColor(g),
        sub: (person ? person.name : t('kind_' + g.type + '_one')) + secLabel
      };
    });
  }

  function openCatalog(query = '') {
    App.drawer.close();
    closeCard();
    App.sheet.open({ title: t('catalog_title', { section: t(active === 'gis' ? 'section_gis' : 'section_repair') }), key: 'catalog', html: catalogShell(query), onRender: body => bindCatalog(body, query) });
  }

  function catalogShell(query) {
    const admin = isAdmin();
    return `
      <div class="catalog-top">
        <div class="stat-inline"><b id="cat-count">0</b><span>${esc(t('objects_in_section'))}</span></div>
        <div class="row-actions">
          <button type="button" class="btn btn-secondary btn-sm" id="cat-copy">${ic('copy')}${esc(t('copy_all'))}</button>
          <button type="button" class="btn btn-secondary btn-sm" id="cat-csv">${ic('download')}${esc(t('export_csv'))}</button>
          ${admin ? `<button type="button" class="btn btn-secondary btn-sm" id="cat-add-pt">${ic('pin')}${esc(t('add_point'))}</button>
          <button type="button" class="btn btn-secondary btn-sm" id="cat-add-zone">${ic('polygon')}${esc(t('add_zone'))}</button>` : ''}
        </div>
      </div>
      <div class="search-inline">${ic('search')}<input id="cat-search" class="field" type="search" placeholder="${esc(t('catalog_search_ph'))}" value="${esc(query)}"></div>
      <div id="cat-list"></div>`;
  }

  function catalogItems(query) {
    const terms = App.normalizeSearch(query).split(' ').filter(Boolean);
    if (!terms.length) return model().groups;
    // Тот же поиск, что и в верхней строке (с опечатками и по ответственному)
    const m = model();
    return m.groups.filter(g => terms.every(term => termScore(searchIndexOf(g), term) !== null));
  }

  function renderCatalogList(body, query) {
    const items = catalogItems(query);
    body.querySelector('#cat-count').textContent = items.length;
    const groups = groupByMicrodistrict(items);
    microGroupsCache.list = groups;
    body.querySelector('#cat-list').innerHTML = items.length ? groups.map((grp, gi) => `
      <div class="cat-group">
        <div class="cat-group-head">
          <span class="cat-group-name">${esc(App.localizeData(grp.name))}<em>${grp.items.length}</em></span>
          <button type="button" class="icon-btn icon-btn-sm" data-gcopy="${gi}" aria-label="${esc(t('copy_district'))}" title="${esc(t('copy_district'))}">${ic('copy')}</button>
          <button type="button" class="icon-btn icon-btn-sm" data-groute="${gi}" aria-label="${esc(t('route_yards'))}" title="${esc(t('route_yards'))}">${ic('route')}</button>
        </div>
        ${grp.items.map(g => {
          const vis = visualFor(g);
          const person = assigneeOf(g);
          const st = g.section === 'repair' ? taskState(g) : null;
          return `<button type="button" class="cat-item" data-id="${esc(g.id)}">
            <span class="cat-dot" style="background:${esc(vis.color)}"></span>
            <span class="cat-text"><b>${esc(App.localizeData(g.name))}</b>
              <em>${esc(App.localizeData(g.folder))}${person ? ' · ' + esc(person.name) : ''}${st && st.pending.length ? ' · ' + esc(t('pending_n', { n: st.pending.length })) : ''}</em></span>
            ${ic('chevronRight', 'cat-chev')}
          </button>`;
        }).join('')}
      </div>`).join('') : `<div class="empty">${esc(t('nothing_found'))}</div>`;
    App.hydrateIcons(body);
    body.querySelectorAll('.cat-item').forEach(el => el.addEventListener('click', () => { App.sheet.close(true); select(el.dataset.id); }));
    body.querySelectorAll('[data-gcopy]').forEach(el => el.addEventListener('click', () => {
      const grp = groups[+el.dataset.gcopy];
      copyAddresses(App.localizeData(grp.name), grp.items);
    }));
    body.querySelectorAll('[data-groute]').forEach(el => el.addEventListener('click', () => yardRoute(groups[+el.dataset.groute].items)));
  }

  function bindCatalog(body, query) {
    renderCatalogList(body, query);
    const input = body.querySelector('#cat-search');
    input.addEventListener('input', App.debounce(() => renderCatalogList(body, input.value), 150));
    body.querySelector('#cat-copy').addEventListener('click', () => copyAddresses(t('all_addresses'), catalogItems(input.value)));
    body.querySelector('#cat-csv').addEventListener('click', () => exportCsv(catalogItems(input.value)));
    const addPt = body.querySelector('#cat-add-pt');
    if (addPt) addPt.addEventListener('click', () => { App.sheet.close(true); openAddPoint(); });
    const addZone = body.querySelector('#cat-add-zone');
    if (addZone) addZone.addEventListener('click', openAddZone);
  }

  function copyAddresses(title, items) {
    const names = [...new Set(items.map(g => g.name.trim()).filter(Boolean))];
    if (!names.length) { App.toast(t('nothing_to_copy')); return; }
    const text = names.join('\n');
    App.dialog({
      title: `${title} (${names.length})`,
      html: `<textarea class="field mono" rows="12" readonly>${esc(text)}</textarea>`,
      onOpen: root => { const ta = root.querySelector('textarea'); ta.focus(); ta.select(); },
      actions: [{ label: t('close'), value: true }, { label: t('copy'), kind: 'primary', value: true, validate: () => { App.copyText(text, t('copied_n', { n: names.length })); return null; } }]
    });
  }

  function yardRoute(items) {
    const pts = items.map(g => g.center);
    if (!pts.length) return;
    if (pts.length === 1) { window.open(`https://www.google.com/maps/search/?api=1&query=${pts[0].lat},${pts[0].lng}`, '_blank'); return; }
    const o = pts[0], d = pts[pts.length - 1];
    const w = pts.slice(1, -1).slice(0, 8).map(p => `${p.lat},${p.lng}`).join('|');
    window.open(`https://www.google.com/maps/dir/?api=1&origin=${o.lat},${o.lng}&destination=${d.lat},${d.lng}&travelmode=walking${w ? '&waypoints=' + encodeURIComponent(w) : ''}`, '_blank');
  }

  function exportCsv(items) {
    const cell = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const head = [t('csv_section'), 'ID', t('csv_name'), t('csv_category'), t('csv_zone'), t('csv_cadastre'), t('csv_area'), t('csv_person'), t('csv_phone'), t('csv_tasks_pending'), t('csv_tasks_done'), t('csv_lat'), t('csv_lng'), t('csv_link')];
    const rows = items.map(g => {
      const p = assigneeOf(g);
      const st = taskState(g);
      return [t(g.section === 'gis' ? 'section_gis' : 'section_repair'), g.id, g.name, g.folder, g.zoneName, g.cadastre.join(', '), g.area, p ? p.name : '', p ? p.phone : '',
        st.pending.map(k => t(TASKS[k].label)).join(', '), st.done.map(k => t(TASKS[k].label)).join(', '),
        g.center.lat.toFixed(6), g.center.lng.toFixed(6), `${location.origin}${location.pathname}#${g.section}/${encodeURIComponent(g.id)}`];
    });
    // BOM + «;» — Excel в русской локали открывает такой файл без мастера импорта
    const csv = '﻿' + [head, ...rows].map(r => r.map(cell).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `temirtau-${active}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    App.toast(t('csv_done', { n: items.length }));
  }

  // ===== Разделы =====
  function switchSection(sec) {
    if (!SECTIONS[sec]) return;
    cancelTool();
    active = sec;
    store.set('section', sec);
    closeCard();
    if (App.sheet.isOpen() && !['assignees', 'audit', 'datacheck'].includes(App.sheet.key())) App.sheet.close(true);
    $$('.section-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.section === sec));
    document.body.dataset.section = sec;
    $('#search-input').placeholder = t(sec === 'gis' ? 'search_ph_gis' : 'search_ph_repair');
    render();
    updateCounters();
  }

  // ===== Меню: блок администратора =====
  function renderAdminMenu() {
    const box = $('#drawer-admin');
    if (!box) return;
    if (!App.auth.ready) { box.innerHTML = ''; return; }
    if (!isAdmin()) {
      box.innerHTML = `<button type="button" class="menu-item" id="m-login">${ic('lock')}<span>${esc(t('login_menu'))}</span>${ic('chevronRight', 'menu-chev')}</button>`;
      $('#m-login').addEventListener('click', () => { App.drawer.close(); App.login(); });
      return;
    }
    const broken = brokenOverrides().length;
    box.innerHTML = `
      <div class="menu-admin-head">${ic('shield')}<span><b>${esc(t('admin_mode'))}</b><em>${esc(App.auth.user && App.auth.user.email || '')}</em></span></div>
      <button type="button" class="menu-item" id="m-add-pt">${ic('pin')}<span>${esc(t('add_point'))}</span></button>
      <button type="button" class="menu-item" id="m-add-zone">${ic('polygon')}<span>${esc(t('add_zone'))}</span></button>
      <button type="button" class="menu-item" id="m-people">${ic('users')}<span>${esc(t('assignees_manage'))}</span></button>
      <button type="button" class="menu-item" id="m-sheet">${ic('grid')}<span>${esc(t('sheet_report'))}</span>${sheetUnmatched() ? `<em class="menu-badge warn">${sheetUnmatched()}</em>` : ''}</button>
      <button type="button" class="menu-item" id="m-check">${ic('shield')}<span>${esc(t('datacheck_title'))}</span>${broken ? `<em class="menu-badge warn">${broken}</em>` : ''}</button>
      <button type="button" class="menu-item" id="m-log">${ic('history')}<span>${esc(t('audit_title'))}</span></button>
      <button type="button" class="menu-item" id="m-logout">${ic('logout')}<span>${esc(t('logout'))}</span></button>`;
    $('#m-add-pt').addEventListener('click', () => openAddPoint());
    $('#m-add-zone').addEventListener('click', openAddZone);
    $('#m-people').addEventListener('click', openAssignees);
    $('#m-check').addEventListener('click', openDataCheck);
    $('#m-sheet').addEventListener('click', openSheetReport);
    $('#m-log').addEventListener('click', openAuditLog);
    $('#m-logout').addEventListener('click', () => { App.drawer.close(); App.logout(); });
  }

  function renderMenuCounts() {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('m-count-objects', model().groups.length);
    set('m-count-people', assignees.size);
  }

  function showDataWarning() {
    const missing = Object.values(SECTIONS).filter(S => !S.data || !S.data.length).map(S => S.dataFile);
    if (!missing.length) return;
    $('#data-warning-text').textContent = t('data_missing', { files: missing.join(', ') });
    $('#data-warning').classList.remove('hidden');
  }

  function openFromHash() {
    const m = location.hash.match(/^#(gis|repair)\/(.+)$/);
    if (!m) return false;
    const [, sec, id] = m;
    if (sec !== active) switchSection(sec);
    if (findGroup(decodeURIComponent(id))) { select(decodeURIComponent(id)); return true; }
    return false;
  }

  // ===== Инициализация =====
  App.on('ready', () => {
    setupLayers();
    document.body.dataset.section = active;
    $$('.section-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.section === active);
      tab.addEventListener('click', () => switchSection(tab.dataset.section));
    });
    $('#search-input').placeholder = t(active === 'gis' ? 'search_ph_gis' : 'search_ph_repair');
    $('#filter-btn').addEventListener('click', openFilters);
    $('#m-catalog').addEventListener('click', () => openCatalog());
    $('#m-people-list').addEventListener('click', openAssignees);
    $('#m-filters').addEventListener('click', () => { App.drawer.close(); openFilters(); });
    $('#m-csv').addEventListener('click', () => { App.drawer.close(); exportCsv(model().groups); });
    $('#object-count-btn').addEventListener('click', () => openCatalog());

    App.map.on('move zoom rotate', updateCardLine);
    App.map.on('dblclick', onDrawDblClick);
    window.addEventListener('resize', App.debounce(() => {
      if (!selectedId) return;
      $('#card').classList.toggle('docked', isMobile());
      updateCardLine();
    }, 100));

    showDataWarning();
    attachOverrides('gis');
    attachOverrides('repair');
    attachAssignees();
    render();
    updateCounters();
    // Ссылка на объект (#gis/gis-0001): ждём первые данные из базы
    let triedHash = false;
    const tryHash = () => { if (!triedHash && loaded.gis && loaded.repair) { triedHash = true; openFromHash(); } };
    App.on('data', tryHash);
    setTimeout(() => { if (!triedHash) { triedHash = true; openFromHash(); } }, 2500);
  });

  App.on('auth', () => {
    renderAdminMenu();
    if (selectedId) { const g = findGroup(selectedId); if (g) showCard(g, { keepPosition: true }); }
    if (App.sheet.key() === 'details' && selectedId) rerenderDetails(selectedId);
    if (App.sheet.key() === 'assignees') App.sheet.set(assigneesHtml(), bindAssignees);
    if (!isAdmin() && tool) cancelTool();
  });
  App.on('drawer-open', () => { renderAdminMenu(); renderMenuCounts(); });
  App.on('data', () => { if ($('#drawer').classList.contains('open')) { renderAdminMenu(); renderMenuCounts(); } });
  App.on('lang', () => {
    $('#search-input').placeholder = t(active === 'gis' ? 'search_ph_gis' : 'search_ph_repair');
    render();
    renderAdminMenu();
    renderToolbar();
    if (selectedId) { const g = findGroup(selectedId); if (g) showCard(g, { keepPosition: true }); }
    const key = App.sheet.key();
    if (key === 'details' && selectedId) rerenderDetails(selectedId);
    else if (key === 'filters') App.sheet.set(filtersHtml(), bindFilters);
    else if (key === 'assignees') App.sheet.set(assigneesHtml(), bindAssignees);
    else if (key === 'catalog') { App.sheet.close(true); openCatalog(); }
  });

  // Цвет границ микрорайонов зависит от подложки
  App.on('basemap', () => { if (layers) render(); });

  App.registry = {
    select, closeCard, search, openCatalog,
    section: () => active,
    cancelTool,
    nearest(lat, lng, maxMeters) {
      let best = null, bestDist = Infinity;
      model().groups.forEach(g => { const d = haversine(lat, lng, g.center.lat, g.center.lng); if (d < bestDist) { bestDist = d; best = g; } });
      return best && bestDist <= maxMeters ? { id: best.id, name: best.name } : null;
    },
    // для отладки/тестов
    _model: model, _filters: filters, _assignees: assignees, _isBrokenDescription: isBrokenDescription
  };
})();
