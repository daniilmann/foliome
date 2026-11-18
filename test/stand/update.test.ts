const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// Proposed root port: installRoot({releaseDir, rootDir, sha, tree, allowedPaths,
// checkBoundary}) -> Promise<void>; on failure it rejects only after restoring
// previous files and removing newly created files within this same invocation.
// checkBoundary({rootDir, stagingDir}) receives the actual installed/staged paths.
function hashes(text: string) {
  const bytes = Buffer.from(text);
  return {
    gitBlob: crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}
async function put(dir: string, name: string, text: string) {
  const target = path.join(dir, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text);
}

test('запрещает принятие в сессии сохраняет активный SHA при сбое проверки или миграции и проверяет восстановление прежних системных файлов при отказе root-проверки в том же вызове install-root', async () => {
  const { installRoot } = require('../../base/install-root.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'root-stand-'));
  try {
    const releaseDir = path.join(dir, 'release');
    const rootDir = path.join(dir, 'root');
    const activeFile = path.join(dir, 'active');
    const oldSha = '1111111111111111111111111111111111111111';
    const sha = '2222222222222222222222222222222222222222';
    const before = { 'system/policy.conf': 'old synthetic policy\n', 'base/launcher.js': 'old synthetic launcher\n' };
    const next = { 'system/policy.conf': 'new synthetic policy\n', 'base/launcher.js': 'new synthetic launcher\n', 'system/new.conf': 'new synthetic file\n' };
    for (const [name, text] of Object.entries(before)) await put(rootDir, name, text);
    for (const [name, text] of Object.entries(next)) await put(releaseDir, name, text);
    await fs.writeFile(activeFile, oldSha);
    const tree = Object.fromEntries(Object.entries(next).map(([name, text]) => [name, hashes(text)]));
    let checked = false;
    await assert.rejects(installRoot({ releaseDir, rootDir, sha, tree, allowedPaths: Object.keys(next), checkBoundary: async ({ rootDir: installed, stagingDir }: any) => {
      checked = true;
      assert.equal(await fs.readFile(path.join(installed, 'system/policy.conf'), 'utf8'), next['system/policy.conf']);
      assert.equal(await fs.readFile(path.join(installed, 'system/new.conf'), 'utf8'), next['system/new.conf']);
      assert.equal(await fs.readFile(path.join(stagingDir, 'system/policy.conf'), 'utf8'), next['system/policy.conf']);
      await fs.writeFile(path.join(releaseDir, 'system/policy.conf'), 'changed after staging\n');
      assert.equal(await fs.readFile(path.join(stagingDir, 'system/policy.conf'), 'utf8'), next['system/policy.conf']);
      throw new Error('synthetic boundary failure');
    } }), (error: Error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'boundary-failed');
      assert.doesNotMatch(error.message, /synthetic boundary failure/);
      return true;
    });
    assert.equal(checked, true);
    for (const [name, text] of Object.entries(before)) assert.equal(await fs.readFile(path.join(rootDir, name), 'utf8'), text);
    await assert.rejects(fs.lstat(path.join(rootDir, 'system/new.conf')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(activeFile, 'utf8'), oldSha);
    await failedUpdates();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// Proposed local port in core/adapters/update/install.ts:
// acceptUpdate({ dbPath, stateFile, rootDir, releasesDir, sha, allowed,
//   sessionActive, migrate, selfCheck, compatible }) and
// restorePrevious({ dbPath, stateFile, rootDir, releasesDir, selfCheck,
//   compatible }). Both reject on refusal. stateFile is an atomically replaced
// JSON object {current, previous}; releases/<sha> contains system/ and base/.
// migrate(db) is called within the adapter's transaction on each SQLite handle;
// selfCheck(db, sha) and compatible(db, sha) receive the disposable copy.
// Restore replaces system files from the previous release, never base or data.
const previousSha = '3a2d718f5e91b6c043827a9f0d4c6e831b542fa7';
const currentSha = 'b729af63e04d185c9a672fb340e51d8c26f193ab';
const nextSha = 'e04c9b7d612a38f059b4c2e713d8a6495f20bc81';

async function updateFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'update-stand-'));
  const dbPath = path.join(dir, 'data.sqlite');
  const stateFile = path.join(dir, 'activation.json');
  const rootDir = path.join(dir, 'root');
  const releasesDir = path.join(dir, 'releases');
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, label TEXT NOT NULL) STRICT; INSERT INTO entries VALUES (1, 'synthetic original'); PRAGMA user_version = 1;");
  db.close();
  await fs.writeFile(stateFile, JSON.stringify({ current: currentSha, previous: previousSha }));
  for (const [sha, label] of [[currentSha, 'current'], [nextSha, 'next']]) {
    await put(path.join(releasesDir, sha), 'system/policy.conf', `${label} synthetic policy\n`);
    await put(path.join(releasesDir, sha), 'base/launcher.js', `${label} synthetic launcher\n`);
  }
  await put(rootDir, 'system/policy.conf', 'next synthetic policy\n');
  await put(rootDir, 'base/launcher.js', 'next synthetic launcher\n');
  return { dir, dbPath, stateFile, rootDir, releasesDir };
}
async function state(file: string) { return JSON.parse(await fs.readFile(file, 'utf8')); }
function data(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      version: db.prepare('PRAGMA user_version').get().user_version,
      rows: db.prepare('SELECT id, label FROM entries ORDER BY id').all().map((row: any) => ({ ...row })),
      columns: db.prepare('PRAGMA table_info(entries)').all().map((row: any) => row.name),
    };
  } finally { db.close(); }
}
const original = { version: 1, rows: [{ id: 1, label: 'synthetic original' }], columns: ['id', 'label'] };
const migrated = { version: 2, rows: [{ id: 1, label: 'synthetic original' }, { id: 2, label: 'synthetic migrated' }], columns: ['id', 'label', 'note'] };
function migration(db: any) {
  db.exec("ALTER TABLE entries ADD COLUMN note TEXT; INSERT INTO entries (id, label) VALUES (2, 'synthetic migrated'); PRAGMA user_version = 2;");
}

