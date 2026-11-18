const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createTechnicalLog } = require('../../core/adapters/technical-log.ts');

// Proposed public contract: fixed records, one session at a time, and an awaitable drain.
// setLevel is called by the trusted owner adapter; the logger accepts only fixed levels.
async function withLog(run: (fixture: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'technical-log-stand-'));
  const directory = join(root, 'logs');
  await mkdir(directory, { mode: 0o700 });
  const unavailable: string[] = [];
  const log = createTechnicalLog({
    directory,
    now: () => new Date('2026-01-02T03:04:05.000Z'),
    onUnavailable: (code: string) => unavailable.push(code),
  });
  try {
    await run({ log, root, directory, unavailable });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function records(directory: string) {
  const names: string[] = await readdir(directory);
  assert.ok(names.every((name) => name.endsWith('.jsonl')));
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const name of names) assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);
  const bytes = (
    await Promise.all(names.map((name) => readFile(join(directory, name), 'utf8')))
  ).join('');
  assert.ok(bytes.length === 0 || bytes.endsWith('\n'));
  return {
    bytes,
    rows: bytes.trim()
      ? bytes
          .trim()
          .split('\n')
          .map((line: string) => JSON.parse(line))
      : [],
  };
}

test('technical log defaults to error and flushes the bounded session ring on error', async () => {
  await withLog(async ({ log, directory }: any) => {
    log.beginSession('synthetic-session');
    for (let index = 0; index < 2001; index++) {
      log.write({ level: 'debug', code: 'browser-event' });
    }
    log.write({ level: 'warn', code: 'channel-denied' });
    log.write({ level: 'info', code: 'started' });
    await log.drain();
    assert.deepEqual(await readdir(directory), []);

    log.write({ level: 'error', code: 'protocol-unavailable' });
    await log.drain();
    const { rows, bytes } = await records(directory);
    // The triggering error follows the 2,000 most recent buffered entries.
    assert.equal(rows.length, 2001);
    assert.deepEqual(
      rows.slice(-3).map((row: any) => row.code),
      ['channel-denied', 'started', 'protocol-unavailable'],
    );
    assert.ok(!bytes.includes('synthetic-private-marker'));
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ['at', 'code', 'level', 'sessionId']);
      assert.equal(row.at, '2026-01-02T03:04:05.000Z');
      assert.equal(row.sessionId, 'synthetic-session');
      assert.ok(['info', 'debug', 'warn', 'error'].includes(row.level));
      assert.ok(
        ['started', 'browser-event', 'channel-denied', 'protocol-unavailable'].includes(row.code),
      );
    }
  });
});

test('trusted owner can enable the fixed warn, info and debug levels', async () => {
  await withLog(async ({ log, directory }: any) => {
    log.beginSession('synthetic-session');
    log.setLevel('warn');
    log.write({ level: 'warn', code: 'channel-denied' });
    log.setLevel('info');
    log.write({ level: 'info', code: 'started' });
    await log.drain();
    assert.deepEqual(
      (await records(directory)).rows.map((row: any) => row.code),
      ['channel-denied', 'started'],
    );
    log.setLevel('debug');
    log.write({ level: 'debug', code: 'browser-event' });
    await log.drain();
    assert.deepEqual(
      (await records(directory)).rows.map((row: any) => row.code),
      ['channel-denied', 'started', 'browser-event'],
    );
    for (const level of ['trace', '', 'INFO']) {
      assert.throws(() => log.setLevel(level));
    }
  });
});

test('technical log rejects open record shapes and never writes arbitrary data', async () => {
  await withLog(async ({ log, directory }: any) => {
    log.beginSession('synthetic-session');
    log.setLevel('debug');
    assert.throws(() =>
      log.write({ level: 'info', code: 'started', extra: 'synthetic-private-marker' }),
    );
    assert.throws(() => log.write({ level: 'trace', code: 'started' }));
    assert.throws(() => log.write({ level: 'info', code: 'synthetic-private-marker' }));
    log.write({ level: 'info', code: 'started' });
    await log.drain();
    const { rows, bytes } = await records(directory);
    assert.equal(rows.length, 1);
    assert.ok(!bytes.includes('synthetic-private-marker'));
  });
});

test('log failure reports one compact code per session without stopping later writes', async () => {
  await withLog(async ({ log, directory, unavailable }: any) => {
    log.beginSession('synthetic-session');
    log.setLevel('debug');
    await rm(directory, { recursive: true });
    await writeFile(directory, '');
    log.write({ level: 'debug', code: 'browser-event' });
    log.write({ level: 'debug', code: 'browser-event' });
    await log.drain();
    assert.deepEqual(unavailable, ['log-unavailable']);
    log.beginSession('synthetic-next-session');
    log.write({ level: 'debug', code: 'browser-event' });
    await log.drain();
    assert.deepEqual(unavailable, ['log-unavailable', 'log-unavailable']);
    await rm(directory);
    await mkdir(directory, { mode: 0o700 });
    log.write({ level: 'debug', code: 'browser-event' });
    await log.drain();
    assert.deepEqual(await readdir(directory), []);
    log.beginSession('synthetic-recovered-session');
    log.write({ level: 'debug', code: 'browser-event' });
    await log.drain();
    assert.ok((await records(directory)).rows.some((row: any) => row.code === 'browser-event'));
    assert.deepEqual(unavailable, ['log-unavailable', 'log-unavailable']);
  });
});
