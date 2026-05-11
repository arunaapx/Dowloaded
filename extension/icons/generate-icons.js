// One-shot generator: creates PNG icons in the sizes Chrome's MV3 accepts.
// Run with: node extension/icons/generate-icons.js
// Produces a gradient V-logo at 16/48/128 px.

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function lerp(a, b, t) { return a + (b - a) * t; }
function blend(bg, fg, alpha) {
  return [
    Math.round(lerp(bg[0], fg[0], alpha)),
    Math.round(lerp(bg[1], fg[1], alpha)),
    Math.round(lerp(bg[2], fg[2], alpha)),
    255,
  ];
}

function makeIcon(size) {
  // Background gradient: top-left cyan -> bottom-right purple.
  // Foreground: white "V" stroke + underline.
  const c1 = [108, 196, 255]; // #6cc4ff
  const c2 = [167, 139, 250]; // #a78bfa
  const fg = [255, 255, 255];

  const radius = Math.round(size * 0.22); // rounded corners

  // V geometry (in fractional units of size)
  const stroke = Math.max(1, Math.round(size * 0.085));
  const vTopY = size * 0.30;
  const vBotY = size * 0.66;
  const vLeftX = size * 0.30;
  const vRightX = size * 0.70;
  const vMidX = size * 0.50;

  const ulY = size * 0.78;
  const ulLeftX = size * 0.27;
  const ulRightX = size * 0.73;
  const ulHalf = Math.max(1, Math.round(size * 0.035));

  // Distance from point p to segment ab
  function distToSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    const ex = px - cx, ey = py - cy;
    return Math.sqrt(ex * ex + ey * ey);
  }
  function distToRect(px, py, x0, y0, x1, y1) {
    const cx = Math.max(x0, Math.min(px, x1));
    const cy = Math.max(y0, Math.min(py, y1));
    const dx = px - cx, dy = py - cy;
    return Math.sqrt(dx * dx + dy * dy);
  }

  const row = Buffer.alloc(1 + size * 4);
  const raw = Buffer.alloc(size * row.length);

  for (let y = 0; y < size; y++) {
    row.fill(0);
    for (let x = 0; x < size; x++) {
      // Rounded square mask
      let alpha = 1;
      if (x < radius && y < radius) {
        const dx = radius - x, dy = radius - y;
        const d = Math.sqrt(dx * dx + dy * dy);
        alpha = d <= radius ? 1 : 0;
      } else if (x >= size - radius && y < radius) {
        const dx = x - (size - radius - 1), dy = radius - y;
        const d = Math.sqrt(dx * dx + dy * dy);
        alpha = d <= radius ? 1 : 0;
      } else if (x < radius && y >= size - radius) {
        const dx = radius - x, dy = y - (size - radius - 1);
        const d = Math.sqrt(dx * dx + dy * dy);
        alpha = d <= radius ? 1 : 0;
      } else if (x >= size - radius && y >= size - radius) {
        const dx = x - (size - radius - 1), dy = y - (size - radius - 1);
        const d = Math.sqrt(dx * dx + dy * dy);
        alpha = d <= radius ? 1 : 0;
      }

      if (alpha === 0) {
        // Transparent corner
        row[1 + x * 4 + 0] = 0;
        row[1 + x * 4 + 1] = 0;
        row[1 + x * 4 + 2] = 0;
        row[1 + x * 4 + 3] = 0;
        continue;
      }

      // Gradient background
      const t = (x + y) / (2 * (size - 1));
      const bg = [
        Math.round(lerp(c1[0], c2[0], t)),
        Math.round(lerp(c1[1], c2[1], t)),
        Math.round(lerp(c1[2], c2[2], t)),
      ];

      // V strokes (two segments)
      const dV1 = distToSeg(x + 0.5, y + 0.5, vLeftX, vTopY, vMidX, vBotY);
      const dV2 = distToSeg(x + 0.5, y + 0.5, vMidX, vBotY, vRightX, vTopY);
      const dUL = distToRect(x + 0.5, y + 0.5, ulLeftX, ulY - ulHalf, ulRightX, ulY + ulHalf);

      // Anti-aliased coverage
      const half = stroke / 2;
      let coverV = Math.max(
        Math.min(1, half - Math.min(dV1, dV2) + 0.5),
        0
      );
      let coverUL = Math.max(Math.min(1, ulHalf - dUL + 0.5), 0);
      const cover = Math.max(coverV, coverUL);

      const out = blend(bg, fg, cover);
      row[1 + x * 4 + 0] = out[0];
      row[1 + x * 4 + 1] = out[1];
      row[1 + x * 4 + 2] = out[2];
      row[1 + x * 4 + 3] = 255;
    }
    row.copy(raw, y * row.length);
  }

  const idat = zlib.deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const sizes = [16, 32, 48, 128];
const outDir = __dirname;
for (const s of sizes) {
  const buf = makeIcon(s);
  const file = path.join(outDir, `icon-${s}.png`);
  fs.writeFileSync(file, buf);
  console.log('wrote', file, buf.length, 'bytes');
}
