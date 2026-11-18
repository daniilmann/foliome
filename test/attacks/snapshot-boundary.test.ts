const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { randomBytes } = require('node:crypto');
const zlib = require('node:zlib');

const secret = 'synthetic-secret-marker';
const thrown = 'synthetic-exception-marker';
const scope = { sessionId: 'synthetic-session', sourceId: 'synthetic-source', accessId: 'synthetic-access' };
const session = { sessionId: scope.sessionId, sessionActive: true, loginStep: false, manualInputSeen: true,
  hasKnownSecret: true, hasNonEmptyFields: false,
  completion: { sessionId: scope.sessionId, source: 'trusted-adapter', confirmed: true } };
const facts = () => ({ snapshot: 1, page: { url: 'https://cabinet.invalid/overview', title: 'Overview' },
  frames: [{ index: 0, host: 'cabinet.invalid', foreign: false, unavailable: false }],
  nodes: [{ n: 1, frame: 0, visible: true, role: 'text', text: `Ordinary ${secret}` }],
  secrets: [{ value: secret, kind: 'password' }] });
const frame = () => ({ facts: facts(), plan: { masks: [{ x: 0, y: 0, width: 1, height: 1 }], labels: [] },
  revision: 1, animationIds: [], maskAnimationActive: false, viewportStable: true });

function png(width: number, height: number, noisy = false) {
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name), length = Buffer.alloc(4), sum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); sum.writeUInt32BE(zlib.crc32(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, sum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const stride = width * 4 + 1, rows = noisy ? randomBytes(stride * height) : Buffer.alloc(stride * height, 190);
  for (let y = 0; y < height; y++) rows[y * stride] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

test('отказывает при ошибочном сигнале непрошедшей маске превышении предела или сбое фильтра без исходных меток', { timeout: 30000 }, async (t: any) => {
  // Load the real PNG processor with a switchable encoder; all other processing remains real.
  const originalDeflate = zlib.deflateSync;
  let failEncode = false;
  zlib.deflateSync = (...args: any[]) => { if (failEncode) throw new Error(thrown); return originalDeflate(...args); };
  let capture: any;
  try { capture = require('../../core/adapters/browser/capture-snapshot.ts').captureCabinetSnapshot; }
  finally { zlib.deflateSync = originalDeflate; }
  const { createPreparationMcp } = require('../../core/adapters/channel/preparation-mcp.ts');
  const { createTextSnapshotStore } = require('../../core/adapters/store/text-snapshot-store.ts');
  const { createActionProtocol } = require('../../core/adapters/store/action-protocol.ts');
  const input = png(1, 1);
  const hugeEncoded = png(1600, 400, true);
  assert.ok(hugeEncoded.length > 2_000_000);

  async function exercise(options: any) {
    const db = new DatabaseSync(':memory:');
    try {
      const store = createTextSnapshotStore(db, () => 1), protocol = createActionProtocol(db, () => 1);
      let collects = 0, captures = 0;
      const ports = {
        collect: async () => { collects++; return options.collect ? options.collect(collects) : frame(); },
        capturePng: async () => { captures++; return options.image ?? input; },
        now: () => 0, sleep: async () => {},
        recordDeviation: async (entry: any) => protocol.appendSnapshotDeviation({ ...scope, ...entry }),
      };
      failEncode = !!options.encodeError;
      let result: any;
      try { result = await capture(ports, () => options.session ?? session, 5000); }
      finally { failEncode = false; }
      if (result.ok) store.append({ ...scope, result: { ok: true, snapshot: result.snapshot } });
      const handler = createPreparationMcp({ getTask: async () => ({ ok: false, code: 'internal' }),
        getSnapshot: async () => result, readText: async () => ({ ok: false, code: 'internal' }) });
      await handler({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } } });
      await handler({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const reply = await handler({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'snapshot', arguments: {} } });
      const rows = db.prepare('SELECT * FROM text_snapshots').all();
      const deviations = db.prepare('SELECT * FROM action_snapshot_deviations').all();
      const surface = JSON.stringify({ result, reply, rows, deviations });
      for (const value of [secret, thrown, input.toString('base64'), (options.image ?? input).toString('base64')]) assert.equal(surface.includes(value), false);
      if (options.closed) {
        assert.deepEqual(result, { ok: false, code: 'internal' });
        assert.equal(rows.length, 0);
        assert.deepEqual(reply.result, { content: [{ type: 'text', text: 'internal' }], isError: true });
      } else {
        assert.equal(result.ok, true);
        assert.deepEqual(result.image, { code: options.code });
        assert.equal(result.snapshot.elements[0].text, 'Ordinary [секрет]');
        assert.equal(rows.length, 1);
        assert.equal(deviations.length, options.code === 'login-step' ? 0 : 1);
        if (deviations.length) assert.equal(deviations[0].code, options.code);
        assert.ok(reply.result.content.every((item: any) => item.type !== 'image'));
      }
      if (options.noCapture) assert.equal(captures, 0);
    } finally { db.close(); }
  }

  await t.test('чужое подтверждение входа', () => exercise({ code: 'login-step', noCapture: true,
    session: { ...session, completion: { ...session.completion, sessionId: 'other-session' } } }));
  await t.test('неподтверждённая маска', () => exercise({ code: 'error', noCapture: true,
    collect: () => ({ ...frame(), plan: null }) }));
  await t.test('некорректный PNG', () => exercise({ code: 'error', image: Buffer.from('synthetic-invalid-image') }));
  await t.test('ошибка кодирования PNG', () => exercise({ code: 'error', encodeError: true }));
  await t.test('превышен предел закодированного PNG', () => exercise({ code: 'limit', image: hugeEncoded }));
  await t.test('ошибка фильтра', () => exercise({ closed: true, collect: () => ({ ...frame(), facts: { ...facts(), nodes: null } }) }));
  await t.test('ошибка первого сбора', () => exercise({ closed: true, collect: () => { throw new Error(thrown); } }));
  await t.test('ошибка повторного сбора', () => exercise({ closed: true, collect: (n: number) => { if (n === 2) throw new Error(thrown); return frame(); } }));
});
