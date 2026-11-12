import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y, width, height);
      const i = row + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const GLYPHS = {
  S: ["01110", "10001", "10000", "01110", "00001", "10001", "01110"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
};

function blit(word, scale, ox, oy, paint) {
  let x = ox;
  for (const char of word) {
    const rows = GLYPHS[char];
    rows.forEach((row, y) => {
      [...row].forEach((bit, col) => {
        if (bit !== "1") return;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) paint(x + col * scale + dx, oy + y * scale + dy);
        }
      });
    });
    x += 6 * scale;
  }
}

function card(width, height) {
  const ink = new Set();
  blit("SLUICE", 14, 90, 230, (x, y) => ink.add(`${x},${y}`));
  return png(width, height, (x, y, w, h) => {
    if (ink.has(`${x},${y}`)) return [214, 242, 92, 255];
    if (y > h * 0.62 && y < h * 0.62 + 18 && x > 80 && x < w - 80) return [214, 242, 92, 255];
    if (x > 80 && x < 110 && y > 80 && y < h - 80) return [243, 239, 228, 255];
    if (x > w - 110 && x < w - 80 && y > 80 && y < h - 80) return [243, 239, 228, 255];
    if (y > h * 0.62 + 18 && y < h - 90 && x > 110 && x < w - 110) return [126, 208, 194, 255];
    return [16, 18, 14, 255];
  });
}

function icon(size) {
  return png(size, size, (x, y) => {
    const pillar = (x >= 8 && x <= 16) || (x >= size - 17 && x <= size - 9);
    const bar = y >= 22 && y <= 30 && x >= 8 && x <= size - 9;
    const water = y > 30 && y < size - 10 && x > 16 && x < size - 17;
    if (pillar) return [243, 239, 228, 255];
    if (bar) return [214, 242, 92, 255];
    if (water) return [126, 208, 194, 255];
    return [20, 22, 15, 255];
  });
}

writeFileSync(new URL("../web/og.png", import.meta.url), card(1200, 630));
writeFileSync(new URL("../web/favicon.png", import.meta.url), icon(64));
