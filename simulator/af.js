/* af.js — PicoVector Alright Font (.af) parser and renderer
 *
 * AF binary layout (all multi-byte fields big-endian):
 *   4B  magic "af!?"
 *   2B  flags  (bit 0: path point counts are u16 rather than u8)
 *   2B  glyph_count
 *   2B  total path_count  (informational; not needed after parsing)
 *   2B  total point_count (informational; not needed after parsing)
 *
 *   glyph_count × glyph record:
 *     2B  codepoint (u16)
 *     1B  x offset  (i8, bounding box)
 *     1B  y offset  (i8, bounding box; negative = above baseline)
 *     1B  width     (u8)
 *     1B  height    (u8)
 *     1B  advance   (u8, in font units; scale by size/128 for pixels)
 *     1B  nPaths    (u8, number of contour paths)
 *
 *   then path-point-count table (nPaths entries per glyph):
 *     u8 or u16 per path depending on flags bit 0
 *
 *   then point data (all paths of all glyphs in order):
 *     i8 x, i8 y  per point (font-unit coordinates, 0..128 range)
 *
 * Coordinate system:
 *   y=0 is the baseline; negative y is above the baseline.
 *   To draw at screen (x, y) at pixel size `size`:
 *     ctx.translate(x, y + size); ctx.scale(size/128, size/128);
 *   Paths are closed straight-line polygons; use even-odd fill for holes.
 */

/**
 * Parse an .af ArrayBuffer.
 * Returns a font object suitable for afMeasure / afRender / afPreview.
 */
export function afParse(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  let off   = 0;

  if (String.fromCharCode(
    dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)
  ) !== 'af!?') throw new Error('Not an AF font file');
  off = 4;

  const flags      = dv.getUint16(off); off += 2;
  const glyphCount = dv.getUint16(off); off += 2;
  off += 4; // skip total path_count and point_count

  /* glyph dictionary */
  const glyphs = [];
  for (let i = 0; i < glyphCount; i++) {
    const codepoint = dv.getUint16(off); off += 2;
    const x         = dv.getInt8(off);   off += 1;
    const y         = dv.getInt8(off);   off += 1;
    const w         = dv.getUint8(off);  off += 1;
    const h         = dv.getUint8(off);  off += 1;
    const advance   = dv.getUint8(off);  off += 1;
    const nPaths    = dv.getUint8(off);  off += 1;
    glyphs.push({ codepoint, x, y, w, h, advance, nPaths, paths: [] });
  }

  /* path-point-count table */
  const useU16 = !!(flags & 0b1);
  for (const g of glyphs) {
    for (let j = 0; j < g.nPaths; j++) {
      const pc = useU16 ? dv.getUint16(off) : dv.getUint8(off);
      off += useU16 ? 2 : 1;
      g.paths.push({ pc, points: new Int8Array(pc * 2) });
    }
  }

  /* point data — stored as raw bytes interpreted as int8 */
  for (const g of glyphs) {
    for (const p of g.paths) {
      for (let k = 0; k < p.pc * 2; k++) {
        p.points[k] = dv.getInt8(off++);
      }
    }
  }

  const cpMap = new Map();
  glyphs.forEach((g, i) => cpMap.set(g.codepoint, i));

  return { glyphCount, glyphs, cpMap };
}

/**
 * Measure the pixel width of a string at the given size.
 */
export function afMeasure(font, text, size) {
  const scale = size / 128;
  let w = 0;
  for (const ch of text) {
    const idx = font.cpMap.get(ch.codePointAt(0));
    if (idx !== undefined) w += font.glyphs[idx].advance * scale;
  }
  return w;
}

/**
 * Render a string onto a 2D canvas context at pixel coordinates (x, y).
 * `size` is the em-height in pixels (equivalent to CSS font-size).
 * Returns the total advance width in pixels.
 *
 * The caller sets ctx.fillStyle before calling if a single colour is desired,
 * or passes `color` to override it per-call.
 */
export function afRender(font, ctx, text, x, y, size, color = '#ffffff') {
  const scale = size / 128;
  let cx = x;
  ctx.fillStyle = color;
  for (const ch of text) {
    const cp  = ch.codePointAt(0);
    const idx = font.cpMap.get(cp);
    if (idx === undefined) continue;
    const glyph = font.glyphs[idx];
    if (glyph.nPaths > 0) {
      ctx.save();
      ctx.translate(cx, y + size);
      ctx.scale(scale, scale);
      ctx.beginPath();
      for (const path of glyph.paths) {
        const pts = path.points;
        if (path.pc < 2) continue;
        ctx.moveTo(pts[0], pts[1]);
        for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
        ctx.closePath();
      }
      ctx.fill('evenodd');
      ctx.restore();
    }
    cx += glyph.advance * scale;
  }
  return cx - x;
}

/**
 * Render a preview canvas for the font showing sample characters.
 * Returns { dataUrl, dimText }.
 *
 * Options:
 *   size     (default 36) — em-height in font pixels
 *   bg       (default '#16161e') — background colour
 *   fg       (default '#f0e8d8') — glyph colour
 *   pad      (default 12) — padding in screen pixels
 *   lineGap  (default 8)  — extra gap between lines
 *   lines    — array of sample strings
 */
export function afPreview(font, options = {}) {
  const size    = options.size    ?? 36;
  const bg      = options.bg      ?? '#16161e';
  const fg      = options.fg      ?? '#f0e8d8';
  const pad     = options.pad     ?? 12;
  const lineGap = options.lineGap ?? 8;
  const lines   = options.lines   ?? [
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'abcdefghijklmnopqrstuvwxyz',
    '0123456789 !?@#$%^&*()-+=',
    '[]{}|;:\'",.<>/?`~\\',
  ];

  const maxLineW = Math.max(...lines.map(l => afMeasure(font, l, size)));
  const lineH    = size + lineGap;
  const canvasW  = Math.ceil(maxLineW + pad * 2);
  const canvasH  = Math.ceil(lines.length * lineH + pad * 2);

  const canvas  = document.createElement('canvas');
  canvas.width  = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvasW, canvasH);

  for (let li = 0; li < lines.length; li++) {
    afRender(font, ctx, lines[li], pad, pad + li * lineH, size, fg);
  }

  const dimText = `vector · ${font.glyphCount} glyphs`;
  return { imgUrl: canvas.toDataURL(), dimText };
}
