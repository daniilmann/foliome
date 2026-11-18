const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');

const exec = promisify(execFile);
const darwin = process.platform === 'darwin';
const handler = (socket: import('node:net').Socket) => socket.end('fixture-response');

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'socket-fixture-'));
  await fs.chmod(dir, 0o700);
  return { dir, socket: path.join(dir, 'channel.sock') };
}
async function configure(file: string) {
  await exec('/bin/chmod', ['600', file]);
  await exec('/bin/chmod', ['+a', `${os.userInfo().username} allow write`, file]);
}
async function inspect(file: string) {
  const stat = await fs.lstat(file);
  const { stdout } = await exec('/bin/ls', ['-lde', file]);
  return { stat, lines: stdout.trimEnd().split('\n') };
}
async function readReply(file: string) {
  const client = net.createConnection(file);
  let response = '';
  client.setEncoding('utf8');
  client.on('data', (chunk: string) => {
    response += chunk;
  });
  await once(client, 'end');
  return response;
}
async function listen(server: import('node:net').Server, file: string) {
  server.listen(file);
  await once(server, 'listening');
}
async function close(server: import('node:net').Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((error: Error | undefined) => (error ? reject(error) : resolve())),
  );
}

// Proposed OS boundary: openSystemSocket({ path, configure, handler }) returns
// { ok: true, close() } only after configure(stagedPath), or { ok: false, code: 'unavailable' }.
// It owns only the socket it created, fails closed on a stale path, and does not
// dispatch clients before configuration.
function openSystemSocket(options: object) {
  return (
    require('../../core/adapters/system/darwin.ts') as typeof import('../../core/adapters/system/darwin.ts')
  ).openSystemSocket(
    options as Parameters<
      typeof import('../../core/adapters/system/darwin.ts').openSystemSocket
    >[0],
  );
}

test(
  'фикстура создаёт Unix-сокет с режимом 0600 и единственным ACL записи',
  { skip: !darwin, timeout: 3000 },
  async () => {
    const f = await fixture();
    const server = net.createServer(handler);
    try {
      await listen(server, f.socket);
      await configure(f.socket);
      const { stat, lines } = await inspect(f.socket);
      assert.equal(stat.isSocket(), true);
      assert.equal(stat.uid, process.getuid!());
      assert.equal(stat.mode & 0o7777, 0o600);
      assert.deepEqual(
        lines.slice(1).map((line: string) => line.trim()),
        [`0: user:${os.userInfo().username} allow write`],
      );
      assert.equal(await readReply(f.socket), 'fixture-response');
    } finally {
      if (server.listening) await close(server);
      await fs.rm(f.dir, { recursive: true, force: true });
    }
  },
);

test(
  'сокет становится доступен только после настройки прав и ACL',
  { skip: !darwin, timeout: 3000 },
  async () => {
    const f = await fixture();
    let result: Awaited<ReturnType<typeof openSystemSocket>> | undefined;
    let calls = 0;
    let stagedStat: import('node:fs').Stats | undefined;
    let client: import('node:net').Socket | undefined;
    let handled = 0;
    try {
      result = await openSystemSocket({
        path: f.socket,
        handler: (socket: import('node:net').Socket) => {
          handled++;
          handler(socket);
        },
        configure: async (file: string) => {
          calls++;
          const privateDir = path.dirname(file);
          const relativeDir = path.relative(f.dir, privateDir);
          assert.ok(
            relativeDir &&
              relativeDir !== '..' &&
              !relativeDir.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(relativeDir),
          );
          const dirStat = await fs.lstat(privateDir);
          assert.equal(dirStat.isDirectory(), true);
          assert.equal(dirStat.uid, process.getuid!());
          assert.equal(dirStat.mode & 0o777, 0o700);
          await assert.rejects(fs.lstat(f.socket), { code: 'ENOENT' });
          stagedStat = await fs.lstat(file);
          assert.equal(stagedStat!.isSocket(), true);
          await configure(file);
          client = net.createConnection(file);
          await once(client, 'connect');
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.equal(handled, 0);
          client!.destroy();
          await assert.rejects(fs.lstat(f.socket), { code: 'ENOENT' });
        },
      });
      assert.equal(result.ok, true);
      assert.equal(calls, 1);
      const { stat, lines } = await inspect(f.socket);
      assert.equal(stat.ino, stagedStat?.ino);
      assert.equal(stat.dev, stagedStat?.dev);
      assert.equal(stat.nlink, 1);
      assert.equal(stat.uid, process.getuid!());
      assert.equal(stat.mode & 0o7777, 0o600);
      assert.deepEqual(
        lines.slice(1).map((line: string) => line.trim()),
        [`0: user:${os.userInfo().username} allow write`],
      );
      assert.equal(await readReply(f.socket), 'fixture-response');
    } finally {
      client?.destroy();
      if (result?.ok) await result.close();
      await fs.rm(f.dir, { recursive: true, force: true });
    }
  },
);

