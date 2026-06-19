/* puzzles.js — decode the baked built-in gallery (js/puzzle-data.js) into the
 * runtime puzzle shape the game uses: { id, name, emoji, w, h, palette, grid }.
 * grid[y][x] is a 1-based palette index (photos fill every cell). */
(function (global) {
  'use strict';
  const data = global.PUZZLE_DATA || [];
  global.PUZZLES = data.map((d) => ({
    id: d.id,
    name: d.name,
    emoji: d.emoji,
    w: d.w,
    h: d.h,
    palette: d.palette,
    grid: global.PBN.decodeRLE(d.rle, d.w, d.h),
  }));
})(window);
