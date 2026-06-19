/* convert.js — turn any image into a paint-by-number puzzle.
 *
 * Pipeline:  downscale -> median-cut quantize -> nearest-palette map ->
 *            speck cleanup.  Powers uploads, the free-image browser and the
 *            offline baker (which mirrors this in Python).
 *
 * Returns { w, h, palette:[hex,...], grid:[[idx,...]] }  with idx in 1..N.
 */
window.PBN = window.PBN || {};
(function (PBN) {
  'use strict';

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function toHex(r, g, b) {
    return '#' + [r, g, b].map((v) => clamp(v | 0, 0, 255).toString(16).padStart(2, '0')).join('');
  }

  // ---- median-cut quantization ----------------------------------------
  function medianCut(samples, maxColors) {
    // samples: flat [r,g,b,r,g,b,...] (Uint8). Work on index list of triples.
    const n = samples.length / 3;
    let idx = new Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;

    function box(list) {
      let rmin = 255, gmin = 255, bmin = 255, rmax = 0, gmax = 0, bmax = 0;
      for (const i of list) {
        const r = samples[i * 3], g = samples[i * 3 + 1], b = samples[i * 3 + 2];
        if (r < rmin) rmin = r; if (r > rmax) rmax = r;
        if (g < gmin) gmin = g; if (g > gmax) gmax = g;
        if (b < bmin) bmin = b; if (b > bmax) bmax = b;
      }
      return {
        list,
        rng: Math.max(rmax - rmin, gmax - gmin, bmax - bmin),
        ch: (rmax - rmin) >= (gmax - gmin) && (rmax - rmin) >= (bmax - bmin) ? 0
          : (gmax - gmin) >= (bmax - bmin) ? 1 : 2,
        vol: list.length,
      };
    }

    let boxes = [box(idx)];
    while (boxes.length < maxColors) {
      // split the box with the greatest colour range (weighted by population)
      let bi = -1, best = -1;
      for (let i = 0; i < boxes.length; i++) {
        if (boxes[i].list.length < 2) continue;
        const score = boxes[i].rng * Math.cbrt(boxes[i].vol);
        if (score > best) { best = score; bi = i; }
      }
      if (bi < 0) break;
      const b = boxes[bi];
      const ch = b.ch;
      const sorted = b.list.slice().sort((x, y) => samples[x * 3 + ch] - samples[y * 3 + ch]);
      const mid = sorted.length >> 1;
      boxes.splice(bi, 1, box(sorted.slice(0, mid)), box(sorted.slice(mid)));
    }

    // average colour per box -> palette
    const palette = [];
    for (const b of boxes) {
      let r = 0, g = 0, bl = 0;
      for (const i of b.list) { r += samples[i * 3]; g += samples[i * 3 + 1]; bl += samples[i * 3 + 2]; }
      const c = b.list.length || 1;
      palette.push([Math.round(r / c), Math.round(g / c), Math.round(bl / c)]);
    }
    return palette;
  }

  // merge palette entries that are near-identical
  function dedupePalette(pal, thresh) {
    const out = [];
    const map = new Array(pal.length);
    for (let i = 0; i < pal.length; i++) {
      let found = -1;
      for (let j = 0; j < out.length; j++) {
        const d = (pal[i][0] - out[j][0]) ** 2 + (pal[i][1] - out[j][1]) ** 2 + (pal[i][2] - out[j][2]) ** 2;
        if (d < thresh) { found = j; break; }
      }
      if (found >= 0) map[i] = found;
      else { map[i] = out.length; out.push(pal[i].slice()); }
    }
    return { pal: out, map };
  }

  function nearest(pal, r, g, b) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < pal.length; i++) {
      const d = (pal[i][0] - r) ** 2 + (pal[i][1] - g) ** 2 + (pal[i][2] - b) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  // replace isolated single cells with the dominant neighbour (denoise)
  function despeckle(grid, w, h, passes) {
    for (let p = 0; p < passes; p++) {
      let changed = 0;
      const src = grid.map((r) => r.slice());
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const c = src[y][x];
          const counts = {};
          let same = 0, tot = 0, bestV = c, bestN = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const v = src[ny][nx];
              tot++;
              if (v === c) same++;
              counts[v] = (counts[v] || 0) + 1;
              if (counts[v] > bestN) { bestN = counts[v]; bestV = v; }
            }
          }
          // only smooth genuinely isolated pixels (keeps edges crisp)
          if (same <= 1 && bestV !== c && bestN >= 5) { grid[y][x] = bestV; changed++; }
        }
      }
      if (!changed) break;
    }
  }

  // order palette by luminance for a pleasant swatch row
  function orderByLuma(pal, grid, w, h) {
    const order = pal.map((c, i) => ({ i, l: 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] }));
    order.sort((a, b) => a.l - b.l);
    const remap = new Array(pal.length);
    order.forEach((o, newIdx) => { remap[o.i] = newIdx; });
    const newPal = order.map((o) => pal[o.i]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) grid[y][x] = remap[grid[y][x]];
    return newPal;
  }

  /**
   * Convert an already-loaded image source to a puzzle.
   * @param {CanvasImageSource} img  image / bitmap / canvas
   * @param {number} natW natural width
   * @param {number} natH natural height
   * @param {object} opts { maxDim=70, maxColors=22 }
   */
  PBN.imageToPuzzle = function (img, natW, natH, opts) {
    opts = opts || {};
    const maxDim = opts.maxDim || 150;
    const maxColors = opts.maxColors || 24;

    const scale = Math.min(1, maxDim / Math.max(natW, natH));
    const w = Math.max(8, Math.round(natW * scale));
    const h = Math.max(8, Math.round(natH * scale));

    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const c = cv.getContext('2d', { willReadFrequently: true });
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(img, 0, 0, w, h);
    const data = c.getImageData(0, 0, w, h).data;

    // gather samples (subsample if huge to keep median-cut fast)
    const px = w * h;
    const step = px > 6000 ? 2 : 1;
    const samples = [];
    for (let i = 0; i < px; i += step) {
      samples.push(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    }
    let pal = medianCut(new Uint8Array(samples), maxColors);
    const dd = dedupePalette(pal, 90);
    pal = dd.pal;

    // map every pixel to nearest palette colour -> grid (1-based)
    const grid = [];
    for (let y = 0; y < h; y++) {
      const row = [];
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        row.push(nearest(pal, data[o], data[o + 1], data[o + 2]));
      }
      grid.push(row);
    }

    despeckle(grid, w, h, 1);

    // drop palette entries no longer used, then order by luminance
    const used = new Set();
    for (const row of grid) for (const v of row) used.add(v);
    const compactMap = {}; const compactPal = [];
    [...used].sort((a, b) => a - b).forEach((old) => { compactMap[old] = compactPal.length; compactPal.push(pal[old]); });
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) grid[y][x] = compactMap[grid[y][x]];

    const finalPal = orderByLuma(compactPal, grid, w, h);

    // shift to 1-based (0 stays reserved for "no cell")
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) grid[y][x] += 1;

    return { w, h, palette: finalPal.map((c) => toHex(c[0], c[1], c[2])), grid };
  };

  /**
   * Split a colour grid into connected flat-colour REGIONS (the numbered areas
   * of a true paint-by-number). Tiny specks are merged into the surrounding
   * colour so the puzzle is clean and the finished art reads like the photo.
   * Mutates `grid` so its colours match the merged regions.
   * Returns { region:Int32Array(w*h), regionColor:Uint8Array, count,
   *           centroids:[{x,y,size}], cells:[Int32Array...], size:Int32Array }
   */
  PBN.buildRegions = function (grid, w, h, opts) {
    opts = opts || {};
    const N = w * h;
    const col = new Uint8Array(N);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) col[y * w + x] = grid[y][x];
    const minSize = opts.minSize || Math.max(4, Math.round(N / 1400));

    function label() {
      const region = new Int32Array(N).fill(-1);
      let count = 0; const stack = [];
      for (let s = 0; s < N; s++) {
        if (region[s] !== -1) continue;
        const c = col[s]; region[s] = count; stack.length = 0; stack.push(s);
        while (stack.length) {
          const i = stack.pop(), x = i % w, y = (i / w) | 0;
          if (x > 0) { const j = i - 1; if (region[j] === -1 && col[j] === c) { region[j] = count; stack.push(j); } }
          if (x < w - 1) { const j = i + 1; if (region[j] === -1 && col[j] === c) { region[j] = count; stack.push(j); } }
          if (y > 0) { const j = i - w; if (region[j] === -1 && col[j] === c) { region[j] = count; stack.push(j); } }
          if (y < h - 1) { const j = i + w; if (region[j] === -1 && col[j] === c) { region[j] = count; stack.push(j); } }
        }
        count++;
      }
      return { region, count };
    }

    // iteratively dissolve sub-minSize regions into their dominant neighbour
    for (let pass = 0; pass < 5; pass++) {
      const { region, count } = label();
      const size = new Int32Array(count);
      for (let i = 0; i < N; i++) size[region[i]]++;
      let anySmall = false;
      for (let r = 0; r < count; r++) if (size[r] < minSize) { anySmall = true; break; }
      if (!anySmall) break;
      const tally = new Map();   // small regionId -> Map(neighbourColour -> count)
      for (let i = 0; i < N; i++) {
        const r = region[i]; if (size[r] >= minSize) continue;
        const x = i % w, y = (i / w) | 0, c = col[i];
        const ns = [];
        if (x > 0) ns.push(i - 1); if (x < w - 1) ns.push(i + 1);
        if (y > 0) ns.push(i - w); if (y < h - 1) ns.push(i + w);
        for (const j of ns) { const cc = col[j]; if (cc === c) continue; let m = tally.get(r); if (!m) { m = new Map(); tally.set(r, m); } m.set(cc, (m.get(cc) || 0) + 1); }
      }
      const newCol = new Int32Array(count).fill(-1);
      tally.forEach((m, r) => { let best = -1, bc = 0; m.forEach((cnt, cc) => { if (cnt > bc) { bc = cnt; best = cc; } }); newCol[r] = best; });
      let changed = false;
      for (let i = 0; i < N; i++) { const r = region[i]; if (size[r] < minSize && newCol[r] >= 0) { col[i] = newCol[r]; changed = true; } }
      if (!changed) break;
    }

    // Numbered units are BOUNDED TILES, not whole connected blobs — so a large
    // colour area is many cells to fill one-by-one (real paint-by-number), not
    // a single bucket-fill. Each (tile, colour) pair becomes one numbered cell.
    const bs = opts.blockSize || 6;
    const bw = Math.ceil(w / bs);
    let maxC = 0; for (let i = 0; i < N; i++) if (col[i] > maxC) maxC = col[i];
    const stride = maxC + 1;
    const keyToId = new Map();
    const region = new Int32Array(N);
    let count = 0;
    for (let i = 0; i < N; i++) {
      const x = i % w, y = (i / w) | 0;
      const key = (((y / bs) | 0) * bw + ((x / bs) | 0)) * stride + col[i];
      let id = keyToId.get(key);
      if (id === undefined) { id = count++; keyToId.set(key, id); }
      region[i] = id;
    }
    const regionColor = new Uint8Array(count), size = new Int32Array(count);
    const sumx = new Float64Array(count), sumy = new Float64Array(count);
    const cells = []; for (let r = 0; r < count; r++) cells.push([]);
    for (let i = 0; i < N; i++) { const r = region[i]; regionColor[r] = col[i]; sumx[r] += i % w; sumy[r] += (i / w) | 0; size[r]++; cells[r].push(i); }
    const centroids = new Array(count);
    for (let r = 0; r < count; r++) {
      const mx = sumx[r] / size[r], my = sumy[r] / size[r];
      let best = cells[r][0], bd = Infinity;
      for (const i of cells[r]) { const dx = (i % w) - mx, dy = ((i / w) | 0) - my, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } }
      centroids[r] = { x: best % w, y: (best / w) | 0, size: size[r] };
      cells[r] = Int32Array.from(cells[r]);
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) grid[y][x] = col[y * w + x];
    return { region, regionColor, count, centroids, cells, size };
  };

  // RLE helpers shared with the baker's format: flat [val,run,val,run,...]
  PBN.decodeRLE = function (rle, w, h) {
    const grid = [];
    let row = [], x = 0;
    for (let i = 0; i < rle.length; i += 2) {
      let v = rle[i], run = rle[i + 1];
      while (run-- > 0) {
        row.push(v); x++;
        if (x === w) { grid.push(row); row = []; x = 0; }
      }
    }
    if (row.length) grid.push(row);
    return grid;
  };

  PBN.encodeRLE = function (grid) {
    const rle = [];
    let prev = null, run = 0;
    for (const r of grid) for (const v of r) {
      if (v === prev) run++;
      else { if (prev !== null) rle.push(prev, run); prev = v; run = 1; }
    }
    if (prev !== null) rle.push(prev, run);
    return rle;
  };
})(window.PBN);
