const assert = require('node:assert/strict');
const test = require('node:test');
const net = require('node:net');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { once } = require('node:events');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('проверяет UID до чтения и останавливает сообщения с неверным форматом до браузера', { timeout: 15_000 }, async () => {
  const { createAdmittedChannel } = await import('../../core/adapters/channel/admission.ts');
  const actualUid = process.getuid!();
  const otherUid = actualUid + 1;
  const message = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'synthetic' } };
  const validLine = Buffer.from(`${JSON.stringify(message)}\n`);
  const cap = 128;
  const directory = await mkdtemp(join(tmpdir(), 'channel-test-'));
  const path = join(directory, 'socket');
  const deniedCodes = new Map<string, string>();

  async function exercise(label: string, payload: Buffer, uid: 'allowed' | 'other' | 'error', accepted?: object) {
    const uidResult = deferred<number>();
    const peerReady = deferred<any>();
    const requestReceived = deferred<void>();
    const denied = deferred<void>();
    const requests: unknown[] = [];
    const denials: unknown[][] = [];
    const server = createAdmittedChannel({
      expectedUid: actualUid,
      maxLineBytes: cap,
      peerUid: (socket: any) => { peerReady.resolve(socket); return uidResult.promise; },
      onRequest: (request: unknown) => { requests.push(request); requestReceived.resolve(); },
      onDenied: (...args: unknown[]) => { denials.push(args); denied.resolve(); },
    });
    let client: any;
    let peer: any;
    try {
      server.listen(path);
      await once(server, 'listening');
      client = net.createConnection(path);
      client.on('error', () => {});
      const clientClosed = new Promise<void>((resolve) => client.once('close', resolve));
      await once(client, 'connect');
      peer = await peerReady.promise;
      assert.equal(peer.isPaused(), true, `${label}: соединение на паузе`);
      await new Promise<void>((resolve, reject) => client.write(payload, (error: Error | null | undefined) => error ? reject(error) : resolve()));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(peer.bytesRead, 0, `${label}: байты до проверки UID`);
      assert.deepEqual(requests, [], `${label}: запрос до проверки UID`);
      assert.deepEqual(denials, [], `${label}: отказ до проверки UID`);

      if (uid === 'error') uidResult.reject(new Error('synthetic peer credential error'));
      else uidResult.resolve(uid === 'allowed' ? actualUid : otherUid);

      if (accepted !== undefined) {
        await requestReceived.promise;
        assert.deepEqual(requests, [accepted], label);
        assert.deepEqual(denials, [], label);
      } else {
        await denied.promise;
        await clientClosed;
        assert.deepEqual(requests, [], label);
        assert.equal(denials.length, 1, label);
        assert.equal(denials[0].length, 1, `${label}: только код отказа`);
        const code = denials[0][0];
        assert.equal(typeof code, 'string', label);
        assert.match(code as string, /^[A-Za-z][A-Za-z0-9_-]*$/, `${label}: фиксированный код без содержимого`);
        const group = uid === 'allowed' ? 'format' : 'uid';
        if (deniedCodes.has(group)) assert.equal(code, deniedCodes.get(group), label);
        else deniedCodes.set(group, code as string);
        if (uid !== 'allowed') assert.equal(peer.bytesRead, 0, `${label}: байты после отказа UID`);
      }
    } finally {
      client?.destroy();
      peer?.destroy();
      await new Promise<void>((resolve, reject) => server.close((error: Error | undefined) => error ? reject(error) : resolve()));
    }
  }

  try {
    await exercise('допущенный UID', validLine, 'allowed', message);
    await exercise('чужой UID', validLine, 'other');
    await exercise('ошибка UID', validLine, 'error');
    const invalid = [
      ['тип id', Buffer.from('{"jsonrpc":"2.0","id":false,"method":"initialize"}\n')],
      ['отрицательный id', Buffer.from('{"jsonrpc":"2.0","id":-1,"method":"initialize"}\n')],
      ['дробный id', Buffer.from('{"jsonrpc":"2.0","id":1.5,"method":"initialize"}\n')],
      ['тип jsonrpc', Buffer.from('{"jsonrpc":2,"method":"initialize"}\n')],
      ['версия jsonrpc', Buffer.from('{"jsonrpc":"1.0","method":"initialize"}\n')],
      ['неизвестное поле', Buffer.from('{"jsonrpc":"2.0","method":"initialize","extra":"synthetic"}\n')],
      ['неизвестный метод', Buffer.from('{"jsonrpc":"2.0","method":"synthetic"}\n')],
      ['тип params', Buffer.from('{"jsonrpc":"2.0","method":"initialize","params":[]}\n')],
      ['слишком длинная строка', Buffer.from(`${'x'.repeat(cap + 1)}\n`)],
      ['неверный UTF-8', Buffer.concat([Buffer.from('{"jsonrpc":"2.0","method":"initialize","params":{"x":"'), Buffer.from([0xff]), Buffer.from('"}}\n')])],
      ['невалидный JSON', Buffer.from('{"jsonrpc":"2.0",}\n')],
    ] as const;
    for (const [label, payload] of invalid) await exercise(label, payload, 'allowed');
    for (const method of ['initialize', 'notifications/initialized', 'tools/list']) {
      const request = { jsonrpc: '2.0', id: 'synthetic', method, params: {} };
      await exercise(method, Buffer.from(`${JSON.stringify(request)}\n`), 'allowed', request);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('принимает только абсолютный путь Unix-сокета и синхронно отклоняет TCP и невалидные пути', async () => {
  const { createAdmittedChannel } = await import('../../core/adapters/channel/admission.ts');
  const server = createAdmittedChannel({
    expectedUid: process.getuid!(), maxLineBytes: 128,
    peerUid: async () => process.getuid!(), onRequest: () => undefined, onDenied: () => {},
  });
  for (const args of [[0], [{ port: 0, host: '127.0.0.1' }], ['']]) {
    assert.throws(() => (server.listen as (...values: unknown[]) => unknown)(...args), TypeError);
  }
});

test('относительный путь синхронно отклоняется до передачи в net.Server.listen', async () => {
  const { createAdmittedChannel } = await import('../../core/adapters/channel/admission.ts');
  const originalListen = net.Server.prototype.listen;
  let delegated = false;
  net.Server.prototype.listen = function () { delegated = true; return this; };
  try {
    const server = createAdmittedChannel({
      expectedUid: process.getuid!(), maxLineBytes: 128,
      peerUid: async () => process.getuid!(), onRequest: () => undefined, onDenied: () => {},
    });
    const rejected: string[] = [];
    for (const path of ['relative-socket', '\0synthetic', '/synthetic\0socket']) {
      try { server.listen(path); } catch (error) {
        assert.ok(error instanceof TypeError);
        rejected.push(path);
      }
    }
    assert.deepEqual(rejected, ['relative-socket', '\0synthetic', '/synthetic\0socket']);
    assert.equal(delegated, false);
  } finally {
    net.Server.prototype.listen = originalListen;
  }
});

async function exchangeResponse(response: unknown, method = 'tools/call') {
  const { createAdmittedChannel } = await import('../../core/adapters/channel/admission.ts');
  const directory = await mkdtemp(join(tmpdir(), 'channel-output-'));
  const path = join(directory, 'socket');
  const denied = deferred<string>();
  const denials: string[] = [];
  const request = { jsonrpc: '2.0', id: 7, method, params: {} };
  const server = createAdmittedChannel({
    expectedUid: process.getuid!(), maxLineBytes: 128,
    peerUid: async () => process.getuid!(),
    onRequest: (received: unknown) => { assert.deepEqual(received, request); return response; },
    onDenied: (code: string) => { denials.push(code); denied.resolve(code); },
  });
  let client: any;
  const chunks: Buffer[] = [];
  try {
    server.listen(path);
    await once(server, 'listening');
    client = net.createConnection(path);
    client.on('data', (chunk: Buffer) => chunks.push(chunk));
    client.on('error', () => {});
    const closed = new Promise<void>((resolve) => client.once('close', resolve));
    await once(client, 'connect');
    client.write(`${JSON.stringify(request)}\n`);
    return await Promise.race([
      new Promise<{ output: string; denials: string[] }>((resolve) => {
        client.on('data', () => {
          const output = Buffer.concat(chunks).toString('utf8');
          if (output.includes('\n')) resolve({ output, denials });
        });
      }),
      denied.promise.then(async () => { await closed; return { output: Buffer.concat(chunks).toString('utf8'), denials }; }),
    ]);
  } finally {
    client?.destroy();
    await new Promise<void>((resolve, reject) => server.close((error: Error | undefined) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

test('допускает ping для транспорта', { timeout: 15_000 }, async () => {
  const response = { jsonrpc: '2.0', id: 7, result: {} };
  const actual = await exchangeResponse(response, 'ping');
  assert.deepEqual(actual.denials, []);
  assert.deepEqual(JSON.parse(actual.output), response);
});

test('пропускает ответ с изображением и метаданными при независимом малом лимите входа', { timeout: 15_000 }, async () => {
  const image = Buffer.alloc(Math.floor(1.3 * 1024 * 1024), 0x61).toString('base64');
  const response = { jsonrpc: '2.0', id: 7, result: { content: [
    { type: 'image', data: image, mimeType: 'image/png' },
    { type: 'text', text: JSON.stringify({ width: 1024, height: 768 }) },
  ] } };
  assert.ok(Buffer.byteLength(JSON.stringify(response)) < 4 * 1024 * 1024);
  const actual = await exchangeResponse(response);
  assert.deepEqual(actual.denials, []);
  assert.deepEqual(JSON.parse(actual.output), response);
});

test('ответ свыше 4 MiB отклоняется фиксированным кодом без частичного вывода', { timeout: 15_000 }, async () => {
  const response = { jsonrpc: '2.0', id: 7, result: { content: [
    { type: 'text', text: 'x'.repeat(4 * 1024 * 1024) },
  ] } };
  assert.ok(Buffer.byteLength(JSON.stringify(response)) > 4 * 1024 * 1024);
  const actual = await exchangeResponse(response);
  assert.equal(actual.output, '');
  assert.deepEqual(actual.denials, ['handler']);
});
