/**
 * Gera os ícones do app (quadrado arredondado verde-sálvia com um "M" branco)
 * sem depender de ImageMagick ou de assets binários vindos de fora.
 *
 *   node scripts/gen-icons.mjs
 *
 * Saída em src-tauri/icons/: 32x32.png, 128x128.png, 128x128@2x.png,
 * icon.png (512), tray.png (32) e icon.ico (multi-resolução, entradas PNG).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../src-tauri/icons');

const SAGE = [0x8a, 0x9a, 0x5b];
const WHITE = [0xff, 0xff, 0xff];
const SS = 3; // supersampling por eixo (antialiasing)

/** Segmentos normalizados que desenham o "M". */
const STROKES = [
  [0.31, 0.34, 0.31, 0.66],
  [0.69, 0.34, 0.69, 0.66],
  [0.31, 0.34, 0.5, 0.585],
  [0.69, 0.34, 0.5, 0.585],
];
const HALF_W = 0.056;
const CORNER = 0.22;

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Está dentro do quadrado arredondado [0,1]²? */
function inRoundedSquare(u, v) {
  const r = CORNER;
  const cx = Math.min(Math.max(u, r), 1 - r);
  const cy = Math.min(Math.max(v, r), 1 - r);
  const dx = u - cx;
  const dy = v - cy;
  if (dx === 0 || dy === 0) return true;
  return Math.hypot(dx, dy) <= r;
}

function inLetter(u, v) {
  for (const [x1, y1, x2, y2] of STROKES) {
    if (distToSegment(u, v, x1, y1, x2, y2) <= HALF_W) return true;
  }
  return false;
}

function renderPng(size) {
  const png = new PNG({ width: size, height: size });
  const samples = SS * SS;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          if (!inRoundedSquare(u, v)) continue;
          bg += 1;
          if (inLetter(u, v)) fg += 1;
        }
      }
      const idx = (size * y + x) << 2;
      if (bg === 0) {
        png.data[idx] = 0;
        png.data[idx + 1] = 0;
        png.data[idx + 2] = 0;
        png.data[idx + 3] = 0;
        continue;
      }
      const letterRatio = fg / bg;
      for (let c = 0; c < 3; c++) {
        png.data[idx + c] = Math.round(SAGE[c] * (1 - letterRatio) + WHITE[c] * letterRatio);
      }
      png.data[idx + 3] = Math.round((bg / samples) * 255);
    }
  }

  return PNG.sync.write(png);
}

/** ICO com entradas PNG (suportado por Windows Vista+). */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;

  entries.forEach(({ size, data }, i) => {
    const at = i * 16;
    dir[at] = size >= 256 ? 0 : size;
    dir[at + 1] = size >= 256 ? 0 : size;
    dir[at + 2] = 0;
    dir[at + 3] = 0;
    dir.writeUInt16LE(1, at + 4);
    dir.writeUInt16LE(32, at + 6);
    dir.writeUInt32LE(data.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

mkdirSync(OUT, { recursive: true });

const cache = new Map();
const png = (size) => {
  if (!cache.has(size)) cache.set(size, renderPng(size));
  return cache.get(size);
};

const files = {
  '32x32.png': 32,
  '128x128.png': 128,
  '128x128@2x.png': 256,
  'icon.png': 512,
  'tray.png': 32,
};

for (const [name, size] of Object.entries(files)) {
  writeFileSync(resolve(OUT, name), png(size));
  console.log(`icons/${name} (${size}px)`);
}

const ico = buildIco([16, 32, 48, 64, 128, 256].map((size) => ({ size, data: png(size) })));
writeFileSync(resolve(OUT, 'icon.ico'), ico);
console.log(`icons/icon.ico (${ico.length} bytes)`);
