/* ppf.js — PicoVector PixelFont (.ppf) parser and renderer
 *
 * PPF binary layout (all multi-byte fields big-endian):
 *   4B  magic "ppf!"
 *   2B  flags
 *   4B  glyph_count
 *   2B  cell_width   (max glyph cell width; used for bytes-per-row)
 *   2B  glyph_height
 *  32B  font name (null-padded ASCII)
 *   N × 6B  glyph table: { codepoint: u32, width: u16 }
 *   N × (bpr * glyph_height)B  pixel data, 1 bit/pixel MSB-first
 *   where bpr = ceil(cell_width / 8)
 */

/**
 * Parse a .ppf ArrayBuffer.
 * Returns a font object suitable for passing to ppfMeasure / ppfRender / ppfPreview.
 */
function ppfParse(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const u8 = new Uint8Array(arrayBuffer);
  let off  = 0;

  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'ppf!')
    throw new Error('Not a PPF font file');
  off = 4;

  /* header */
  off += 2; // flags (unused)
  const glyphCount  = dv.getUint32(off); off += 4;
  const cellWidth   = dv.getUint16(off); off += 2;
  const glyphHeight = dv.getUint16(off); off += 2;

  let name = '';
  for (let i = 0; i < 32; i++) {
    const c = u8[off + i];
    if (c === 0) break;
    name += String.fromCharCode(c);
  }
  off += 32;

  /* glyph table */
  const glyphs = [];
  for (let i = 0; i < glyphCount; i++) {
    const codepoint = dv.getUint32(off); off += 4;
    const width     = dv.getUint16(off); off += 2;
    glyphs.push({ codepoint, width });
  }

  /* pixel data */
  const bpr           = (cellWidth + 7) >> 3;
  const glyphDataSize = bpr * glyphHeight;
  const glyphData     = [];
  for (let i = 0; i < glyphCount; i++) {
    glyphData.push(u8.slice(off, off + glyphDataSize));
    off += glyphDataSize;
  }

  /* codepoint → glyph-index lookup */
  const cpMap = new Map();
  glyphs.forEach((g, i) => cpMap.set(g.codepoint, i));

  return { name, glyphCount, cellWidth, glyphHeight, glyphs, glyphData, cpMap, bpr };
}

/**
 * Measure the pixel width of a string in the given font.
 * Space (U+0020) is treated as cell_width / 3, matching PicoVector's draw logic.
 */
function ppfMeasure(font, text) {
  const spaceW = Math.ceil(font.cellWidth / 3);
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === 32) { w += spaceW; continue; }
    const idx = font.cpMap.get(cp);
    if (idx !== undefined) w += font.glyphs[idx].width + 1;
  }
  return w;
}

/**
 * Render a string onto a 2D canvas context at pixel coordinates (x, y).
 * Each set pixel is drawn as a 1×1 fillRect — scale via ctx transforms if needed.
 * Returns the total advance width (px).
 */
function ppfRender(font, ctx, text, x, y, color = '#ffffff') {
  const spaceW = Math.ceil(font.cellWidth / 3);
  let cx = x;
  ctx.fillStyle = color;
  for (const ch of text) {
    const cp  = ch.codePointAt(0);
    if (cp === 32) { cx += spaceW; continue; }
    const idx = font.cpMap.get(cp);
    if (idx === undefined) continue;
    const glyph = font.glyphs[idx];
    const data  = font.glyphData[idx];
    for (let row = 0; row < font.glyphHeight; row++) {
      for (let col = 0; col < glyph.width; col++) {
        if ((data[row * font.bpr + (col >> 3)] >> (7 - (col & 7))) & 1) {
          ctx.fillRect(cx + col, y + row, 1, 1);
        }
      }
    }
    cx += glyph.width + 1;
  }
  return cx - x;
}

/**
 * Render a preview canvas for the font showing sample characters.
 * Returns { dataUrl, dimText } — dimText is a human-readable size/glyph-count string.
 *
 * Options:
 *   scale    (default 4)  — integer pixel scale factor
 *   bg       (default '#16161e') — background colour
 *   fg       (default '#f0e8d8') — glyph colour
 *   pad      (default 10) — padding in font-pixels
 *   lineGap  (default 4)  — gap between lines in font-pixels
 *   lines    — array of sample strings (defaults to a-z/A-Z/0-9/symbols)
 */
function ppfPreview(font, options = {}) {
  const scale   = options.scale   ?? 4;
  const bg      = options.bg      ?? '#16161e';
  const fg      = options.fg      ?? '#f0e8d8';
  const pad     = options.pad     ?? 10;
  const lineGap = options.lineGap ?? 4;
  const lines   = options.lines   ?? [
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'abcdefghijklmnopqrstuvwxyz',
    '0123456789 !?@#$%^&*()-+=',
    '[]{}|;:\'",.<>/?`~\\',
  ];

  const maxLineW = Math.max(...lines.map(l => ppfMeasure(font, l)));
  const lineH    = font.glyphHeight + lineGap;
  const canvasW  = (maxLineW + pad * 2) * scale;
  const canvasH  = (lines.length * lineH + pad * 2) * scale;

  const canvas  = document.createElement('canvas');
  canvas.width  = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvasW, canvasH);

  ctx.save();
  ctx.scale(scale, scale);
  for (let li = 0; li < lines.length; li++) {
    ppfRender(font, ctx, lines[li], pad, pad + li * lineH, fg);
  }
  ctx.restore();

  const dimText = `${font.cellWidth}×${font.glyphHeight} px · ${font.glyphCount} glyphs`;
  return { imgUrl: canvas.toDataURL(), dimText };
}
