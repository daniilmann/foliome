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
