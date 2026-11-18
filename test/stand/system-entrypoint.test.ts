const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

// Proposed public surface for B:
// core/system-entrypoint.ts exports runProgram({ argv, env, paths, ports }) and
// launchProgram({ node, entry, home, tmpdir, run }); direct Node execution accepts
// --self-check --database <isolated-copy>. runProgram returns {ok, code?}.
// core/adapters/system-observation.ts exports classifySystemObservation(input),
// returning { permissions, adminMembers, canary } for createInstalledKernel.
// All OS evidence and the kernel/browser/process ports below are synthetic.
const entry = path.resolve(__dirname, '../../core/system-entrypoint.ts');
const execFileAsync = promisify(execFile);
const cleanEnv = () => ({
  HOME: os.tmpdir(),
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  TMPDIR: os.tmpdir(),
});

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'system-entry-'));
  const home = path.join(dir, 'home');
  const homeRoot = path.join(home, 'Library/Application Support/Foliome');
  const app = path.join(homeRoot, 'app');
  const data = path.join(homeRoot, 'data');
  const channel = path.join(dir, 'channel');
  await fs.mkdir(data, { recursive: true, mode: 0o700 });
  await fs.mkdir(channel, { mode: 0o700 });
  const paths = {
    home,
    app,
    data,
    channel,
    socket: path.join(channel, 'core.sock'),
    database: path.join(data, 'core.db'),
    sshConfig: path.join(data, 'ssh_config'),
    config: path.join(data, 'config.json'),
  };
  const config = {
    source: {
      url: 'https://cabinet.invalid/overview',
      sessionId: 'synthetic-session',
      sourceId: 'synthetic-source',
      accessId: 'synthetic-access',
      instruction: 'Inspect synthetic overview',
    },
    executorUid: 778,
  };
  return { dir, paths, config };
}
function evidence() {
  const dir = (mode: number, acl: string[] = []) => ({
    type: 'directory',
    uid: 501,
    mode,
    links: 1,
    acl,
  });
  return {
    ownerUid: 501,
    ownerName: 'synthetic-owner',
    executorName: 'synthetic-executor',
    home: dir(0o700),
    app: dir(0o700),
    data: dir(0o700),
    channel: dir(0o700, ['0: user:synthetic-executor allow search']),
    socket: {
      type: 'socket',
      uid: 501,
      mode: 0o600,
      links: 1,
      acl: ['0: user:synthetic-executor allow write'],
    },
    adminMembers: ['root', 'synthetic-owner'],
    canary: 'refused',
  };
}
function observation(input: ReturnType<typeof evidence>) {
  return require('../../core/adapters/system-observation.ts').classifySystemObservation(input);
}

test('наблюдение ОС допускает только ожидаемые владельца, режимы и точные ACL', () => {
  const good = evidence();
  const result = observation(good);
  assert.deepEqual(result.permissions, {
    home: true,
    app: true,
    data: true,
    channel: true,
    socket: true,
  });
  assert.deepEqual(result.adminMembers, good.adminMembers);
  assert.equal(result.canary, 'refused');
  for (const [key, change] of [
    ['home', { uid: 502 }],
    ['app', { mode: 0o777 }],
    ['data', { type: 'symlink' }],
    ['channel', { uid: 0 }],
    ['channel', { acl: [] }],
    ['channel', { acl: [...good.channel.acl, '1: user:other allow search'] }],
    ['channel', { acl: ['0: user:synthetic-executor allow search,write'] }],
    ['socket', { type: 'file' }],
    ['socket', { mode: 0o666 }],
    ['socket', { acl: [...good.socket.acl, '1: user:other allow write'] }],
  ] as [keyof typeof good, object][]) {
    const changed = { ...good, [key]: { ...(good[key] as object), ...change } };
    assert.equal(observation(changed).permissions[key], false, `${key}: ${JSON.stringify(change)}`);
  }
});