test(
  'закрытие опубликованного сокета сохраняет заменивший его обычный файл',
  { skip: !darwin, timeout: 3000 },
  async () => {
    const f = await fixture();
    let result: Awaited<ReturnType<typeof openSystemSocket>> | undefined;
    let closed = false;
    try {
      result = await openSystemSocket({ path: f.socket, handler, configure });
      assert.equal(result.ok, true);
      assert.equal(await readReply(f.socket), 'fixture-response');
      const retainedSocket = path.join(f.dir, 'retained.sock');
      await fs.link(f.socket, retainedSocket);
      await fs.unlink(f.socket);
      await fs.writeFile(f.socket, 'replacement-file');
      const replacement = await fs.lstat(f.socket);
      await result.close();
      closed = true;
      const after = await fs.lstat(f.socket);
      assert.equal(after.isFile(), true);
      assert.equal(after.dev, replacement.dev);
      assert.equal(after.ino, replacement.ino);
      assert.equal(await fs.readFile(f.socket, 'utf8'), 'replacement-file');
      await assert.rejects(readReply(retainedSocket), { code: 'ECONNREFUSED' });
    } finally {
      if (result?.ok && !closed) await result.close();
      await fs.rm(f.dir, { recursive: true, force: true });
    }
  },
);

test(
  'занятый путь не удаляет обычный файл или действующий сокет',
  { skip: !darwin, timeout: 3000 },
  async () => {
    const f = await fixture();
    const live = net.createServer(handler);
    let calls = 0;
    const options = {
      path: f.socket,
      handler,
      configure: async () => {
        calls++;
      },
    };
    try {
      await fs.writeFile(f.socket, 'fixture-file');
      assert.deepEqual(await openSystemSocket(options), { ok: false, code: 'unavailable' });
      assert.equal(await fs.readFile(f.socket, 'utf8'), 'fixture-file');
      await fs.unlink(f.socket);
      await listen(live, f.socket);
      assert.deepEqual(await openSystemSocket(options), { ok: false, code: 'unavailable' });
      assert.equal((await fs.lstat(f.socket)).isSocket(), true);
      assert.equal(await readReply(f.socket), 'fixture-response');
      assert.equal(calls, 0);
    } finally {
      if (live.listening) await close(live);
      await fs.rm(f.dir, { recursive: true, force: true });
    }
  },
);

test(
  'оставшийся после процесса сокет не удаляется без безопасного восстановления',
  { skip: !darwin, timeout: 3000 },
  async () => {
    const f = await fixture();
    const child = spawn(
      process.execPath,
      [
        '-e',
        `require('node:net').createServer().listen(process.argv[1], () => process.stdout.write('ready'))`,
        f.socket,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    try {
      await once(child.stdout, 'data');
      child.kill('SIGKILL');
      await once(child, 'exit');
      assert.equal((await fs.lstat(f.socket)).isSocket(), true);
      let calls = 0;
      assert.deepEqual(
        await openSystemSocket({
          path: f.socket,
          handler,
          configure: async () => {
            calls++;
          },
        }),
        { ok: false, code: 'unavailable' },
      );
      assert.equal(calls, 0);
      assert.equal((await fs.lstat(f.socket)).isSocket(), true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await fs.rm(f.dir, { recursive: true, force: true });
    }
  },
);

test(
  'ошибка настройки закрывает сокет и не отдаёт данные подключённому клиенту',
  { skip: !darwin, timeout: 3000 },
  async () => {
    const f = await fixture();
    let client: import('node:net').Socket | undefined;
    let handled = 0;
    let received = '';
    let connectedDuringConfigure = false;
    let clientClosed: Promise<unknown> | undefined;
    try {
      const result = await openSystemSocket({
        path: f.socket,
        handler: (socket: import('node:net').Socket) => {
          handled++;
          handler(socket);
        },
        configure: async (file: string) => {
          await assert.rejects(fs.lstat(f.socket), { code: 'ENOENT' });
          await fs.chmod(file, 0o600);
          client = net.createConnection(file);
          client!.setEncoding('utf8');
          client!.on('data', (chunk: string) => {
            received += chunk;
          });
          clientClosed = once(client, 'close');
          await once(client, 'connect');
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.equal(handled, 0);
          connectedDuringConfigure = true;
          throw new Error('synthetic configuration failure');
        },
      });
      assert.deepEqual(result, { ok: false, code: 'unavailable' });
      assert.equal(connectedDuringConfigure, true);
      await clientClosed;
      assert.equal(handled, 0);
      assert.equal(received, '');
      await assert.rejects(fs.lstat(f.socket), { code: 'ENOENT' });
      await assert.rejects(readReply(f.socket), { code: 'ENOENT' });
    } finally {
      client?.destroy();
      await fs.rm(f.dir, { recursive: true, force: true });
    }
  },
);
