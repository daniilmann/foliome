const { crc32, deflateSync, inflateSync } = require("node:zlib") as typeof import("node:zlib");

const signature = Buffer.from("89504e470d0a1a0a", "hex");
const maxWidth = 1_600;
const maxHeight = 1_200;
const maxOutputBytes = 2_000_000;

type Rectangle = Readonly<{ x: number; y: number; width: number; height: number }>;
type Label = Readonly<{ x: number; y: number; number: number }>;
export type PngPlan = Readonly<{ masks: readonly Rectangle[]; labels: readonly Label[] }>;
type Failure = { ok: false; code: "error" | "limit" };
export type ProtectedPng = { ok: true; bytes: Buffer } | Failure;

type Chunk = { type: string; data: Buffer; end: number };
type Image = { width: number; height: number; channels: 3 | 4; stride: number; rows: Buffer };
type DecodedPng = { ok: true; image: Image } | Failure;

const beforePalette = new Set(["cHRM", "gAMA", "iCCP", "sBIT", "sRGB", "cICP", "mDCv", "cLLi"]);
const beforeData = new Set(["bKGD", "hIST", "pHYs", "sPLT", "eXIf"]);
const unsupported = new Set(["tRNS", "acTL", "fcTL", "fdAT"]);

const glyphs = [
  [7, 5, 5, 5, 7],
  [2, 6, 2, 2, 7],
  [7, 1, 7, 4, 7],
  [7, 1, 7, 1, 7],
  [5, 5, 7, 1, 1],
  [7, 4, 7, 1, 7],
  [7, 4, 7, 5, 7],
  [7, 1, 1, 1, 1],
  [7, 5, 7, 5, 7],
  [7, 5, 7, 1, 7],
];
const opaqueBlack = Buffer.from([0, 0, 0, 255]);

export declare const protectPng: typeof protect;
declare const exports: { protectPng: typeof protect };

function readChunk(bytes: Buffer, start: number): Chunk | undefined {
  if (bytes.length - start < 12) return;
  const length = bytes.readUInt32BE(start);
  if (length > 0x7fffffff || length > bytes.length - start - 12) return;
  const dataStart = start + 8;
  const dataEnd = dataStart + length;
  // latin1 preserves the high bit so it cannot turn malformed bytes into ASCII letters.
  const type = bytes.toString("latin1", start + 4, dataStart);
  if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) return;
  if (crc32(bytes.subarray(start + 4, dataEnd)) !== bytes.readUInt32BE(dataEnd)) return;
  return { type, data: bytes.subarray(dataStart, dataEnd), end: dataEnd + 4 };
}

function readImageData(bytes: Buffer, start: number): Buffer | undefined {
  const parts: Buffer[] = [];
  const seen = new Set<string>();
  let idatEnded = false;

  for (let offset = start; offset < bytes.length; ) {
    const chunk = readChunk(bytes, offset);
    if (!chunk) return;
    const { type, data, end } = chunk;
    offset = end;

    if (type === "IDAT") {
      if (idatEnded) return;
      parts.push(data);
      continue;
    }
    const hasData = parts.length > 0;
    if (type === "IEND") {
      if (hasData && data.length === 0 && end === bytes.length) return Buffer.concat(parts);
      return;
    }
    if (hasData) idatEnded = true;

    const hasPalette = seen.has("PLTE");
    if (type === "PLTE") {
      if (hasData || hasPalette || seen.has("bKGD")) return;
      if (data.length === 0 || data.length > 768 || data.length % 3 !== 0) return;
    } else {
      // Extra critical chunks, transparency keys and animated frames are unsupported.
      if (type[0] < "a" || unsupported.has(type)) return;
      if (beforePalette.has(type) && (hasPalette || hasData || seen.has(type))) return;
      if (beforeData.has(type) && (hasData || (type !== "sPLT" && seen.has(type)))) return;
      if (type === "hIST" && !hasPalette) return;
      if (type === "tIME" && seen.has(type)) return;
    }
    // Ancillary payloads are never decoded or copied into the output.
    seen.add(type);
  }
}

function paeth(left: number, up: number, diagonal: number): number {
  const estimate = left + up - diagonal;
  const fromLeft = Math.abs(estimate - left);
  const fromUp = Math.abs(estimate - up);
  const fromDiagonal = Math.abs(estimate - diagonal);
  if (fromLeft <= fromUp && fromLeft <= fromDiagonal) return left;
  return fromUp <= fromDiagonal ? up : diagonal;
}

function predictor(image: Image, row: number, column: number, filter: number): number {
  const { rows, channels, stride } = image;
  const index = row * stride + 1 + column;
  const hasLeft = column >= channels;
  const left = hasLeft ? rows[index - channels] : 0;
  const up = row > 0 ? rows[index - stride] : 0;
  switch (filter) {
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return (left + up) >>> 1;
    case 4:
      return paeth(left, up, row > 0 && hasLeft ? rows[index - stride - channels] : 0);
    default:
      return 0;
  }
}

