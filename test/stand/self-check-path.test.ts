const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');
const { runProgram } = require('../../core/system-entrypoint.ts');

const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const env = { HOME: os.tmpdir(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: os.tmpdir() };

async function fixture() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'self-check-path-')));
  const home = path.join(dir, 'home');
  const root = path.join(home, 'Library/Application Support/Foliome');
  const app = path.join(root, 'app');
  const data = path.join(root, 'data');
  const channel = path.join(dir, 'channel');
  const database = path.join(data, 'core.db');
  const paths = {
    home,
    app,
    data,
    channel,
    database,
    socket: path.join(channel, 'core.sock'),
    sshConfig: path.join(data, 'ssh_config'),
    config: path.join(data, 'config.json'),
  };
  const copy = path.join(app, 'releases', `${sha}.check`, 'data', 'core.db');
  await fs.mkdir(data, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(copy), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(database);
  db.exec(
    "CREATE TABLE marker (value TEXT NOT NULL) STRICT; INSERT INTO marker VALUES ('synthetic-original')",
  );
  db.close();
  await fs.chmod(database, 0o600);
  const original = await fs.readFile(database);
  const source = new DatabaseSync(database, { readOnly: true });
  try {
    await backup(source, copy);
    await fs.chmod(copy, 0o600);
  } finally {
    source.close();
  }
  return { dir, paths, copy, original };
}

async function run(
  paths: object,
  file: string,
  selfCheckSha = sha,
  argv = ['--self-check', '--database', file],
) {
  return runProgram({ argv, env, paths, selfCheckSha });
}

test('самопроверка допускает только снимок выбранного выпуска и сохраняет исходную базу', async () => {
  const f = await fixture();
  try {
    const before = await fs.readFile(f.copy);
    assert.deepEqual(await run(f.paths, f.copy), { ok: true });
    assert.deepEqual(await fs.readFile(f.copy), before);
    assert.deepEqual(await fs.readFile(f.paths.database), f.original);
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('самопроверка отклоняет живую базу, посторонние пути и неверный SHA', async (t: import('node:test').TestContext) => {
  const f = await fixture();
  try {
    const outside = path.join(f.dir, 'other', 'core.db');
    await fs.mkdir(path.dirname(outside));
    await fs.copyFile(f.copy, outside);
    const wrong = path.join(f.paths.app, 'releases', `${otherSha}.check`, 'data', 'core.db');
    await fs.mkdir(path.dirname(wrong), { recursive: true });
    await fs.copyFile(f.copy, wrong);
    const alias = path.join(f.dir, 'alias');
    await fs.symlink(path.join(f.paths.app, 'releases'), alias);
    for (const [name, file, expectedSha] of [
      ['живая база', f.paths.database, sha],
      ['другой временный каталог', outside, sha],
      [
        'псевдоним родительского каталога',
        path.join(alias, `${sha}.check`, 'data', 'core.db'),
        sha,
      ],
      ['другой выпуск', wrong, sha],
      ['неверный SHA порта', f.copy, otherSha],
    ]) {
      await t.test(name, async () =>
        assert.equal((await run(f.paths, file, expectedSha)).ok, false),
      );
    }
    assert.deepEqual(await fs.readFile(f.paths.database), f.original);
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('самопроверка отклоняет ссылку в родительском каталоге ожидаемого пути', async () => {
  const f = await fixture();
  try {
    const releases = path.join(f.paths.app, 'releases');
    const moved = path.join(f.dir, 'moved-releases');
    await fs.rename(releases, moved);
    await fs.symlink(moved, releases);
    assert.equal((await run(f.paths, f.copy)).ok, false);
    assert.deepEqual(await fs.readFile(f.paths.database), f.original);
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('самопроверка отклоняет ссылки и повреждённую SQLite', async (t: import('node:test').TestContext) => {
  for (const kind of ['symlink', 'hardlink', 'corrupt']) {
    await t.test(kind, async () => {
      const f = await fixture();
      try {
        const target = path.join(f.dir, 'target.db');
        if (kind === 'symlink') {
          await fs.rename(f.copy, target);
          await fs.symlink(target, f.copy);
        } else if (kind === 'hardlink') {
          await fs.link(f.copy, target);
        } else {
          await fs.writeFile(f.copy, 'not a SQLite database');
        }
        assert.equal((await run(f.paths, f.copy)).ok, false);
        assert.deepEqual(await fs.readFile(f.paths.database), f.original);
      } finally {
        await fs.rm(f.dir, { recursive: true, force: true });
      }
    });
  }
});

test('самопроверка отклоняет неожиданные аргументы запуска', async (t: import('node:test').TestContext) => {
  const f = await fixture();
  try {
    for (const [name, argv] of [
      ['лишний аргумент', ['--self-check', '--database', f.copy, '--extra']],
      ['повторный путь', ['--self-check', '--database', f.copy, '--database', f.copy]],
      ['неверный порядок', ['--database', f.copy, '--self-check']],
      ['нет пути', ['--self-check', '--database']],
    ] as [string, string[]][]) {
      await t.test(name, async () =>
        assert.equal((await run(f.paths, f.copy, sha, argv)).ok, false),
      );
    }
    assert.deepEqual(await fs.readFile(f.paths.database), f.original);
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});
