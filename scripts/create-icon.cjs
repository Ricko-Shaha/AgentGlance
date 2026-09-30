const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// A small, dependency-free rasterizer for the app's native pulse icon.
const points = [[52, 136], [91, 136], [111, 87], [140, 174], [163, 121], [204, 121]];
function distance(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
}
function renderPng(size) {
const pixels = Buffer.alloc(size * (size * 4 + 1));
const scale = size / 256;
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    const sx = (x + 0.5) / scale - 0.5;
    const sy = (y + 0.5) / scale - 0.5;
    const rounded = Math.hypot(Math.max(0, Math.abs(sx - 127.5) - 78), Math.max(0, Math.abs(sy - 127.5) - 78));
    const alpha = Math.round(255 * Math.max(0, Math.min(1, (46 - rounded) * scale)));
    const stroke = Math.min(...points.slice(1).map((point, index) => distance(sx, sy, points[index], point)));
    const mix = Math.max(0, Math.min(1, (7.5 - stroke) * scale));
    pixels[offset] = Math.round(23 + mix * 184);
    pixels[offset + 1] = Math.round(28 + mix * 212);
    pixels[offset + 2] = Math.round(24 + mix * 115);
    pixels[offset + 3] = alpha;
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}
const png = renderPng(256);
const directory = path.resolve(__dirname, '../assets');
fs.mkdirSync(directory, { recursive: true });
// macOS requires at least 512 pixels; keep the Windows ICO at its native 256.
fs.writeFileSync(path.join(directory, 'icon.png'), renderPng(1024));
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(directory, 'icon.ico'), Buffer.concat([ico, png]));
