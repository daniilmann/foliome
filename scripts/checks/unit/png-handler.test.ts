const assert = require('node:assert/strict');
const test = require('node:test');
const { deflateSync, inflateSync } = require('node:zlib');

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name: string, data: Buffer): Buffer {
  const type = Buffer.from(name);
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([size, type, data, crc]);
}
function png(width: number, height: number, channels: number, pixels: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = channels === 3 ? 2 : 6;
  const rows = Buffer.alloc((width * channels + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(rows, y * (width * channels + 1) + 1, y * width * channels, (y + 1) * width * channels);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
function decode(bytes: Buffer) {
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'));
  let width = 0, height = 0, channels = 0, offset = 8;
  const data: Buffer[] = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    assert.equal(bytes.readUInt32BE(offset + 8 + length), crc32(Buffer.concat([type, body])));
    if (type.toString() === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      assert.equal(body[8], 8); assert.equal(body[12], 0);
      assert.ok(body[9] === 2 || body[9] === 6); channels = body[9] === 2 ? 3 : 4;
    }
    if (type.toString() === 'IDAT') data.push(body);
    offset += length + 12;
    if (type.toString() === 'IEND') break;
  }
  assert.equal(offset, bytes.length);
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels, pixels = Buffer.alloc(stride * height);
  assert.equal(raw.length, (stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]; assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y ? pixels[(y - 1) * stride + x] : 0;
      const upperLeft = y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      const p = left + up - upperLeft;
      const distances = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upperLeft)];
      const paeth = distances[0] <= distances[1] && distances[0] <= distances[2] ? left : distances[1] <= distances[2] ? up : upperLeft;
      const predictor = [0, left, up, Math.floor((left + up) / 2), paeth][filter];
      pixels[y * stride + x] = (raw[y * (stride + 1) + x + 1] + predictor) & 255;
    }
  }
  return { width, height, channels, pixels };
}

test('закрашивает синтетические области и не выдаёт PNG при ошибке маски', async () => {
  const { protectPng } = await import('../../../core/adapters/browser/png.ts');
  for (const channels of [3, 4]) {
    const width = 32, height = 32;
    const pixels = Buffer.alloc(width * height * channels, 180);
    const input = png(width, height, channels, pixels);
    const masks = [{ x: 4, y: 4, width: 4, height: 3 }];
    const result = await protectPng(input, { masks, labels: [] });
    assert.equal(result.ok, true);
    assert.ok(Buffer.isBuffer(result.bytes));
    assert.ok(result.bytes.length <= 2_000_000);
    const output = decode(result.bytes);
    assert.deepEqual([output.width, output.height, output.channels], [width, height, channels]);
    const pixel = (x: number, y: number) => output.pixels.subarray((y * width + x) * channels, (y * width + x + 1) * channels);
    const fill = pixel(4, 4);
    assert.notDeepEqual(fill.subarray(0, 3), pixels.subarray(0, 3));
    if (channels === 4) assert.equal(fill[3], 255);
    for (let y = 4; y < 7; y++) for (let x = 4; x < 8; x++) assert.deepEqual(pixel(x, y), fill);
    assert.deepEqual(pixel(31, 31), pixels.subarray(0, channels));
    const labelled = await protectPng(input, { masks, labels: [{ x: 12, y: 12, number: 1 }] });
    assert.equal(labelled.ok, true);
    assert.ok(decode(labelled.bytes).pixels.some((value: number, index: number) => value !== output.pixels[index]));
    for (const bad of [NaN, Infinity, -1]) {
      const failure = await protectPng(input, { masks: [{ x: bad, y: 0, width: 1, height: 1 }], labels: [] });
      assert.deepEqual(failure, { ok: false, code: 'error' });
    }
    assert.deepEqual(await protectPng(input, { masks: null, labels: [] }), { ok: false, code: 'error' });
    const corrupt = Buffer.from(input); corrupt[corrupt.length - 1] ^= 1;
    assert.deepEqual(await protectPng(corrupt, { masks, labels: [] }), { ok: false, code: 'error' });
  }
  const oversized = png(1601, 1, 3, Buffer.alloc(1601 * 3));
  assert.deepEqual(await protectPng(oversized, { masks: [], labels: [] }), { ok: false, code: 'limit' });
});