function decode(bytes: Buffer, expected?: Readonly<{ width: number; height: number }>): DecodedPng {
  if (!bytes.subarray(0, signature.length).equals(signature)) return { ok: false, code: "error" };
  const header = readChunk(bytes, signature.length);
  if (!header || header.type !== "IHDR" || header.data.length !== 13) {
    return { ok: false, code: "error" };
  }
  const { data } = header;
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  const color = data[9];
  if (
    width === 0 ||
    height === 0 ||
    width > 0x7fffffff ||
    height > 0x7fffffff ||
    data[8] !== 8 ||
    (color !== 2 && color !== 6) ||
    data[10] !== 0 ||
    data[11] !== 0 ||
    data[12] !== 0
  ) {
    return { ok: false, code: "error" };
  }
  if (expected && (width !== expected.width || height !== expected.height)) return { ok: false, code: "error" };
  if (width > maxWidth || height > maxHeight) return { ok: false, code: "limit" };

  const compressed = readImageData(bytes, header.end);
  if (!compressed) return { ok: false, code: "error" };
  const channels = color === 2 ? 3 : 4;
  const stride = width * channels + 1;
  const expectedLength = height * stride;
  // Node's types declare the default return value even when info is true.
  const { buffer: rows, engine } = inflateSync(compressed, {
    info: true,
    maxOutputLength: expectedLength,
  }) as unknown as { buffer: Buffer; engine: Pick<import("node:zlib").Inflate, "bytesWritten"> };
  if (rows.length !== expectedLength || engine.bytesWritten !== compressed.length) {
    return { ok: false, code: "error" };
  }

  const image: Image = { width, height, channels, stride, rows };
  for (let row = 0; row < height; row++) {
    const start = row * stride;
    const filter = rows[start];
    if (filter > 4) return { ok: false, code: "error" };
    if (filter === 0) continue;
    for (let column = 0; column < stride - 1; column++) {
      const index = start + 1 + column;
      rows[index] = (rows[index] + predictor(image, row, column, filter)) & 255;
    }
  }
  return { ok: true, image };
}

function ownField(value: unknown, key: string | number): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field && Object.hasOwn(field, "value") ? field.value : undefined;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function rectangle(
  image: Image,
  item: unknown,
  width = ownField(item, "width"),
  height = ownField(item, "height"),
): Rectangle | undefined {
  const x = ownField(item, "x");
  const y = ownField(item, "y");
  if (
    !isInteger(x) ||
    !isInteger(y) ||
    !isInteger(width) ||
    !isInteger(height) ||
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    x + width > image.width ||
    y + height > image.height
  ) {
    return;
  }
  return { x, y, width, height };
}

function fill(image: Image, area: Rectangle): void {
  const { rows, stride, channels } = image;
  const color = opaqueBlack.subarray(0, channels);
  for (let y = area.y; y < area.y + area.height; y++) {
    const start = y * stride + 1 + area.x * channels;
    rows.fill(color, start, start + area.width * channels);
  }
}

function drawLabel(image: Image, item: unknown): boolean {
  const number = ownField(item, "number");
  if (!isInteger(number) || number < 1) return false;
  const digits = String(number);
  const area = rectangle(image, item, 4 * digits.length + 1, 7);
  if (!area) return false;
  fill(image, area);

  const { rows, stride, channels } = image;
  for (let digit = 0; digit < digits.length; digit++) {
    const glyph = glyphs[digits.charCodeAt(digit) - 48];
    const x = area.x + 1 + 4 * digit;
    for (let y = 0; y < glyph.length; y++) {
      const start = (area.y + y + 1) * stride + 1 + x * channels;
      for (let column = 0; column < 3; column++) {
        if ((glyph[y] & (4 >> column)) === 0) continue;
        const index = start + column * channels;
        rows.fill(255, index, index + channels);
      }
    }
  }
  return true;
}

function applyPlan(image: Image, plan: PngPlan): boolean {
  const masks = ownField(plan, "masks");
  const labels = ownField(plan, "labels");
  if (!Array.isArray(masks) || !Array.isArray(labels)) return false;
  const maskCount = ownField(masks, "length");
  const labelCount = ownField(labels, "length");
  if (!isInteger(maskCount) || !isInteger(labelCount) || maskCount < 0 || labelCount < 0) {
    return false;
  }
  for (let index = 0; index < maskCount; index++) {
    const area = rectangle(image, ownField(masks, index));
    if (!area) return false;
    fill(image, area);
  }
  for (let index = 0; index < labelCount; index++) {
    if (!drawLabel(image, ownField(labels, index))) return false;
  }
  return true;
}

function writeChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

function encode(image: Image): ProtectedPng {
  const { rows, width, height, channels, stride } = image;
  // Restore the PNG filters in reverse so their predictor still sees decoded samples.
  for (let row = height - 1; row >= 0; row--) {
    const start = row * stride;
    const filter = rows[start];
    if (filter === 0) continue;
    for (let column = stride - 2; column >= 0; column--) {
      const index = start + 1 + column;
      rows[index] = (rows[index] - predictor(image, row, column, filter)) & 255;
    }
  }

  const compressed = deflateSync(rows);
  const header = Buffer.alloc(13);
  if (signature.length + 3 * 12 + header.length + compressed.length > maxOutputBytes) {
    return { ok: false, code: "limit" };
  }
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 3 ? 2 : 6;
  const bytes = Buffer.concat([
    signature,
    writeChunk("IHDR", header),
    writeChunk("IDAT", compressed),
    writeChunk("IEND", Buffer.alloc(0)),
  ]);
  return { ok: true, bytes };
}

function protect(input: Buffer, plan: PngPlan, expected?: Readonly<{ width: number; height: number }>): ProtectedPng {
  try {
    if (!Buffer.isBuffer(input)) return { ok: false, code: "error" };
    const decoded = decode(input, expected);
    if (!decoded.ok) return decoded;
    if (!applyPlan(decoded.image, plan)) return { ok: false, code: "error" };
    return encode(decoded.image);
  } catch {
    return { ok: false, code: "error" };
  }
}

exports.protectPng = protect;
