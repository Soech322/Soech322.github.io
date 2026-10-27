/* «Общий снимок» территорий, закреплённых за человеком: PNG-лист с картой
   (текущая подложка), зонами, пронумерованными метками и списком адресов.
   Рисуется на canvas вручную — так снимок не зависит от поворота карты,
   открытых панелей и размера экрана. */
(function () {
  'use strict';
  const App = window.App;

  const TILE = 256;
  const MAP_W = 1800, MAP_H = 1150, PAD = 60, HEADER = 150;

  function project(lat, lng, z) {
    const s = TILE * Math.pow(2, z);
    const x = (lng + 180) / 360 * s;
    const r = lat * Math.PI / 180;
    const y = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * s;
    return { x, y };
  }

  function loadImage(src) {
    return new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const timer = setTimeout(() => resolve(null), 12000);
      img.onload = () => { clearTimeout(timer); resolve(img); };
      img.onerror = () => { clearTimeout(timer); resolve(null); };
      img.src = src;
    });
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function wrapText(ctx, text, maxWidth) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = '';
    words.forEach(w => {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; } else line = test;
    });
    if (line) lines.push(line);
    return lines;
  }

  async function exportPerson({ person, groups, zones, sectionTitle }) {
    App.toast(App.t('snapshot_building'), { duration: 15000 });
    const tiles = App.BASEMAP_TILES[App.basemap] || App.BASEMAP_TILES.satellite;

    // Охват: все точки и все вершины зон человека
    const pts = [];
    groups.forEach(g => pts.push(g.center));
    zones.forEach(z => {
      const rings = z.geometry.type === 'Polygon' ? [z.geometry.coordinates[0]] : z.geometry.coordinates;
      rings.forEach(r => r.forEach(p => pts.push(p)));
    });
    const minLat = Math.min(...pts.map(p => p.lat)), maxLat = Math.max(...pts.map(p => p.lat));
    const minLng = Math.min(...pts.map(p => p.lng)), maxLng = Math.max(...pts.map(p => p.lng));

    let z = tiles.maxZoom;
    for (; z > 10; z--) {
      const a = project(maxLat, minLng, z), b = project(minLat, maxLng, z);
      if (b.x - a.x <= MAP_W - PAD * 2 && b.y - a.y <= MAP_H - PAD * 2) break;
    }
    const tl = project(maxLat, minLng, z), br = project(minLat, maxLng, z);
    const cx = (tl.x + br.x) / 2, cy = (tl.y + br.y) / 2;
    const ox = cx - MAP_W / 2, oy = cy - MAP_H / 2; // мировые пиксели левого верхнего угла карты
    const toXY = (lat, lng) => { const p = project(lat, lng, z); return { x: p.x - ox, y: p.y - oy }; };

    // Список адресов под картой
    const items = groups.map((g, i) => ({ n: i + 1, text: g.name, g }));
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = '500 22px Inter, Arial, sans-serif';
    const colW = (MAP_W - 40) / 2;
    const listLines = items.map(it => wrapText(measure, `${it.n}. ${it.text}`, colW - 30));
    const half = Math.ceil(items.length / 2);
    const colHeight = col => listLines.slice(col ? half : 0, col ? undefined : half).reduce((s, l) => s + l.length * 30 + 10, 0);
    const LIST_H = Math.max(colHeight(0), colHeight(1)) + 90;

    const W = MAP_W + 80, H = HEADER + MAP_H + LIST_H + 60;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0B1012';
    ctx.fillRect(0, 0, W, H);

    // Шапка
    ctx.fillStyle = person.color;
    roundRect(ctx, 40, 40, 70, 70, 18); ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '700 44px Inter, Arial, sans-serif';
    ctx.fillText(person.name, 132, 82);
    ctx.font = '500 26px Inter, Arial, sans-serif';
    ctx.fillStyle = '#A9B8B3';
    const sub = [person.phone, `${sectionTitle}: ${groups.length}`, App.formatDate(new Date())].filter(Boolean).join('   ·   ');
    ctx.fillText(sub, 132, 120);

    // Карта
    const mx = 40, my = HEADER;
    ctx.save();
    roundRect(ctx, mx, my, MAP_W, MAP_H, 22); ctx.clip();
    ctx.fillStyle = '#1F2A2F';
    ctx.fillRect(mx, my, MAP_W, MAP_H);
    const x0 = Math.floor(ox / TILE), y0 = Math.floor(oy / TILE);
    const x1 = Math.floor((ox + MAP_W) / TILE), y1 = Math.floor((oy + MAP_H) / TILE);
    const jobs = [];
    for (let tx = x0; tx <= x1; tx++) {
      for (let ty = y0; ty <= y1; ty++) {
        const url = tiles.url.replace('{z}', z).replace('{x}', tx).replace('{y}', ty);
        jobs.push(loadImage(url).then(img => { if (img) ctx.drawImage(img, mx + tx * TILE - ox, my + ty * TILE - oy, TILE, TILE); }));
      }
    }
    await Promise.all(jobs);
    // лёгкое затемнение, чтобы цветные зоны читались на любой подложке
    ctx.fillStyle = App.basemap === 'light' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.18)';
    ctx.fillRect(mx, my, MAP_W, MAP_H);

    zones.forEach(zone => {
      const rings = zone.geometry.type === 'Polygon' ? [zone.geometry.coordinates[0]] : zone.geometry.coordinates;
      rings.forEach(ring => {
        ctx.beginPath();
        ring.forEach((p, i) => { const q = toXY(p.lat, p.lng); i ? ctx.lineTo(mx + q.x, my + q.y) : ctx.moveTo(mx + q.x, my + q.y); });
        ctx.closePath();
        ctx.globalAlpha = 0.3; ctx.fillStyle = person.color; ctx.fill();
        ctx.globalAlpha = 1; ctx.lineWidth = 4; ctx.strokeStyle = person.color; ctx.stroke();
      });
    });

    items.forEach(it => {
      const q = toXY(it.g.center.lat, it.g.center.lng);
      const x = mx + q.x, y = my + q.y;
      ctx.beginPath(); ctx.arc(x, y, 22, 0, Math.PI * 2);
      ctx.fillStyle = person.color; ctx.fill();
      ctx.lineWidth = 4; ctx.strokeStyle = '#FFFFFF'; ctx.stroke();
      ctx.fillStyle = '#0B1012';
      ctx.font = '800 22px Inter, Arial, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(it.n), x, y + 1);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    });
    ctx.restore();

    // Список
    let ly = HEADER + MAP_H + 60;
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '700 28px Inter, Arial, sans-serif';
    ctx.fillText(App.t('snapshot_list_title', { n: items.length }), 40, ly);
    ly += 46;
    ctx.font = '500 22px Inter, Arial, sans-serif';
    [0, 1].forEach(col => {
      let y = ly;
      const x = 40 + col * (colW + 40);
      listLines.slice(col ? half : 0, col ? undefined : half).forEach(lines => {
        ctx.fillStyle = '#EAF1EF';
        lines.forEach((line, i) => { ctx.fillText(line, x + (i ? 30 : 0), y); y += 30; });
        y += 10;
      });
    });
    ctx.fillStyle = '#74837E';
    ctx.font = '400 18px Inter, Arial, sans-serif';
    ctx.fillText('Темиртау — рабочие карты · © Esri, HERE, OpenStreetMap', 40, H - 24);

    canvas.toBlob(blob => {
      if (!blob) { App.toast(App.t('snapshot_failed'), { error: true }); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${person.name.replace(/[^\wа-яёәғқңөұүһі -]/gi, '').trim().replace(/\s+/g, '_') || 'person'}_${new Date().toISOString().slice(0, 10)}.png`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      App.toast(App.t('snapshot_done'));
    }, 'image/png');
  }

  App.snapshot = { exportPerson };
})();
