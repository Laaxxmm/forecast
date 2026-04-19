// ─────────────────────────────────────────────────────────────────────────────
// build-icon.js — generates resources/icon.png (256×256) and resources/icon.ico
// (single 256×256 entry with an embedded PNG) with ZERO dependencies beyond
// Node's stdlib (zlib).
//
// Why we roll our own: electron-builder needs a real .ico on Windows and a
// real .png for the tray, and we don't want to pull in sharp/png-to-ico just
// for a placeholder icon.  Graphics are kept deliberately simple (solid
// emerald square + white "V" monogram) — when Magnacode wants a real brand
// icon, drop icon.png at 256×256 over this one and re-run the wrap step, or
// swap in the final ICO and skip this script entirely.
//
// Usage:  node scripts/build-icon.js
//         node scripts/build-icon.js --wrap-only   # skip regenerating the
//                                                  # PNG, just wrap whatever
//                                                  # icon.png is on disk
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ARGS = new Set(process.argv.slice(2));
const WRAP_ONLY = ARGS.has('--wrap-only');

const OUT_DIR = path.join(__dirname, '..', 'resources');
const PNG_PATH = path.join(OUT_DIR, 'icon.png');
const ICO_PATH = path.join(OUT_DIR, 'icon.ico');
const SIZE = 256;

// ── CRC32 (needed for PNG chunk trailers) ───────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── PNG chunk writer ────────────────────────────────────────────────────────
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// ── Pixel generator: emerald gradient background + white "V" mark ──────────
// All math in JS.  For a placeholder this is fine — the renderer loops over
// 256×256 = 65k pixels once at build time.
function buildPixelsRGBA() {
  const w = SIZE, h = SIZE;
  const buf = Buffer.alloc(h * (1 + w * 4)); // +1 filter byte per row
  const cx = w / 2, cy = h / 2;
  const rOuter = 120;        // bounding circle
  const rInner = 105;        // inner ring
  // "V" strokes (two diagonal lines meeting at bottom-center)
  const strokeHalf = 12;
  const vTopY = 70, vBotY = 180;
  const vLeftX = 80, vRightX = 176, vMidX = 128;

  // Pre-compute line vectors for distance-to-segment tests.
  const leftVx = vMidX - vLeftX, leftVy = vBotY - vTopY;
  const leftLen2 = leftVx * leftVx + leftVy * leftVy;
  const rightVx = vMidX - vRightX, rightVy = vBotY - vTopY;
  const rightLen2 = rightVx * rightVx + rightVy * rightVy;

  function distToSeg(px, py, ax, ay, vx, vy, len2) {
    let t = ((px - ax) * vx + (py - ay) * vy) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const qx = ax + t * vx, qy = ay + t * vy;
    const dx = px - qx, dy = py - qy;
    return Math.sqrt(dx * dx + dy * dy);
  }

  let p = 0;
  for (let y = 0; y < h; y++) {
    buf[p++] = 0; // PNG filter-type byte "None" per scanline
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      const rd = Math.sqrt(dx * dx + dy * dy);

      let r = 0, g = 0, b = 0, a = 0;

      if (rd <= rOuter) {
        // Emerald gradient — lighter top-left, darker bottom-right.
        const shade = (x + y) / (2 * (w - 1)); // 0..1
        r = Math.round(16 + shade * 6);        // 16..22
        g = Math.round(185 - shade * 40);      // 185..145
        b = Math.round(129 - shade * 20);      // 129..109
        a = 255;

        // Inner ring highlight
        if (rd > rInner && rd <= rOuter) {
          r = Math.min(255, r + 10);
          g = Math.min(255, g + 20);
          b = Math.min(255, b + 20);
        }

        // "V" monogram — distance to either of the two segments.
        const dL = distToSeg(x, y, vLeftX, vTopY, leftVx, leftVy, leftLen2);
        const dR = distToSeg(x, y, vRightX, vTopY, rightVx, rightVy, rightLen2);
        if (dL <= strokeHalf || dR <= strokeHalf) {
          r = 255; g = 255; b = 255; a = 255;
        }
      }

      buf[p++] = r;
      buf[p++] = g;
      buf[p++] = b;
      buf[p++] = a;
    }
  }
  return buf;
}

function encodePNG(pixels, width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const idat = zlib.deflateSync(pixels, { level: zlib.constants.Z_BEST_COMPRESSION });
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── ICO wrapper around a single PNG ─────────────────────────────────────────
// Format: ICONDIR (6) + ICONDIRENTRY (16) + PNG payload.  Windows treats a
// width/height of 0 as "256".
function wrapPngAsIco(png) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);   // reserved
  dir.writeUInt16LE(1, 2);   // type = icon
  dir.writeUInt16LE(1, 4);   // count = 1
  const entry = Buffer.alloc(16);
  entry[0] = 0;              // width (0 = 256)
  entry[1] = 0;              // height (0 = 256)
  entry[2] = 0;              // palette
  entry[3] = 0;              // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(6 + 16, 12); // offset to payload
  return Buffer.concat([dir, entry, png]);
}

// ── Run ─────────────────────────────────────────────────────────────────────
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

let png;
if (WRAP_ONLY) {
  if (!fs.existsSync(PNG_PATH)) {
    console.error(`[build-icon] --wrap-only requested but ${PNG_PATH} does not exist`);
    process.exit(1);
  }
  png = fs.readFileSync(PNG_PATH);
  console.log(`[build-icon] reusing ${path.relative(process.cwd(), PNG_PATH)} (${png.length} bytes)`);
} else {
  const pixels = buildPixelsRGBA();
  png = encodePNG(pixels, SIZE, SIZE);
  fs.writeFileSync(PNG_PATH, png);
  console.log(`[build-icon] wrote ${path.relative(process.cwd(), PNG_PATH)} (${png.length} bytes, ${SIZE}x${SIZE})`);
}

const ico = wrapPngAsIco(png);
fs.writeFileSync(ICO_PATH, ico);
console.log(`[build-icon] wrote ${path.relative(process.cwd(), ICO_PATH)} (${ico.length} bytes)`);
