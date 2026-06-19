/* game.js — Paint By Numbers (region-based): gameplay, rendering, zoom,
 * persistence, photo upload and the free-image browser.
 *
 * The picture is split into flat-colour REGIONS (the numbered areas). One tap
 * fills a whole region with its colour — exactly like real paint-by-number. */
(function () {
  'use strict';

  const STORE_KEY = 'pbn.progress.v2';
  const CUSTOM_KEY = 'pbn.custom.v1';
  const CELL = 24;            // logical px per cell before view scaling
  const MIN_NUM_PX = 11;      // smallest on-screen cell that still shows a number

  // ===================================================================
  // Persistence
  // ===================================================================
  const Store = {
    _p: null, _c: null,
    progress() { if (this._p) return this._p; try { this._p = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { this._p = {}; } return this._p; },
    saveProgress() { try { localStorage.setItem(STORE_KEY, JSON.stringify(this._p)); } catch (e) {} },
    getP(id) { return this.progress()[id] || null; },
    setP(id, rec) { this.progress()[id] = rec; this.saveProgress(); },
    custom() { if (this._c) return this._c; try { this._c = JSON.parse(localStorage.getItem(CUSTOM_KEY)) || []; } catch (e) { this._c = []; } return this._c; },
    saveCustom() { try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(this._c)); } catch (e) {} },
    addCustom(rec) { this.custom().unshift(rec); this.saveCustom(); },
    removeCustom(id) { this._c = this.custom().filter((p) => p.id !== id); this.saveCustom(); const p = this.progress(); delete p[id]; this.saveProgress(); },
  };

  function bitsToB64(bits) {
    const bytes = new Uint8Array(Math.ceil(bits.length / 8));
    for (let i = 0; i < bits.length; i++) if (bits[i]) bytes[i >> 3] |= 1 << (i & 7);
    let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s);
  }
  function b64ToBits(b64, n) {
    const bits = new Uint8Array(n);
    try { const s = atob(b64); for (let i = 0; i < n; i++) bits[i] = (s.charCodeAt(i >> 3) >> (i & 7)) & 1; } catch (e) {}
    return bits;
  }

  // ===================================================================
  // State
  // ===================================================================
  const State = {
    puzzle: null, filledR: null, total: 0, done: 0, selected: 1,
    view: { scale: 1, ox: 0, oy: 0 }, mode: 'brush',
  };

  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  let dpr = Math.max(1, window.devicePixelRatio || 1);

  const galleryEl = document.getElementById('gallery');
  const galleryScreen = document.getElementById('gallery-screen');
  const playScreen = document.getElementById('play-screen');

  // build region data once per puzzle (lazy, on open)
  function ensureRegions(p) {
    if (p.region) return;
    const r = window.PBN.buildRegions(p.grid, p.w, p.h);
    p.region = r.region; p.regionColor = r.regionColor; p.regionCount = r.count;
    p.centroids = r.centroids; p.cells = r.cells;
  }

  function allPuzzles() {
    const customs = Store.custom().map((d) => ({
      id: d.id, name: d.name, emoji: d.emoji, w: d.w, h: d.h,
      palette: d.palette, grid: window.PBN.decodeRLE(d.rle, d.w, d.h), custom: true,
    }));
    return customs.concat(window.PUZZLES || []);
  }

  function showGallery() { playScreen.classList.remove('active'); galleryScreen.classList.add('active'); renderGallery(); }
  function showPlay() { galleryScreen.classList.remove('active'); playScreen.classList.add('active'); resizeCanvas(); fitView(); requestRender(); }

  // progress comes straight from the saved record (no region build needed)
  function progressOf(p) {
    const rec = Store.getP(p.id);
    if (!rec || !rec.total) return { frac: 0, started: false, complete: false };
    return { frac: rec.done / rec.total, started: rec.done > 0, complete: rec.done >= rec.total };
  }

  // ===================================================================
  // Gallery
  // ===================================================================
  function renderGallery() {
    galleryEl.innerHTML = '';
    const list = allPuzzles();
    let completed = 0;
    for (const p of list) {
      const prog = progressOf(p);
      if (prog.complete) completed++;
      const card = document.createElement('div');
      card.className = 'card' + (prog.complete ? ' complete' : '');

      const thumb = document.createElement('canvas');
      thumb.className = 'thumb'; thumb.width = 260; thumb.height = 260;
      drawThumb(thumb, p);
      card.appendChild(thumb);

      const meta = document.createElement('div'); meta.className = 'card-meta';
      meta.innerHTML = '<span class="card-name">' + p.emoji + ' ' + escapeHtml(p.name) + '</span>' +
        '<span class="pct">' + Math.round(prog.frac * 100) + '%</span>';
      card.appendChild(meta);

      const bar = document.createElement('div'); bar.className = 'card-bar';
      bar.innerHTML = '<i style="width:' + Math.round(prog.frac * 100) + '%"></i>';
      card.appendChild(bar);

      const status = document.createElement('div');
      const st = prog.complete ? 'completed' : prog.started ? 'started' : 'new';
      status.className = 'card-status ' + st;
      status.textContent = prog.complete ? '✓ Completed' : prog.started ? 'Started' : 'Not started';
      card.appendChild(status);

      if (prog.complete) { const b = document.createElement('div'); b.className = 'badge'; b.textContent = '✓'; card.appendChild(b); }
      if (p.custom) {
        const del = document.createElement('button'); del.className = 'del'; del.textContent = '✕'; del.title = 'Delete';
        del.addEventListener('click', (e) => { e.stopPropagation(); if (confirm('Delete "' + p.name + '"?')) { Store.removeCustom(p.id); renderGallery(); } });
        card.appendChild(del);
      }
      card.addEventListener('click', () => openPuzzle(p));
      galleryEl.appendChild(card);
    }
    const sub = document.getElementById('gallery-sub');
    if (sub) sub.textContent = completed + ' / ' + list.length + ' completed';
  }

  // Thumbnail: the FINISHED picture in full colour — the photo on the box lid.
  // Rendered via ImageData at native size then scaled (fast + smooth), instead
  // of tens of thousands of fillRect calls.
  function drawThumb(cv, p) {
    const w = p.w, h = p.h;
    const off = document.createElement('canvas'); off.width = w; off.height = h;
    const octx = off.getContext('2d');
    const img = octx.createImageData(w, h), d = img.data;
    const rgb = p.palette.map((hex) => { const c = hex.replace('#', ''); return [parseInt(c.substr(0, 2), 16), parseInt(c.substr(2, 2), 16), parseInt(c.substr(4, 2), 16)]; });
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const idx = p.grid[y][x], o = (y * w + x) * 4;
      if (!idx) { d[o + 3] = 0; continue; }
      const c = rgb[idx - 1]; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    const c = cv.getContext('2d');
    c.clearRect(0, 0, cv.width, cv.height);
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
    const s = Math.min(cv.width / w, cv.height / h);
    c.drawImage(off, (cv.width - s * w) / 2, (cv.height - s * h) / 2, s * w, s * h);
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }

  // ===================================================================
  // Open / restore
  // ===================================================================
  function openPuzzle(p) {
    showLoading('Opening…');
    setTimeout(() => {
      ensureRegions(p);
      State.puzzle = p; State.total = p.regionCount;
      const rec = Store.getP(p.id);
      if (rec && rec.bits && rec.total === p.regionCount) State.filledR = b64ToBits(rec.bits, p.regionCount);
      else State.filledR = new Uint8Array(p.regionCount);
      recountDone();
      State.selected = firstUnfinishedColor() || 1;
      buildPalette();
      document.getElementById('play-title').textContent = p.emoji + ' ' + p.name;
      document.getElementById('mode-btn').textContent = State.mode === 'brush' ? '🖌️' : '✋';
      hideLoading(); showPlay(); maybeHint();
    }, 20);
  }

  function recountDone() { let d = 0; for (let r = 0; r < State.total; r++) if (State.filledR[r]) d++; State.done = d; }
  function colorCounts() {
    const p = State.puzzle, counts = new Array(p.palette.length + 1).fill(0);
    for (let r = 0; r < p.regionCount; r++) if (!State.filledR[r]) counts[p.regionColor[r]]++;
    return counts;
  }
  function firstUnfinishedColor() { const c = colorCounts(); for (let k = 1; k < c.length; k++) if (c[k] > 0) return k; return 0; }

  let saveTimer = null;
  function persist(now) {
    if (!State.puzzle) return;
    const write = () => Store.setP(State.puzzle.id, { bits: bitsToB64(State.filledR), done: State.done, total: State.total, updated: Date.now() });
    if (now) { clearTimeout(saveTimer); saveTimer = null; write(); return; }
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; write(); }, 400);
  }

  // ===================================================================
  // Palette
  // ===================================================================
  function buildPalette() {
    const bar = document.getElementById('palette'); bar.innerHTML = '';
    const p = State.puzzle, counts = colorCounts();
    for (let k = 1; k <= p.palette.length; k++) {
      const btn = document.createElement('button'); btn.className = 'swatch'; btn.dataset.idx = k;
      btn.style.background = p.palette[k - 1]; btn.style.color = textColorOn(p.palette[k - 1]);
      btn.innerHTML = '<span class="num">' + k + '</span><span class="count">' + counts[k] + '</span>';
      if (counts[k] === 0) btn.classList.add('done');
      if (k === State.selected) btn.classList.add('sel');
      btn.addEventListener('click', () => selectColor(k));
      bar.appendChild(btn);
    }
    scrollSwatchIntoView();
  }
  function updatePalette() {
    const counts = colorCounts(), bar = document.getElementById('palette');
    [...bar.children].forEach((btn) => {
      const k = +btn.dataset.idx;
      btn.classList.toggle('done', counts[k] === 0);
      btn.classList.toggle('sel', k === State.selected);
      const cEl = btn.querySelector('.count'); if (cEl) cEl.textContent = counts[k];
    });
  }
  function selectColor(k) { State.selected = k; updatePalette(); scrollSwatchIntoView(); requestRender(); }
  function scrollSwatchIntoView() { const el = document.getElementById('palette').querySelector('.swatch.sel'); if (el && el.scrollIntoView) el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); }
  function textColorOn(hex) { const c = hex.replace('#', ''); const r = parseInt(c.substr(0, 2), 16), g = parseInt(c.substr(2, 2), 16), b = parseInt(c.substr(4, 2), 16); return (r * 299 + g * 587 + b * 114) / 1000 > 140 ? '#333' : '#fff'; }
  function mix(hex, target, t) { const c = hex.replace('#', ''); const r = parseInt(c.substr(0, 2), 16), g = parseInt(c.substr(2, 2), 16), b = parseInt(c.substr(4, 2), 16); const m = (v) => Math.round(v + (target - v) * t); return 'rgb(' + m(r) + ',' + m(g) + ',' + m(b) + ')'; }

  // ===================================================================
  // View / zoom
  // ===================================================================
  function viewport() { return { w: canvas.clientWidth, h: canvas.clientHeight }; }
  function fitView() {
    const p = State.puzzle, vp = viewport(), pad = 14;
    const s = Math.max(0.02, Math.min((vp.w - pad * 2) / (p.w * CELL), (vp.h - pad * 2) / (p.h * CELL)));
    State.view.scale = s; State.view.ox = (vp.w - p.w * CELL * s) / 2; State.view.oy = (vp.h - p.h * CELL * s) / 2;
    State._fit = s; State._minScale = s * 0.85;
    State._maxScale = Math.max(s * 30, (0.7 * Math.min(vp.w, vp.h)) / CELL);   // zoom right down to one cell
  }
  function clampScale(s) { return Math.max(State._minScale, Math.min(State._maxScale, s)); }
  function clampView() {
    const p = State.puzzle, v = State.view, vp = viewport();
    v.scale = clampScale(v.scale);
    const gw = p.w * CELL * v.scale, gh = p.h * CELL * v.scale, m = Math.min(vp.w, vp.h) * 0.4;
    if (gw <= vp.w) v.ox = (vp.w - gw) / 2; else v.ox = Math.min(m, Math.max(vp.w - gw - m, v.ox));
    if (gh <= vp.h) v.oy = (vp.h - gh) / 2; else v.oy = Math.min(m, Math.max(vp.h - gh - m, v.oy));
  }
  let zoomAnim = null;
  function animateZoom(targetScale, cx, cy) {
    const r = canvas.getBoundingClientRect(), lx = cx - r.left, ly = cy - r.top, v = State.view;
    const from = { s: v.scale, ox: v.ox, oy: v.oy };
    targetScale = clampScale(targetScale);
    const f = targetScale / v.scale;
    const to = { s: targetScale, ox: lx - (lx - v.ox) * f, oy: ly - (ly - v.oy) * f };
    zoomAnim = { from, to, start: performance.now(), dur: 170 };
    requestAnimationFrame(zoomTick);
  }
  function zoomTick(now) {
    if (!zoomAnim) return;
    const t = Math.min(1, (now - zoomAnim.start) / zoomAnim.dur), e = 1 - Math.pow(1 - t, 3);
    const a = zoomAnim.from, b = zoomAnim.to, v = State.view;
    v.scale = a.s + (b.s - a.s) * e; v.ox = a.ox + (b.ox - a.ox) * e; v.oy = a.oy + (b.oy - a.oy) * e;
    clampView(); render();
    if (t < 1) requestAnimationFrame(zoomTick); else zoomAnim = null;
  }
  function zoomAt(cx, cy, factor) {
    zoomAnim = null;
    const v = State.view, r = canvas.getBoundingClientRect(), before = v.scale;
    v.scale = clampScale(v.scale * factor);
    const f = v.scale / before, lx = cx - r.left, ly = cy - r.top;
    v.ox = lx - (lx - v.ox) * f; v.oy = ly - (ly - v.oy) * f;
  }

  // ===================================================================
  // Render (rAF-batched)
  // ===================================================================
  let renderQueued = false;
  function requestRender() { if (!renderQueued) { renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); } }
  function resizeCanvas() { dpr = Math.max(1, window.devicePixelRatio || 1); const r = canvas.getBoundingClientRect(); canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr); }

  function render() {
    if (!State.puzzle) return;
    const p = State.puzzle, v = State.view, cs = CELL * v.scale;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    const vw = canvas.clientWidth, vh = canvas.clientHeight;
    const drawGrid = cs >= 5, showNums = cs >= MIN_NUM_PX;
    const x0 = Math.max(0, Math.floor(-v.ox / cs)), x1 = Math.min(p.w, Math.ceil((vw - v.ox) / cs));
    const y0 = Math.max(0, Math.floor(-v.oy / cs)), y1 = Math.min(p.h, Math.ceil((vh - v.oy) / cs));
    const selHex = p.palette[State.selected - 1];
    const selTint = mix(selHex, 255, 0.72);
    // boundary lines are drawn only between DIFFERENT numbered regions, so each
    // tile is outlined as its own unit (no internal lines, no merged blobs).
    // Skipped when zoomed out (drawGrid false) so the finished art looks smooth.
    const bound = drawGrid ? new Path2D() : null;       // edges to other regions
    const selBound = drawGrid ? new Path2D() : null;     // edges of selected tiles

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * p.w + x, rid = p.region[i]; if (rid < 0) continue;
        const px = v.ox + x * cs, py = v.oy + y * cs;
        const isFilled = State.filledR[rid];
        const isSel = !isFilled && p.regionColor[rid] === State.selected;
        ctx.fillStyle = isFilled ? p.palette[p.regionColor[rid] - 1] : (isSel ? selTint : '#ffffff');
        ctx.fillRect(px, py, cs + 0.6, cs + 0.6);
        if (drawGrid) {
          const rd = (x + 1 >= p.w) || p.region[i + 1] !== rid;
          const dn = (y + 1 >= p.h) || p.region[i + p.w] !== rid;
          const path = isSel ? selBound : bound;
          if (rd) { path.moveTo(px + cs, py); path.lineTo(px + cs, py + cs); }
          if (dn) { path.moveTo(px, py + cs); path.lineTo(px + cs, py + cs); }
        }
      }
    }
    if (bound) { ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(70,72,84,0.38)'; ctx.stroke(bound); }
    if (selBound) { ctx.lineWidth = 1.5; ctx.strokeStyle = mix(selHex, 0, 0.18); ctx.stroke(selBound); }

    // numbers: one per region, drawn at its centroid when it's big enough
    if (showNums) {
      ctx.font = '600 ' + Math.min(Math.floor(cs * 0.62), 22) + 'px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (let r = 0; r < p.regionCount; r++) {
        if (State.filledR[r]) continue;
        const ce = p.centroids[r];
        if (cs * Math.sqrt(ce.size) < 16) continue;          // too small on screen
        const cxp = v.ox + ce.x * cs + cs / 2, cyp = v.oy + ce.y * cs + cs / 2;
        if (cxp < -cs || cyp < -cs || cxp > vw + cs || cyp > vh + cs) continue;
        ctx.fillStyle = p.regionColor[r] === State.selected ? '#e8590c' : '#9aa2ad';
        ctx.fillText(p.regionColor[r], cxp, cyp);
      }
    }
    drawAnims(cs);
    updateProgressBar();
  }

  function updateProgressBar() {
    const pct = State.total ? Math.round((State.done / State.total) * 100) : 0;
    const fill = document.getElementById('progress-fill'), label = document.getElementById('progress-label');
    if (fill) fill.style.width = pct + '%'; if (label) label.textContent = pct + '%';
  }

  // ---- region fill juice: flash + sparkle ----
  const anims = []; let animRunning = false;
  function startAnims() { if (!animRunning) { animRunning = true; requestAnimationFrame(animFrame); } }
  function animFrame() {
    const now = performance.now();
    for (let k = anims.length - 1; k >= 0; k--) if (now - anims[k].t > 360) anims.splice(k, 1);
    render();
    if (anims.length) requestAnimationFrame(animFrame); else { animRunning = false; render(); }
  }
  function pushAnim(rid) { if (anims.length < 12) anims.push({ rid, t: performance.now() }); }
  function drawAnims(cs) {
    if (!anims.length) return;
    const p = State.puzzle, v = State.view, vw = canvas.clientWidth, vh = canvas.clientHeight, now = performance.now();
    for (const a of anims) {
      const t = Math.min(1, (now - a.t) / 320), e = 1 - Math.pow(1 - t, 3);
      const cells = p.cells[a.rid];
      if (cells.length <= 300) {                              // white flash over the region
        ctx.fillStyle = 'rgba(255,255,255,' + (0.7 * (1 - t)) + ')';
        for (let k = 0; k < cells.length; k++) {
          const i = cells[k], x = i % p.w, y = (i / p.w) | 0, px = v.ox + x * cs, py = v.oy + y * cs;
          if (px > vw || py > vh || px + cs < 0 || py + cs < 0) continue;
          ctx.fillRect(px, py, cs + 0.7, cs + 0.7);
        }
      }
      if (cs > 7) {                                           // sparkle at centroid
        const ce = p.centroids[a.rid], cxp = v.ox + ce.x * cs + cs / 2, cyp = v.oy + ce.y * cs + cs / 2;
        ctx.fillStyle = 'rgba(255,255,255,' + (1 - t) + ')';
        for (let s = 0; s < 6; s++) { const ang = (Math.PI * 2 / 6) * s, rr = cs * (0.5 + 1.6 * e); ctx.beginPath(); ctx.arc(cxp + Math.cos(ang) * rr, cyp + Math.sin(ang) * rr, cs * 0.12 * (1 - t) + 0.6, 0, 7); ctx.fill(); }
      }
    }
  }

  // ===================================================================
  // Painting (region fill)
  // ===================================================================
  function cellAt(clientX, clientY) {
    const r = canvas.getBoundingClientRect(), v = State.view, cs = CELL * v.scale;
    return { x: Math.floor((clientX - r.left - v.ox) / cs), y: Math.floor((clientY - r.top - v.oy) / cs) };
  }
  function buzz(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) {} }

  function regionAt(x, y) {
    const p = State.puzzle;
    if (x < 0 || y < 0 || x >= p.w || y >= p.h) return -1;
    return p.region[y * p.w + x];
  }
  // fill the region under a cell if it matches the selected colour
  function fillRegionAt(x, y) {
    const p = State.puzzle, rid = regionAt(x, y);
    if (rid < 0 || State.filledR[rid]) return false;
    if (p.regionColor[rid] !== State.selected) return false;
    State.filledR[rid] = 1; State.done++; pushAnim(rid); return true;
  }

  function tap(cx, cy) {
    const { x, y } = cellAt(cx, cy), p = State.puzzle, rid = regionAt(x, y);
    if (rid < 0) return;
    if (!State.filledR[rid] && p.regionColor[rid] !== State.selected) { flashWrong(rid); return; }
    if (fillRegionAt(x, y)) { buzz(7); startAnims(); updatePalette(); finalizeStroke(); }
  }

  let lastCell = null;
  function paintStroke(cx, cy) {
    const a = lastCell, b = cellAt(cx, cy); let painted = false;
    if (!a) painted = fillRegionAt(b.x, b.y);
    else {
      const dx = b.x - a.x, dy = b.y - a.y, steps = Math.max(Math.abs(dx), Math.abs(dy));
      for (let s = 0; s <= steps; s++) { const x = Math.round(a.x + (dx * s) / (steps || 1)), y = Math.round(a.y + (dy * s) / (steps || 1)); if (fillRegionAt(x, y)) painted = true; }
    }
    lastCell = b;
    if (painted) { buzz(4); startAnims(); updatePalette(); }
    requestRender(); return painted;
  }

  function flashWrong(rid) {
    buzz(26);
    const p = State.puzzle, v = State.view, cs = CELL * v.scale, ce = p.centroids[rid];
    render();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cxp = v.ox + ce.x * cs + cs / 2, cyp = v.oy + ce.y * cs + cs / 2;
    ctx.strokeStyle = '#fa5252'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(cxp, cyp, cs * 0.7, 0, 7); ctx.stroke();
    setTimeout(render, 220);
  }

  function finalizeStroke() {
    persist();
    if (colorCounts()[State.selected] === 0) { const n = firstUnfinishedColor(); if (n) selectColor(n); }
    if (State.done >= State.total) celebrate();
  }

  // ===================================================================
  // Completion
  // ===================================================================
  function celebrate() {
    persist(true);
    drawThumb(document.getElementById('done-art'), State.puzzle);
    document.getElementById('done-name').textContent = State.puzzle.emoji + ' ' + State.puzzle.name;
    document.getElementById('done-overlay').classList.add('show'); confetti(); buzz([20, 40, 20, 40, 60]);
  }
  function confetti() {
    const layer = document.getElementById('confetti'); layer.innerHTML = '';
    const colors = ['#ff6b6b', '#ffd43b', '#69db7c', '#4dabf7', '#da77f2', '#ff922b'];
    for (let i = 0; i < 90; i++) {
      const d = document.createElement('i'); d.style.left = Math.random() * 100 + '%';
      d.style.background = colors[(Math.random() * colors.length) | 0];
      d.style.animationDelay = (Math.random() * 0.6) + 's'; d.style.animationDuration = (1.4 + Math.random() * 1.2) + 's';
      d.style.transform = 'rotate(' + (Math.random() * 360) + 'deg)'; layer.appendChild(d);
    }
    setTimeout(() => (layer.innerHTML = ''), 3400);
  }

  // ===================================================================
  // Pointer input
  // ===================================================================
  const pointers = new Map();
  let gesture = null, panLast = null, downPt = null, pinchDist = 0, pinchMid = null, moved = false;
  const TAP_SLOP = 8;

  function onDown(e) {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const pts = [...pointers.values()];
      pinchDist = dist2(pts[0], pts[1]); pinchMid = mid(pts[0], pts[1]);
      gesture = 'pinch'; lastCell = null; zoomAnim = null; return;
    }
    downPt = { x: e.clientX, y: e.clientY }; moved = false;
    const rightOrMid = e.button === 1 || e.button === 2;
    if (State.mode === 'hand' || rightOrMid) { gesture = 'pan'; panLast = { x: e.clientX, y: e.clientY }; }
    else { gesture = 'paint'; lastCell = null; paintStroke(e.clientX, e.clientY); }
  }
  function onMove(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gesture === 'pinch' && pointers.size >= 2) {
      const pts = [...pointers.values()], nd = dist2(pts[0], pts[1]), nm = mid(pts[0], pts[1]);
      if (pinchDist > 0) zoomAt(nm.x, nm.y, nd / pinchDist);
      State.view.ox += nm.x - pinchMid.x; State.view.oy += nm.y - pinchMid.y;
      pinchDist = nd; pinchMid = nm; clampView(); requestRender(); return;
    }
    if (downPt && !moved && Math.hypot(e.clientX - downPt.x, e.clientY - downPt.y) > TAP_SLOP) moved = true;
    if (gesture === 'pan' && panLast) { State.view.ox += e.clientX - panLast.x; State.view.oy += e.clientY - panLast.y; panLast = { x: e.clientX, y: e.clientY }; clampView(); requestRender(); }
    else if (gesture === 'paint' && moved) paintStroke(e.clientX, e.clientY);  // only brush once it's a real drag
  }
  function onUp(e) {
    const wasGesture = gesture, p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    if (wasGesture === 'paint') { if (!moved && p) tap(p.x, p.y); else finalizeStroke(); }
    if (pointers.size === 0) { gesture = null; panLast = null; pinchDist = 0; lastCell = null; }
    else if (pointers.size === 1) { const last = [...pointers.values()][0]; gesture = 'pan'; panLast = { x: last.x, y: last.y }; moved = true; }
  }
  function dist2(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    // direct zoom + one batched render — no animation loop (avoids pile-ups/lag)
    const step = Math.exp(-e.deltaY * 0.0016);   // smooth, proportional to scroll
    zoomAt(e.clientX, e.clientY, step);
    clampView(); requestRender();
  }, { passive: false });
  let lastTapTime = 0, lastTapPt = null;
  canvas.addEventListener('pointerup', (e) => {
    const now = performance.now();
    if (now - lastTapTime < 300 && lastTapPt && Math.hypot(e.clientX - lastTapPt.x, e.clientY - lastTapPt.y) < 25) {
      const target = State.view.scale < State._maxScale * 0.5 ? Math.min(State._maxScale, State.view.scale * 2.6) : State._fit;
      animateZoom(target, e.clientX, e.clientY); lastTapTime = 0;
    } else { lastTapTime = now; lastTapPt = { x: e.clientX, y: e.clientY }; }
  });

  // ===================================================================
  // Toolbar
  // ===================================================================
  document.getElementById('back-btn').addEventListener('click', () => { persist(true); showGallery(); });
  document.getElementById('fit-btn').addEventListener('click', () => { fitView(); clampView(); requestRender(); });
  document.getElementById('mode-btn').addEventListener('click', () => {
    State.mode = State.mode === 'brush' ? 'hand' : 'brush';
    document.getElementById('mode-btn').textContent = State.mode === 'brush' ? '🖌️' : '✋';
    toast(State.mode === 'brush' ? 'Brush: drag to paint' : 'Move: drag to pan');
  });
  document.getElementById('reset-btn').addEventListener('click', () => {
    if (!State.puzzle || !confirm('Clear your progress on this picture?')) return;
    State.filledR = new Uint8Array(State.puzzle.regionCount); State.done = 0;
    State.selected = firstUnfinishedColor() || 1; persist(true); buildPalette(); requestRender();
  });
  document.getElementById('done-close').addEventListener('click', () => { document.getElementById('done-overlay').classList.remove('show'); showGallery(); });

  window.addEventListener('resize', () => { if (playScreen.classList.contains('active')) { resizeCanvas(); clampView(); requestRender(); } });
  document.addEventListener('visibilitychange', () => { if (document.hidden) persist(true); });
  window.addEventListener('pagehide', () => persist(true));

  // ===================================================================
  // Hints / toasts
  // ===================================================================
  let hintShown = false;
  function maybeHint() {
    if (hintShown || localStorage.getItem('pbn.hinted')) return;
    hintShown = true; try { localStorage.setItem('pbn.hinted', '1'); } catch (e) {}
    toast('Pinch / scroll to zoom · drag to paint', 3400);
  }
  let toastTimer = null;
  function toast(msg, ms) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms || 1600); }

  // ===================================================================
  // Photo upload + free-image browser
  // ===================================================================
  function makeCustomFromImage(img, w, h, name, emoji) {
    showLoading('Turning your photo into a puzzle…');
    setTimeout(() => {
      try {
        const puz = window.PBN.imageToPuzzle(img, w, h, { maxDim: 150, maxColors: 24 });
        const rec = { id: 'custom-' + Date.now(), name: name || 'My Picture', emoji: emoji || '🖼️', w: puz.w, h: puz.h, palette: puz.palette, rle: window.PBN.encodeRLE(puz.grid), created: Date.now() };
        Store.addCustom(rec);
        hideLoading();
        openPuzzle({ id: rec.id, name: rec.name, emoji: rec.emoji, w: rec.w, h: rec.h, palette: rec.palette, grid: puz.grid, custom: true });
      } catch (e) { hideLoading(); alert('Sorry, could not process that image.'); }
    }, 30);
  }
  document.getElementById('upload-input').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0]; e.target.value = ''; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { const img = new Image(); img.onload = () => makeCustomFromImage(img, img.naturalWidth, img.naturalHeight, file.name.replace(/\.[^.]+$/, '').slice(0, 24) || 'My Photo', '🖼️'); img.onerror = () => alert('Could not load that image.'); img.src = reader.result; };
    reader.readAsDataURL(file);
  });
  document.getElementById('upload-btn').addEventListener('click', () => document.getElementById('upload-input').click());

  const browseModal = document.getElementById('browse-modal');
  const browseGrid = document.getElementById('browse-grid');
  const browseInput = document.getElementById('browse-input');
  document.getElementById('browse-btn').addEventListener('click', () => { browseModal.classList.add('show'); if (!browseGrid.childElementCount) doSearch('flowers'); });
  document.getElementById('browse-close').addEventListener('click', () => browseModal.classList.remove('show'));
  document.getElementById('browse-go').addEventListener('click', () => doSearch(browseInput.value.trim() || 'flowers'));
  browseInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(browseInput.value.trim() || 'flowers'); });
  [...document.querySelectorAll('.chip')].forEach((c) => c.addEventListener('click', () => { browseInput.value = c.dataset.q; doSearch(c.dataset.q); }));

  async function doSearch(q) {
    browseGrid.innerHTML = '<div class="browse-loading">Searching…</div>';
    try {
      const url = 'https://api.openverse.org/v1/images/?q=' + encodeURIComponent(q) + '&license=cc0&size=medium&page_size=24&mature=false';
      const data = await (await fetch(url, { headers: { Accept: 'application/json' } })).json();
      const items = (data.results || []).filter((r) => r.url);
      browseGrid.innerHTML = '';
      if (!items.length) { browseGrid.innerHTML = '<div class="browse-loading">No CC0 images found — try another word.</div>'; return; }
      for (const it of items) {
        const cell = document.createElement('button'); cell.className = 'browse-cell';
        const im = document.createElement('img'); im.loading = 'lazy'; im.src = it.thumbnail || it.url; im.alt = it.title || '';
        cell.appendChild(im); cell.addEventListener('click', () => pickFreeImage(it, q)); browseGrid.appendChild(cell);
      }
    } catch (e) { browseGrid.innerHTML = '<div class="browse-loading">Could not reach the image library (offline?).</div>'; }
  }
  function pickFreeImage(item, q) {
    browseModal.classList.remove('show'); showLoading('Fetching image…');
    const src = item.url.replace(/^https?:\/\//, '');
    const proxied = 'https://images.weserv.nl/?url=' + encodeURIComponent(src) + '&w=1000&output=jpg';
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => makeCustomFromImage(img, img.naturalWidth, img.naturalHeight, (item.title || q).slice(0, 24), '🖼️');
    img.onerror = () => { const img2 = new Image(); img2.crossOrigin = 'anonymous'; img2.onload = () => makeCustomFromImage(img2, img2.naturalWidth, img2.naturalHeight, (item.title || q).slice(0, 24), '🖼️'); img2.onerror = () => { hideLoading(); alert('Could not load that image. Try another.'); }; img2.src = item.thumbnail || item.url; };
    img.src = proxied;
  }
  function showLoading(msg) { const l = document.getElementById('loading'); l.querySelector('.loading-text').textContent = msg; l.classList.add('show'); }
  function hideLoading() { document.getElementById('loading').classList.remove('show'); }

  // ===================================================================
  // Boot
  // ===================================================================
  showGallery();
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('service-worker.js').catch(() => {}));
})();
