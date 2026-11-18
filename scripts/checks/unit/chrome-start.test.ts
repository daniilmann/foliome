const assert = require('node:assert/strict');
const test = require('node:test');

const loadStart = async () =>
  (await import('../../../core/adapters/browser/chrome-start.ts')).startVerifiedChrome;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('после проверки подписи запускает Chrome по pipe и закрывает запуск при отказе или таймауте', async () => {
  const start = await loadStart();
  const verification = deferred<boolean>();
  const calls: string[] = [];
  const browser = { close: async () => {} };
  const timeout = 1000;
  const result = start({
    verify: async (path: string, argv: string[], signal: AbortSignal) => {
      calls.push('verify');
      assert.equal(path, '/usr/bin/codesign');
      assert.ok(argv.includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
      assert.ok(argv.includes('-R') || argv.includes('--test-requirement'));
      assert.ok(Array.isArray(argv));
      assert.ok(argv.includes('--verify'));
      assert.ok(!argv.includes('--strict') && !argv.includes('--deep'));
      assert.match(argv.join(' '), /certificate\s+leaf\[subject\.OU\]\s*=\s*["']?EQHXZ8M8AV["']?/);
      assert.ok(signal instanceof AbortSignal);
      assert.equal(signal.aborted, false);
      return verification.promise;
    },
    launch: async (options: object, signal: AbortSignal) => {
      calls.push('launch');
      assert.ok(signal instanceof AbortSignal);
      assert.equal(signal.aborted, false);
      assert.deepEqual(options, {
        channel: 'chrome',
        chromiumSandbox: true,
        args: ['--disable-sync'],
        ignoreDefaultArgs: [
          '--disable-background-networking',
          '--disable-component-update',
          '--enable-unsafe-swiftshader',
        ],
        timeout,
      });
      return browser;
    },
  }, timeout);
  assert.deepEqual(calls, ['verify']);
  verification.resolve(true);
  assert.deepEqual(await result, { ok: true, browser });
  assert.deepEqual(calls, ['verify', 'launch']);
});

test('отказ или ошибка проверки подписи не запускает браузер', async () => {
  const start = await loadStart();
  for (const verify of [async () => false, async () => { throw new Error('synthetic'); }]) {
    let launches = 0;
    const result = await start({ verify, launch: async () => { launches++; throw new Error('unexpected'); } }, 1000);
    assert.deepEqual(result, { ok: false, code: 'chrome-signature' });
    assert.equal(launches, 0);
  }
});

test('ошибка запуска возвращает закрытый отказ', async () => {
  const start = await loadStart();
  const result = await start({
    verify: async () => true,
    launch: async () => { throw new Error('synthetic'); },
  }, 1000);
  assert.deepEqual(result, { ok: false, code: 'chrome-launch' });
});

test('таймаут проверки отменяет её и не запускает браузер даже после позднего успеха', async () => {
  const start = await loadStart();
  const verification = deferred<boolean>();
  let signal: AbortSignal | undefined;
  let launches = 0;
  const result = await start({
    verify: async (_path: string, _argv: string[], received: AbortSignal) => {
      signal = received;
      return verification.promise;
    },
    launch: async () => { launches++; throw new Error('unexpected'); },
  }, 25);
  assert.deepEqual(result, { ok: false, code: 'chrome-timeout' });
  assert.equal(signal?.aborted, true);
  verification.resolve(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(launches, 0);
});

test('таймаут запуска отменяет его и закрывает поздно полученный браузер', async () => {
  const start = await loadStart();
  const launch = deferred<{ close(): Promise<void> }>();
  const closed = deferred<void>();
  let signal: AbortSignal | undefined;
  let closes = 0;
  const result = await start({
    verify: async () => true,
    launch: async (_options: object, received: AbortSignal) => {
      signal = received;
      return launch.promise;
    },
  }, 25);
  assert.deepEqual(result, { ok: false, code: 'chrome-timeout' });
  assert.equal(signal?.aborted, true);
  launch.resolve({ close: async () => { closes++; closed.resolve(); } });
  await Promise.race([
    closed.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('browser was not closed')), 1000)),
  ]);
  assert.equal(closes, 1);
});