test('активирует проверенный SHA после принятия и возвращает допустимый предыдущий SHA', async () => {
  const { acceptUpdate, restorePrevious } = require('../../core/adapters/update/install.ts');
  const f = await updateFixture();
  try {
    let checks = 0;
    let migrations = 0;
    const selfCheck = (db: any, sha: string) => {
      checks++;
      assert.equal(sha, nextSha);
      assert.deepEqual(data(f.dbPath), original);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
      db.exec("UPDATE entries SET label = 'copy only' WHERE id = 1");
      assert.deepEqual(data(f.dbPath), original);
    };
    await acceptUpdate({ ...f, sha: nextSha, allowed: true, sessionActive: false,
      migrate: (db: any) => { migrations++; migration(db); }, selfCheck,
      compatible: (_db: any, sha: string) => sha === nextSha });
    assert.equal(checks, 1);
    assert.equal(migrations, 2);
    assert.deepEqual(await state(f.stateFile), { current: nextSha, previous: currentSha });
    assert.deepEqual(data(f.dbPath), migrated);

    let restoreChecks = 0;
    let compatibilityChecks = 0;
    const restore = { ...f, selfCheck: (db: any, sha: string) => {
      restoreChecks++;
      assert.equal(sha, currentSha);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
      db.exec("UPDATE entries SET label = 'restore copy only' WHERE id = 1");
    }, compatible: (_db: any, sha: string) => { compatibilityChecks++; assert.equal(sha, currentSha); return false; } };
    await assert.rejects(restorePrevious(restore));
    assert.equal(compatibilityChecks, 1);
    assert.deepEqual(await state(f.stateFile), { current: nextSha, previous: currentSha });
    assert.deepEqual(data(f.dbPath), migrated);
    assert.equal(await fs.readFile(path.join(f.rootDir, 'system/policy.conf'), 'utf8'), 'next synthetic policy\n');
    let boundaryChecks = 0;
    const previousPolicy = 'current synthetic policy\n';
    const previousRoot = {
      tree: { 'system/policy.conf': hashes(previousPolicy) },
      allowedPaths: ['system/policy.conf'],
      checkBoundary: async ({ rootDir: installed }: any) => {
        boundaryChecks++;
        assert.equal(await fs.readFile(path.join(installed, 'system/policy.conf'), 'utf8'), previousPolicy);
        assert.equal(await fs.readFile(path.join(installed, 'base/launcher.js'), 'utf8'), 'next synthetic launcher\n');
      },
    };
    const verifiedRestore = { ...restore, previousRoot, compatible: (_db: any, sha: string) => { compatibilityChecks++; return sha === currentSha; } };
    const previousPolicyFile = path.join(f.releasesDir, currentSha, 'system/policy.conf');
    await fs.writeFile(previousPolicyFile, 'tampered synthetic policy\n');
    await assert.rejects(restorePrevious(verifiedRestore));
    assert.equal(boundaryChecks, 0);
    assert.deepEqual(await state(f.stateFile), { current: nextSha, previous: currentSha });
    assert.deepEqual(data(f.dbPath), migrated);
    assert.equal(await fs.readFile(path.join(f.rootDir, 'system/policy.conf'), 'utf8'), 'next synthetic policy\n');
    assert.equal(await fs.readFile(path.join(f.rootDir, 'base/launcher.js'), 'utf8'), 'next synthetic launcher\n');
    await fs.writeFile(previousPolicyFile, previousPolicy);
    await restorePrevious(verifiedRestore);
    assert.ok(restoreChecks >= 1);
    assert.equal(compatibilityChecks, 3);
    assert.equal(boundaryChecks, 1);
    assert.deepEqual(await state(f.stateFile), { current: currentSha, previous: null });
    assert.deepEqual(data(f.dbPath), migrated);
    assert.equal(await fs.readFile(path.join(f.rootDir, 'system/policy.conf'), 'utf8'), 'current synthetic policy\n');
    assert.equal(await fs.readFile(path.join(f.rootDir, 'base/launcher.js'), 'utf8'), 'next synthetic launcher\n');
  } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
});

async function failedUpdates() {
  const { acceptUpdate } = require('../../core/adapters/update/install.ts');
  for (const failure of ['not-allowed', 'session', 'check', 'migration']) {
    const f = await updateFixture();
    try {
      let checks = 0;
      let migrations = 0;
      await assert.rejects(acceptUpdate({ ...f, sha: nextSha,
        allowed: failure !== 'not-allowed', sessionActive: failure === 'session',
        migrate: (db: any) => {
          migrations++;
          migration(db);
          if (failure === 'migration' && migrations === 2) throw new Error('synthetic migration failure');
        },
        selfCheck: (db: any) => {
          checks++;
          assert.deepEqual(data(f.dbPath), original);
          assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
          if (failure === 'check') throw new Error('synthetic check failure');
        },
        compatible: () => true,
      }), failure);
      if (failure === 'not-allowed' || failure === 'session') {
        assert.equal(checks, 0, failure);
        assert.equal(migrations, 0, failure);
      } else if (failure === 'check') {
        assert.equal(checks, 1);
        assert.equal(migrations, 1);
      } else {
        assert.equal(checks, 1);
        assert.equal(migrations, 2);
      }
      assert.deepEqual(await state(f.stateFile), { current: currentSha, previous: previousSha }, failure);
      assert.deepEqual(data(f.dbPath), original, failure);
    } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
  }
}
