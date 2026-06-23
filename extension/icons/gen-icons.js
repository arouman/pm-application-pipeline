/**
 * gen-icons.js — generates icon16.png, icon48.png, icon128.png
 *
 * Produces minimal 1-bit-depth palette PNGs: a solid petrol-teal (#005C6E)
 * square with a white "J" letterform. No npm dependencies — pure Node built-ins.
 *
 * This file is a dev utility; it is not loaded by the extension.
 *
 * Run:  node icons/gen-icons.js   (from the extension/ directory)
 */

import { writeFileSync } from "node:fs";
import { createHash }    from "node:crypto";
import { deflateSync }   from "node:zlib";
import { fileURLToPath } from "node:url";
import path              from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Minimal PNG encoder (RGBA, 8-bit)
// ---------------------------------------------------------------------------

/** Write a 4-byte big-endian unsigned integer. */
function uint32BE(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

/** Build a PNG chunk: length + type + data + CRC32. */
function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const crc = crc32(Buffer.concat([typeBytes, data]));
  return Buffer.concat([uint32BE(data.length), typeBytes, data, uint32BE(crc)]);
}

/** Standard PNG CRC32 (polynomial 0xEDB88320, reflected). */
function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Encode an RGBA pixel buffer into a valid PNG file buffer.
 *
 * @param {number}  width
 * @param {number}  height
 * @param {Buffer}  pixels  — width*height*4 bytes, row-major RGBA
 * @returns {Buffer}
 */
function encodePNG(width, height, pixels) {
  const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR: width, height, bit depth=8, color type=2 (RGB), compression=0,
  //       filter=0, interlace=0
  // We'll use color type 6 (RGBA) so we can set alpha=255 everywhere.
  const ihdrData = Buffer.concat([
    uint32BE(width),
    uint32BE(height),
    Buffer.from([8, 6, 0, 0, 0]),
  ]);

  // Build raw scanlines (filter byte 0 = None, then RGBA per pixel)
  const rowSize  = 1 + width * 4;
  const raw      = Buffer.alloc(height * rowSize);
  for (let y = 0; y < height; y++) {
    raw[y * rowSize] = 0; // filter type: None
    for (let x = 0; x < width; x++) {
      const srcOff = (y * width + x) * 4;
      const dstOff = y * rowSize + 1 + x * 4;
      raw[dstOff]     = pixels[srcOff];     // R
      raw[dstOff + 1] = pixels[srcOff + 1]; // G
      raw[dstOff + 2] = pixels[srcOff + 2]; // B
      raw[dstOff + 3] = pixels[srcOff + 3]; // A
    }
  }

  const compressed = deflateSync(raw, { level: 9 });

  const ihdrChunk = chunk("IHDR", ihdrData);
  const idatChunk = chunk("IDAT", compressed);
  const iendChunk = chunk("IEND", Buffer.alloc(0));

  return Buffer.concat([SIGNATURE, ihdrChunk, idatChunk, iendChunk]);
}

// ---------------------------------------------------------------------------
// Draw petrol-teal square with a simple "J" glyph
// ---------------------------------------------------------------------------

/** Petrol-teal brand colour: #005C6E → R=0, G=92, B=110 */
const BG   = [0,   92,  110, 255];
/** White letter */
const FG   = [255, 255, 255, 255];
/** Slightly darker teal for the border ring */
const RING = [0,   72,  86,  255];

/**
 * Generates pixel data for an icon of `size × size` pixels.
 * Design: teal background, thin dark border, white "J" letter centred.
 *
 * @param {number} size
 * @returns {Buffer}
 */
function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);

  function setPixel(x, y, color) {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const off = (y * size + x) * 4;
    pixels[off]     = color[0];
    pixels[off + 1] = color[1];
    pixels[off + 2] = color[2];
    pixels[off + 3] = color[3];
  }

  // Fill background
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      setPixel(x, y, BG);
    }
  }

  // 1-pixel border ring
  for (let i = 0; i < size; i++) {
    setPixel(i,      0,        RING);
    setPixel(i,      size - 1, RING);
    setPixel(0,      i,        RING);
    setPixel(size - 1, i,      RING);
  }

  // Draw a simple "J" using a normalised coordinate system so it scales.
  // The letter occupies roughly 30–70% of the icon width and 20–80% height.
  const strokeW = Math.max(1, Math.round(size * 0.11));
  const x0 = Math.round(size * 0.30); // left edge of J stem
  const x1 = Math.round(size * 0.70); // right edge of J stem
  const y0 = Math.round(size * 0.20); // top of J
  const y1 = Math.round(size * 0.80); // bottom of J
  const cx  = Math.round(size * 0.40); // centre of the J curve

  // Vertical stem (right portion of J)
  const stemX = Math.round((x0 + x1) / 2);
  for (let y = y0; y <= Math.round(size * 0.60); y++) {
    for (let dx = 0; dx < strokeW; dx++) {
      setPixel(stemX + dx, y, FG);
    }
  }

  // Top horizontal bar
  for (let x = x0; x <= x1; x++) {
    for (let dy = 0; dy < strokeW; dy++) {
      setPixel(x, y0 + dy, FG);
    }
  }

  // Curved hook at bottom: approximate with a few pixel rows
  const hookBottom  = y1;
  const hookTop     = Math.round(size * 0.58);
  const hookLeft    = Math.round(size * 0.25);
  const hookRight   = stemX + strokeW;
  const hookCenterX = Math.round((hookLeft + hookRight) / 2);
  const hookCenterY = hookBottom - Math.round(size * 0.10);
  const hookRadius  = Math.round((hookRight - hookLeft) / 2);

  // Rasterise lower-half of a circle
  for (let y = hookCenterY; y <= hookBottom; y++) {
    for (let x = hookLeft; x <= hookRight; x++) {
      const dx = x - hookCenterX;
      const dy = y - hookCenterY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist >= hookRadius - strokeW && dist <= hookRadius) {
        setPixel(x, y, FG);
      }
    }
  }

  // Short vertical segment connecting stem to hook
  for (let y = hookTop; y <= hookCenterY; y++) {
    for (let dx = 0; dx < strokeW; dx++) {
      setPixel(stemX + dx, y, FG);
    }
  }

  return pixels;
}

// ---------------------------------------------------------------------------
// Generate and write
// ---------------------------------------------------------------------------

for (const size of [16, 48, 128]) {
  const pixels = drawIcon(size);
  const png    = encodePNG(size, size, pixels);
  const outPath = path.join(__dirname, `icon${size}.png`);
  writeFileSync(outPath, png);
  console.log(`wrote ${outPath}  (${png.length} bytes)`);
}
