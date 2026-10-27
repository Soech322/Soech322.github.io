/* Синхронизация РВР с Google-таблицей выполненных работ.

   Таблица — главный и самый свежий источник: в каждой колонке перечислены
   адреса, где работа УЖЕ СДЕЛАНА (Краска, Песок, Установка круглой карусели).
   Сайт читает её при открытии и раз в 5 минут, сопоставляет адреса с
   площадками РВР и отмечает у них эти работы выполненными. Какие работы
   площадке назначены, по-прежнему хранится на сайте (Firestore, поле tasks).

   Адрес, который не удалось сопоставить автоматически, админ привязывает
   вручную — привязка хранится в коллекции sheet_links. */
(function () {
  'use strict';
  const App = window.App;

  const SHEET_ID = '1CqqBR7pyvBmm32nFirdJ8DPKlAzLD037';
  const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
  const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv`;
  const REFRESH_MS = 5 * 60 * 1000;

  // Колонки ищем по заголовку, а не по номеру — порядок в таблице может меняться
  const COLUMNS = [
    { task: 'paint', re: /краск|покрас/i },
    { task: 'sand', re: /песо?к/i },
    { task: 'carousel', re: /карусел/i }
  ];

  const state = { status: 'idle', at: null, error: null, rows: [], hasData: false, fromCache: false };
  const links = new Map(); // rowKey → { featureIds: [], ignore: bool }

  function parseCsv(text) {
    const rows = [];
    let row = [], cur = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else quoted = false; } else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c !== '\r') cur += c;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  // ===== Разбор адреса: «улица» + номера домов =====
  // Опечатки в таблице («момушилы», «метталургов», «побелы») сводим к одному ключу
  const STREET_ALIASES = [
    [/мом[уы]ш/, 'момыш'], [/мет+а?л+у?рг/, 'металлург'], [/республ/, 'республик'], [/независ/, 'независим'],
    [/валихан/, 'валихан'], [/сейф+у?л+ин/, 'сейфуллин'], [/байсеит/, 'байсеитов'], [/строител/, 'строител'],
    [/чернышев/, 'чернышевск'], [/менделеев/, 'менделеев'], [/тищенк/, 'тищенк'], [/ушинск/, 'ушинск'],
    [/лисовенк/, 'лисовенк'], [/токтаров/, 'токтаров'], [/побе[лд]/, 'побед'], [/калинин/, 'калинин'],
    [/караганд/, 'караганд'], [/казахстанск/, 'казахстанск'], [/чайковск/, 'чайковск'], [/восточн/, 'восточн'],
    [/байг[аоы]?з/, 'байгазиев'], [/горк\S*\s*дружб|г\.\s*дружб/, 'горкадружбы'], [/абай|абая/, 'абая'], [/(^|[^а-я])мира(?![а-я])/, 'мира'],
    [/панфилов/, 'панфилов'], [/маяковск/, 'маяковск'], [/блюхер/, 'блюхер'], [/амангельд/, 'амангельд']
  ];
  const TYPE_WORDS = /(^|[\s.,])(ул|улица|пр|просп|проспект|бул|бульвар|д|дом|в районе|районе|жилого|жилых|домов|у|новая|старая)(?=[\s.,]|$)/g;

  function parseAddress(raw) {
    let s = String(raw || '').toLowerCase().replace(/ё/g, 'е').replace(/\\/g, '/').replace(/[«»"“”]/g, ' ')
      .replace(/^№[\d,\s]+[—-]\s*/, '')
      // «32-1» — это корпус (32/1), а «1-3» — дома с 1 по 3
      .replace(/(\d+)\s*[-–—]\s*(\d+)/g, (m, a, b) => {
        if (+b < +a) return a + '/' + b;
        if (+b - +a > 100) return m; // reject pathological expansion
        return Array.from({ length: +b - +a + 1 }, (_, i) => +a + i).join(', ');
      });
    let street = null;
    const mk = s.match(/(\d+)\s*-?\s*(?:й|ой)?\s*(а)?\s*(мкр|микрорайон|кв|квартал|квартл)\.?/);
    if (mk) { street = (mk[3].startsWith('к') ? 'кв' : 'мкр') + mk[1] + (mk[2] || ''); s = s.replace(mk[0], ' '); }
    else {
      const short = s.match(/^\s*(\d+)\s*(а)\s+(\d+)/); // «3А 16 дом»
      if (short) { street = 'мкр' + short[1] + short[2]; s = s.replace(/^\s*\d+\s*а\s+/, ' '); }
    }
    if (!street) {
      for (const [re, key] of STREET_ALIASES) { if (re.test(s)) { street = key; s = s.replace(re, ' '); break; } }
    }
    s = s.replace(TYPE_WORDS, ' ');
    if (!street) {
      // Улица не из списка: самое длинное слово, без окончания
      const words = (s.match(/[а-яәғқңөұүһі]{4,}/g) || []).sort((a, b) => b.length - a.length);
      if (words[0]) { street = words[0].slice(0, 6); s = s.replace(words[0], ' '); }
    }
    const nums = [...s.matchAll(/(\d+)\s*([а-я](?![а-я]))?(?:\s*[/.]\s*(\d+))?/g)].map(m => m[1] + (m[2] || '') + (m[3] ? '/' + m[3] : ''));
    return { street, nums };
  }

  const rowKey = (task, raw) => `${task}|${String(raw).toLowerCase().replace(/\s+/g, ' ').trim()}`;

  // Таблица → строки работ. На входе — массив строк (массивов ячеек) или CSV-текст.
  function parseSheet(input) {
    const rows = (typeof input === 'string' ? parseCsv(input) : input)
      .map(r => r.map(c => (c == null ? '' : String(c))))
      .filter(r => r.some(c => c.trim()));
    if (!rows.length) throw new Error('пустой ответ таблицы');
    const head = rows[0];
    const cols = COLUMNS.map(c => ({ ...c, index: head.findIndex(h => c.re.test(h || '')) })).filter(c => c.index >= 0);
    if (!cols.length) throw new Error('в таблице не найдены колонки «Краска», «Песок», «Карусель»');
    const out = [];
    rows.slice(1).forEach((r, i) => cols.forEach(c => {
      const raw = (r[c.index] || '').trim();
      if (raw) out.push({ task: c.task, raw, line: i + 2, key: rowKey(c.task, raw), addr: parseAddress(raw) });
    }));
    return out;
  }

  async function fetchCsvRows(stamp) {
    const res = await fetch(`${CSV_URL}&t=${stamp}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    if (/<html/i.test(text.slice(0, 200))) throw new Error('таблица закрыта для просмотра по ссылке');
    return parseCsv(text);
  }

  // Запасной путь — JSONP через <script>. Нужен, когда fetch блокируется CORS:
  // Google не разрешает чтение страницам, открытым с диска (file://, Origin: null).
  let jsonpSeq = 0;
  function fetchJsonpRows(stamp) {
    return new Promise((resolve, reject) => {
      const cb = `__sheetCb${++jsonpSeq}`;
      const script = document.createElement('script');
      const cleanup = () => { delete window[cb]; script.remove(); clearTimeout(timer); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, 15000);
      window[cb] = resp => {
        cleanup();
        if (!resp || resp.status !== 'ok' || !resp.table) { reject(new Error((resp && resp.errors && resp.errors[0] && resp.errors[0].detailed_message) || 'gviz error')); return; }
        resolve(resp.table.rows.map(r => (r.c || []).map(c => (c ? (c.f != null ? c.f : c.v) : ''))));
      };
      script.onerror = () => { cleanup(); reject(new Error('таблица недоступна')); };
      script.src = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=responseHandler:${cb}&headers=0&t=${stamp}`;
      document.head.appendChild(script);
    });
  }

  async function load(force) {
    if (state.status === 'loading') return;
    state.status = 'loading';
    App.emit('sheet');
    const stamp = force ? Date.now() : Math.floor(Date.now() / 60000);
    try {
      let rows;
      try { rows = await fetchCsvRows(stamp); } catch (err) { rows = await fetchJsonpRows(stamp); }
      const parsed = parseSheet(rows);
      state.rows = parsed;
      state.hasData = true;
      state.at = new Date().toISOString();
      state.status = 'ok';
      state.fromCache = false;
      state.error = null;
      App.store.set('sheetCache', { rows, at: state.at });
    } catch (err) {
      console.warn('Google-таблица РВР:', err);
      const cached = App.store.get('sheetCache', null);
      if (!state.hasData && cached && (cached.rows || cached.text)) {
        try {
          state.rows = parseSheet(cached.rows || cached.text);
          state.at = cached.at;
          state.hasData = true;
        } catch (cacheError) { /* invalid cache must not break future refreshes */ }
      }
      state.status = state.hasData ? 'ok' : 'error';
      state.fromCache = state.hasData;
      state.error = String(err && err.message || err);
    }
    App.emit('sheet');
  }

  // Сопоставление строк таблицы с площадками РВР.
  // points: [{ id, name }] → { byPoint: Map(id → Set(task)), rows: [...] }
  function match(points) {
    const parsed = points.map(p => ({ id: p.id, addr: parseAddress(p.name) }));
    const byPoint = new Map();
    const rows = state.rows.map(row => {
      const link = links.get(row.key);
      let ids;
      let manual = false;
      if (link && link.ignore) ids = [];
      else if (link && link.featureIds && link.featureIds.length) { ids = link.featureIds.filter(id => parsed.some(p => p.id === id)); manual = true; }
      else {
        ids = row.addr.street && row.addr.nums.length
          ? parsed.filter(p => p.addr.street === row.addr.street && p.addr.nums.some(n => row.addr.nums.includes(n))).map(p => p.id)
          : [];
      }
      ids.forEach(id => { if (!byPoint.has(id)) byPoint.set(id, new Set()); byPoint.get(id).add(row.task); });
      return { ...row, ids, manual, ignored: !!(link && link.ignore) };
    });
    return { byPoint, rows };
  }

  function attachLinks() {
    if (!App.fb.ok) return;
    App.fb.db.collection('sheet_links').onSnapshot(snap => {
      links.clear();
      snap.forEach(doc => { const d = doc.data() || {}; if (d.key) links.set(d.key, d); });
      App.emit('sheet');
    }, err => console.warn('sheet_links:', err));
  }

  // id документа: ключ строки без запрещённых для Firestore символов
  const docId = key => key.replace(/[\/.#$\[\]]/g, '_').slice(0, 400);

  function setLink(key, featureIds, ignore) {
    const ref = App.fb.db.collection('sheet_links').doc(docId(key));
    if (!featureIds && !ignore) return ref.delete();
    return ref.set({ key, featureIds: featureIds || [], ignore: !!ignore, updatedAt: new Date().toISOString(), updatedBy: App.auth.user && App.auth.user.email || null });
  }

  App.on('ready', () => {
    attachLinks();
    load();
    setInterval(() => { if (document.visibilityState === 'visible') load(); }, REFRESH_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.at && Date.now() - new Date(state.at) > REFRESH_MS) load();
    });
  });

  App.sheetSync = { state, load, match, setLink, links, parseAddress, url: SHEET_URL };
})();
