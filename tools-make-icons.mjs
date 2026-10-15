// Generates the extension icons (blue rounded square with "RU") without dependencies.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const FONT = {
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110']
};

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function render(size) {
  const ss = 4; // supersampling
  const S = size * ss;
  const px = new Float64Array(size * size * 4);
  const r = S * 0.22;
  const glyphH = 7, glyphW = 5, gap = 1;
  const cell = Math.floor(S * 0.62 / (glyphW * 2 + gap));
  const textW = cell * (glyphW * 2 + gap), textH = cell * glyphH;
  const ox = Math.floor((S - textW) / 2), oy = Math.floor((S - textH) / 2);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const cx = Math.min(Math.max(x, r), S - r), cy = Math.min(Math.max(y, r), S - r);
    if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
    let col = [31, 111, 235];
    const gx = Math.floor((x - ox) / cell), gy = Math.floor((y - oy) / cell);
    if (gy >= 0 && gy < glyphH && gx >= 0 && gx < glyphW * 2 + gap) {
      const letter = gx < glyphW ? 'R' : gx > glyphW ? 'U' : null;
      const lx = gx < glyphW ? gx : gx - glyphW - gap;
      if (letter && FONT[letter][gy][lx] === '1') col = [255, 255, 255];
    }
    const i = (Math.floor(y / ss) * size + Math.floor(x / ss)) * 4;
    px[i] += col[0]; px[i + 1] += col[1]; px[i + 2] += col[2]; px[i + 3] += 255;
  }
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4, a = px[i + 3];
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? Math.round(px[i] / (a / 255)) : 0;
      raw[o + 1] = a ? Math.round(px[i + 1] / (a / 255)) : 0;
      raw[o + 2] = a ? Math.round(px[i + 2] / (a / 255)) : 0;
      raw[o + 3] = Math.round(a / (ss * ss));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

const outDir = process.argv[2];
for (const size of [16, 48, 128]) writeFileSync(`${outDir}/icon${size}.png`, render(size));