test('обычный вход передаёт проверенные наблюдения ядру и отклоняет плохую конфигурацию', async () => {
  const { runProgram } = require('../../core/system-entrypoint.ts');
  const f = await fixture();
  try {
    let calls = 0;
    const ports = {
      observe: async () => observation(evidence()),
      createInstalledKernel: async (
        options: Parameters<typeof import('../../core/main.ts').createInstalledKernel>[0],
      ) => {
        calls++;
        assert.deepEqual(await options.observeMacOS(f.paths), observation(evidence()));
        assert.equal(options.executorUid, 778);
        assert.equal(options.source.url, f.config.source.url);
        return { close: async () => {} };
      },
      launchChrome: async () => {
        throw Error('unexpected browser');
      },
      runProcess: async () => {
        throw Error('unexpected process');
      },
    };
    const run = () => runProgram({ argv: [], env: cleanEnv(), paths: f.paths, ports });
    assert.deepEqual(await run(), { ok: false, code: 'boundary-config' });
    for (const invalid of [
      '{',
      JSON.stringify({ ...f.config, extra: true }),
      JSON.stringify({
        ...f.config,
        source: { ...f.config.source, url: 'http://cabinet.invalid' },
      }),
      JSON.stringify({
        ...f.config,
        source: { ...f.config.source, url: 'https://user:pass@cabinet.invalid/' },
      }),
      'x'.repeat(65537),
    ]) {
      await fs.writeFile(f.paths.config, invalid, { mode: 0o600 });
      assert.deepEqual(await run(), { ok: false, code: 'boundary-config' });
    }
    await fs.writeFile(f.paths.config, JSON.stringify(f.config), { mode: 0o600 });
    assert.deepEqual(await run(), { ok: true });
    assert.equal(calls, 1);
    for (const paths of [
      { ...f.paths, data: 'relative' },
      { ...f.paths, database: path.join(f.dir, 'outside.db') },
      { ...f.paths, sshConfig: path.join(f.dir, 'outside-ssh') },
    ]) {
      assert.deepEqual(await runProgram({ argv: [], env: cleanEnv(), paths, ports }), {
        ok: false,
        code: 'boundary-config',
      });
    }
    await fs.chmod(f.paths.config, 0o666);
    assert.deepEqual(await run(), { ok: false, code: 'boundary-config' });
    await fs.chmod(f.paths.config, 0o600);
    const linked = path.join(f.dir, 'linked-config');
    await fs.link(f.paths.config, linked);
    assert.deepEqual(await run(), { ok: false, code: 'boundary-config' });
    await fs.unlink(f.paths.config);
    await fs.symlink(linked, f.paths.config);
    assert.deepEqual(await run(), { ok: false, code: 'boundary-config' });
    assert.equal(calls, 1);
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('admin и canary определяют допуск без сетевых действий', async () => {
  const { startExecutor } = require('../../core/adapters/executor/start.ts');
  for (const [members, canary, expected] of [
    [['root', 'synthetic-owner'], 'refused', 'ok'],
    [['root', 'synthetic-owner', 'other'], 'refused', 'boundary-admin'],
    [['root'], 'refused', 'boundary-admin'],
    [['root', 'root'], 'refused', 'boundary-admin'],
    [['root', 'synthetic-owner'], 'timeout', 'boundary-pf'],
    [['root', 'synthetic-owner'], 'no-route', 'boundary-pf'],
  ] as [string[], string, string][]) {
    const observed = observation({ ...evidence(), adminMembers: members, canary });
    let calls = 0;
    const result = await startExecutor(
      {
        permissions: async () =>
          Object.values(observed.permissions).every((value) => value === true),
        adminGroup: async () =>
          observed.adminMembers.length === 2 &&
          new Set(observed.adminMembers).size === 2 &&
          observed.adminMembers.includes('root') &&
          observed.adminMembers.includes('synthetic-owner'),
        pfCanary: async () => observed.canary,
        run: async () => {
          calls++;
          return 0;
        },
      },
      { sshConfigPath: '/synthetic/data/ssh_config' },
    );
    assert.equal(result.ok ? 'ok' : result.code, expected);
    assert.equal(calls, expected === 'ok' ? 1 : 0);
  }
});

test('launcher передаёт точные исполняемый файл, аргументы и очищенное окружение', async () => {
  const { launchProgram } = require('../../core/system-entrypoint.ts');
  const calls: Parameters<
    Parameters<typeof import('../../core/system-entrypoint.ts').launchProgram>[0]['run']
  >[] = [];
  const run = async (
    ...args: Parameters<
      Parameters<typeof import('../../core/system-entrypoint.ts').launchProgram>[0]['run']
    >
  ) => {
    calls.push(args);
    return 0;
  };
  await launchProgram({
    node: '/synthetic/trusted/node',
    entry: '/synthetic/release/core/system-entrypoint.ts',
    home: '/synthetic/home',
    tmpdir: '/synthetic/private-tmp',
    run,
  });
  assert.deepEqual(calls, [
    [
      '/usr/bin/env',
      [
        '-i',
        'HOME=/synthetic/home',
        'PATH=/usr/bin:/bin:/usr/sbin:/sbin',
        'TMPDIR=/synthetic/private-tmp',
        '/synthetic/trusted/node',
        '--disable-sigusr1',
        '/synthetic/release/core/system-entrypoint.ts',
      ],
      { env: {}, stdio: 'ignore' },
    ],
  ]);
});

test('самопроверка реального Node работает только с копией базы и не запускает браузер', async () => {
  const f = await fixture();
  try {
    const db = new DatabaseSync(f.paths.database);
    db.exec(
      "CREATE TABLE marker (value TEXT NOT NULL) STRICT; INSERT INTO marker VALUES ('synthetic-original')",
    );
    db.close();
    const original = await fs.readFile(f.paths.database);
    const copy = path.join(f.dir, 'staging', 'isolated.db');
    await fs.mkdir(path.dirname(copy));
    await fs.copyFile(f.paths.database, copy);
    const hook = path.join(f.dir, 'observe-import.cjs');
    const marker = path.join(f.dir, 'browser-imported');
    await fs.writeFile(
      hook,
      `const Module = require('node:module'); const load = Module._load; Module._load = function(id, ...args) { if (id === 'playwright-core' || id.startsWith('playwright-core/')) require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'imported'); return load.call(this, id, ...args); };`,
    );
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--require', hook, entry, '--self-check', '--database', copy],
      { env: cleanEnv(), timeout: 10000 },
    );
    assert.equal(stdout.trim(), 'ok');
    assert.equal(stderr.trim(), '');
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(f.paths.database), original);
    const { runProgram } = require('../../core/system-entrypoint.ts');
    let browserCalls = 0,
      processCalls = 0,
      kernelCalls = 0;
    const result = await runProgram({
      argv: ['--self-check', '--database', copy],
      env: cleanEnv(),
      paths: f.paths,
      ports: {
        launchChrome: async () => {
          browserCalls++;
        },
        runProcess: async () => {
          processCalls++;
        },
        createInstalledKernel: async () => {
          kernelCalls++;
        },
      },
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(browserCalls + processCalls + kernelCalls, 0);
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('прямой вход отклоняет каждую запрещённую переменную до загрузки браузера', async () => {
  const f = await fixture();
  try {
    const db = new DatabaseSync(f.paths.database);
    db.close();
    const copy = path.join(f.dir, 'copy.db');
    await fs.copyFile(f.paths.database, copy);
    const hook = path.join(f.dir, 'observe-import.cjs');
    const marker = path.join(f.dir, 'browser-imported');
    const emptyCa = path.join(f.dir, 'empty-ca.pem');
    await fs.writeFile(emptyCa, '');
    await fs.writeFile(
      hook,
      `const Module = require('node:module'); const load = Module._load; Module._load = function(id, ...args) { if (id === 'playwright-core' || id.startsWith('playwright-core/')) require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'imported'); return load.call(this, id, ...args); };`,
    );
    for (const name of [
      'NODE_OPTIONS',
      'NODE_EXTRA_CA_CERTS',
      'DEBUG',
      'DEBUG_FILE',
      'PWDEBUG',
      'PW_SYNTHETIC',
      'PLAYWRIGHT_SYNTHETIC',
      'SELENIUM_REMOTE_URL',
    ]) {
      const value =
        name === 'NODE_OPTIONS'
          ? '--no-warnings'
          : name === 'NODE_EXTRA_CA_CERTS'
            ? emptyCa
            : 'synthetic-marker';
      await assert.rejects(
        execFileAsync(
          process.execPath,
          ['--require', hook, entry, '--self-check', '--database', copy],
          { env: { ...cleanEnv(), [name]: value }, timeout: 10000 },
        ),
        (error: { code: number; stderr: string }) => {
          assert.notEqual(error.code, 0, name);
          assert.match(error.stderr, /boundary-env/, name);
          assert.doesNotMatch(
            error.stderr,
            /synthetic-marker|playwright|Cannot find module/i,
            name,
          );
          return true;
        },
      );
      await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
    }
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});
