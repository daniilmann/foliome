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
    const before = {
      'system/policy.conf': 'old synthetic policy\n',
      'base/launcher.js': 'old synthetic launcher\n',
    };
    const next = {
      'system/policy.conf': 'new synthetic policy\n',
      'base/launcher.js': 'new synthetic launcher\n',
      'system/new.conf': 'new synthetic file\n',
    };
    for (const [name, text] of Object.entries(before)) await put(rootDir, name, text);
    for (const [name, text] of Object.entries(next)) await put(releaseDir, name, text);
    await fs.writeFile(activeFile, oldSha);
    const tree = Object.fromEntries(
      Object.entries(next).map(([name, text]) => [name, hashes(text)]),
    );
    let checked = false;
    await assert.rejects(
      installRoot({
        releaseDir,
        rootDir,
        sha,
        tree,
        allowedPaths: Object.keys(next),
        checkBoundary: async ({
          rootDir: installed,
          stagingDir,
        }: {
          rootDir: string;
          stagingDir: string;
        }) => {
          checked = true;
          assert.equal(
            await fs.readFile(path.join(installed, 'system/policy.conf'), 'utf8'),
            next['system/policy.conf'],
          );
          assert.equal(
            await fs.readFile(path.join(installed, 'system/new.conf'), 'utf8'),
            next['system/new.conf'],
          );
          assert.equal(
            await fs.readFile(path.join(stagingDir, 'system/policy.conf'), 'utf8'),
            next['system/policy.conf'],
          );
          await fs.writeFile(
            path.join(releaseDir, 'system/policy.conf'),
            'changed after staging\n',
          );
          assert.equal(
            await fs.readFile(path.join(stagingDir, 'system/policy.conf'), 'utf8'),
            next['system/policy.conf'],
          );
          throw new Error('synthetic boundary failure');
        },
      }),
      (error: Error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'boundary-failed');
        assert.doesNotMatch(error.message, /synthetic boundary failure/);
        return true;
      },
    );
    assert.equal(checked, true);
    for (const [name, text] of Object.entries(before))
      assert.equal(await fs.readFile(path.join(rootDir, name), 'utf8'), text);
    await assert.rejects(fs.lstat(path.join(rootDir, 'system/new.conf')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(activeFile, 'utf8'), oldSha);
    await failedUpdates();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
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
  db.exec(
    "CREATE TABLE entries (id INTEGER PRIMARY KEY, label TEXT NOT NULL) STRICT; INSERT INTO entries VALUES (1, 'synthetic original'); PRAGMA user_version = 1;",
  );
  db.close();
  await fs.writeFile(stateFile, JSON.stringify({ current: currentSha, previous: previousSha }));
  for (const [sha, label] of [
    [currentSha, 'current'],
    [nextSha, 'next'],
  ]) {
    await put(path.join(releasesDir, sha), 'system/policy.conf', `${label} synthetic policy\n`);
    await put(path.join(releasesDir, sha), 'base/launcher.js', `${label} synthetic launcher\n`);
  }
  await put(rootDir, 'system/policy.conf', 'next synthetic policy\n');
  await put(rootDir, 'base/launcher.js', 'next synthetic launcher\n');
  return { dir, dbPath, stateFile, rootDir, releasesDir };
}
async function state(file: string) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
function data(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      version: db.prepare('PRAGMA user_version').get()!.user_version,
      rows: db
        .prepare('SELECT id, label FROM entries ORDER BY id')
        .all()
        .map((row: Record<string, import('node:sqlite').SQLOutputValue>) => ({ ...row })),
      columns: db
        .prepare('PRAGMA table_info(entries)')
        .all()
        .map((row: Record<string, import('node:sqlite').SQLOutputValue>) => row.name),
    };
  } finally {
    db.close();
  }
}
const original = {
  version: 1,
  rows: [{ id: 1, label: 'synthetic original' }],
  columns: ['id', 'label'],
};
const migrated = {
  version: 2,
  rows: [
    { id: 1, label: 'synthetic original' },
    { id: 2, label: 'synthetic migrated' },
  ],
  columns: ['id', 'label', 'note'],
};
function migration(db: import('node:sqlite').DatabaseSync) {
  db.exec(
    "ALTER TABLE entries ADD COLUMN note TEXT; INSERT INTO entries (id, label) VALUES (2, 'synthetic migrated'); PRAGMA user_version = 2;",
  );
}

test('активирует проверенный SHA после принятия и возвращает допустимый предыдущий SHA', async () => {
  const { acceptUpdate, restorePrevious } = require('../../core/adapters/update/install.ts');
  const f = await updateFixture();
  try {
    let checks = 0;
    let migrations = 0;
    const selfCheck = (db: import('node:sqlite').DatabaseSync, sha: string) => {
      checks++;
      assert.equal(sha, nextSha);
      assert.deepEqual(data(f.dbPath), original);
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 2);
      db.exec("UPDATE entries SET label = 'copy only' WHERE id = 1");
      assert.deepEqual(data(f.dbPath), original);
    };
    await acceptUpdate({
      ...f,
      sha: nextSha,
      allowed: true,
      sessionActive: false,
      migrate: (db: import('node:sqlite').DatabaseSync) => {
        migrations++;
        migration(db);
      },
      selfCheck,
      compatible: (_db: import('node:sqlite').DatabaseSync, sha: string) => sha === nextSha,
    });
    assert.equal(checks, 1);
    assert.equal(migrations, 2);
    assert.deepEqual(await state(f.stateFile), { current: nextSha, previous: currentSha });
    assert.deepEqual(data(f.dbPath), migrated);

    let restoreChecks = 0;
    let compatibilityChecks = 0;
    const restore = {
      ...f,
      selfCheck: (db: import('node:sqlite').DatabaseSync, sha: string) => {
        restoreChecks++;
        assert.equal(sha, currentSha);
        assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 2);
        db.exec("UPDATE entries SET label = 'restore copy only' WHERE id = 1");
      },
      compatible: (_db: import('node:sqlite').DatabaseSync, sha: string) => {
        compatibilityChecks++;
        assert.equal(sha, currentSha);
        return false;
      },
    };
    await assert.rejects(restorePrevious(restore));
    assert.equal(compatibilityChecks, 1);
    assert.deepEqual(await state(f.stateFile), { current: nextSha, previous: currentSha });
    assert.deepEqual(data(f.dbPath), migrated);
    assert.equal(
      await fs.readFile(path.join(f.rootDir, 'system/policy.conf'), 'utf8'),
      'next synthetic policy\n',
    );
    let boundaryChecks = 0;
    const previousPolicy = 'current synthetic policy\n';
    const previousRoot = {
      tree: { 'system/policy.conf': hashes(previousPolicy) },
      allowedPaths: ['system/policy.conf'],
      checkBoundary: async ({ rootDir: installed }: { rootDir: string }) => {
        boundaryChecks++;
        assert.equal(
          await fs.readFile(path.join(installed, 'system/policy.conf'), 'utf8'),
          previousPolicy,
        );
        assert.equal(
          await fs.readFile(path.join(installed, 'base/launcher.js'), 'utf8'),
          'next synthetic launcher\n',
        );
      },
    };
    const verifiedRestore = {
      ...restore,
      previousRoot,
      compatible: (_db: import('node:sqlite').DatabaseSync, sha: string) => {
        compatibilityChecks++;
        return sha === currentSha;
      },
    };
    const previousPolicyFile = path.join(f.releasesDir, currentSha, 'system/policy.conf');
    await fs.writeFile(previousPolicyFile, 'tampered synthetic policy\n');
    await assert.rejects(restorePrevious(verifiedRestore));
    assert.equal(boundaryChecks, 0);
    assert.deepEqual(await state(f.stateFile), { current: nextSha, previous: currentSha });
    assert.deepEqual(data(f.dbPath), migrated);
    assert.equal(
      await fs.readFile(path.join(f.rootDir, 'system/policy.conf'), 'utf8'),
      'next synthetic policy\n',
    );
    assert.equal(
      await fs.readFile(path.join(f.rootDir, 'base/launcher.js'), 'utf8'),
      'next synthetic launcher\n',
    );
    await fs.writeFile(previousPolicyFile, previousPolicy);
    await restorePrevious(verifiedRestore);
    assert.ok(restoreChecks >= 1);
    assert.equal(compatibilityChecks, 3);
    assert.equal(boundaryChecks, 1);
    assert.deepEqual(await state(f.stateFile), { current: currentSha, previous: null });
    assert.deepEqual(data(f.dbPath), migrated);
    assert.equal(
      await fs.readFile(path.join(f.rootDir, 'system/policy.conf'), 'utf8'),
      'current synthetic policy\n',
    );
    assert.equal(
      await fs.readFile(path.join(f.rootDir, 'base/launcher.js'), 'utf8'),
      'next synthetic launcher\n',
    );
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

async function failedUpdates() {
  const { acceptUpdate } = require('../../core/adapters/update/install.ts');
  for (const failure of ['not-allowed', 'session', 'check', 'migration']) {
    const f = await updateFixture();
    try {
      let checks = 0;
      let migrations = 0;
      await assert.rejects(
        acceptUpdate({
          ...f,
          sha: nextSha,
          allowed: failure !== 'not-allowed',
          sessionActive: failure === 'session',
          migrate: (db: import('node:sqlite').DatabaseSync) => {
            migrations++;
            migration(db);
            if (failure === 'migration' && migrations === 2)
              throw new Error('synthetic migration failure');
          },
          selfCheck: (db: import('node:sqlite').DatabaseSync) => {
            checks++;
            assert.deepEqual(data(f.dbPath), original);
            assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 2);
            if (failure === 'check') throw new Error('synthetic check failure');
          },
          compatible: () => true,
        }),
        failure,
      );
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
      assert.deepEqual(
        await state(f.stateFile),
        { current: currentSha, previous: previousSha },
        failure,
      );
      assert.deepEqual(data(f.dbPath), original, failure);
    } finally {
      await fs.rm(f.dir, { recursive: true, force: true });
    }
  }
}

// Proposed trusted ports: lifecycle({ phase, db }) pauses acceptance at
// 'before-commit' (inside the live transaction) and 'after-commit' (before any
// file mirror publication). launchVerified holds the same gate as acceptance,
// reconciles durable state and verifies the selected release before execute.
// These callbacks are supplied by the stand, never by an incoming release.
const { fork } = require('node:child_process');
const recoveryChild = String.raw`
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { acceptUpdate, launchVerified } = require(process.argv[1]);
const f = JSON.parse(process.argv[2]);
const mode = process.argv[3];
const target = process.argv[4];
const sha = process.argv[5];
let status = 'waiting';
const send = (message) => process.send(message);
const waitFor = (word) => new Promise((resolve) => {
  const receive = (message) => {
    if (message === word) { process.off('message', receive); resolve(); }
  };
  process.on('message', receive);
});
process.on('message', (message) => { if (message === 'probe') send({ event: 'probe', status }); });
function snapshot(db) {
  return {
    version: db.prepare('PRAGMA user_version').get().user_version,
    rows: db.prepare('SELECT id, label FROM entries ORDER BY id').all().map((row) => ({ ...row })),
    columns: db.prepare('PRAGMA table_info(entries)').all().map((row) => row.name),
  };
}
function live() {
  const db = new DatabaseSync(f.dbPath, { readOnly: true });
  try { return snapshot(db); } finally { db.close(); }
}
async function run() {
  if (mode === 'accept') {
    let migrations = 0;
    let checked = false;
    await acceptUpdate({ ...f, sha, allowed: true, sessionActive: false,
      migrate(db) {
        migrations++;
        db.exec("ALTER TABLE entries ADD COLUMN note TEXT; INSERT INTO entries (id, label) VALUES (2, 'synthetic migrated'); PRAGMA user_version = 2;");
      },
      compatible(db, selected) { return selected === sha && snapshot(db).version === 2; },
      selfCheck(db, selected) {
        assert.equal(selected, sha);
        assert.equal(migrations, 1);
        assert.equal(snapshot(db).version, 2);
        assert.equal(live().version, 1);
        db.exec("UPDATE entries SET label = 'copy only' WHERE id = 1");
        assert.equal(live().rows[0].label, 'synthetic original');
        checked = true;
      },
      async lifecycle({ phase, db }) {
        if (phase !== target) return;
        assert.equal(checked, true);
        assert.equal(migrations, 2);
        const observed = snapshot(db);
        send({ event: 'boundary', phase, observed });
        await waitFor('ack');
        send({ event: 'parked', phase });
        await new Promise(() => {});
      },
    });
    send({ event: 'finished' });
  } else {
    send({ event: 'started' });
    try {
      await launchVerified({ ...f,
        async verify(selected, db) {
          status = 'verifying';
          send({ event: 'verify', selected, observed: snapshot(db) });
          if (mode === 'recovery') {
            await waitFor('verify-ack');
            status = 'verified';
          }
          return true;
        },
        execute(selected, db) {
          send({ event: 'execute', selected, observed: snapshot(db) });
          assert.equal(status, 'verified');
          status = 'executed';
        },
      });
      send({ event: 'finished' });
    } catch (error) {
      status = 'blocked';
      send({ event: 'blocked', message: String(error && error.message) });
    }
  }
}
run().catch((error) => { send({ event: 'error', message: String(error && error.stack) }); process.exitCode = 1; });
`;

type ChildMessage = {
  event: string;
  phase?: string;
  selected?: string;
  observed?: unknown;
  status?: string;
  message?: string;
};
function recoveryProcess(f: Awaited<ReturnType<typeof updateFixture>>, mode: string, phase = '') {
  const child = fork(
    '-e',
    [
      recoveryChild,
      path.resolve('core/adapters/update/install.ts'),
      JSON.stringify(f),
      mode,
      phase,
      nextSha,
    ],
    {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  const queue: ChildMessage[] = [];
  let wake: (() => void) | undefined;
  child.on('message', (message: ChildMessage) => {
    queue.push(message);
    wake?.();
  });
  child.on('exit', () => wake?.());
  return {
    child,
    async next(): Promise<ChildMessage> {
      while (queue.length === 0) {
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`child exited: ${child.exitCode ?? child.signalCode}`);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('child handshake timed out')), 8_000);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = undefined;
      }
      return queue.shift()!;
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
    },
  };
}

for (const phase of ['before-commit', 'after-commit']) {
  test(
    `восстанавливает согласованную активацию после аварийной остановки: ${phase}`,
    { timeout: 10_000 },
    async () => {
      const f = await updateFixture();
      const accepting = recoveryProcess(f, 'accept', phase);
      let concurrent: ReturnType<typeof recoveryProcess> | undefined;
      let fresh: ReturnType<typeof recoveryProcess> | undefined;
      try {
        const boundary = await accepting.next();
        assert.equal(boundary.event, 'boundary', JSON.stringify(boundary));
        assert.equal(boundary.phase, phase);
        assert.deepEqual(boundary.observed, migrated);
        assert.deepEqual(data(f.dbPath), phase === 'before-commit' ? original : migrated);
        accepting.child.send('ack');
        assert.equal((await accepting.next()).event, 'parked');

        // A competing launch must either wait at the gate or reject, never execute.
        concurrent = recoveryProcess(f, 'concurrent');
        assert.equal((await concurrent.next()).event, 'started');
        concurrent.child.send('probe');
        const probe = await concurrent.next();
        assert.ok(probe.event === 'probe' || probe.event === 'blocked', JSON.stringify(probe));
        if (probe.event === 'probe') assert.equal(probe.status, 'waiting');
        await concurrent.stop();
        await accepting.stop();

        fresh = recoveryProcess(f, 'recovery');
        assert.equal((await fresh.next()).event, 'started');
        const verification = await fresh.next();
        const expectedSha = phase === 'before-commit' ? currentSha : nextSha;
        const expectedData = phase === 'before-commit' ? original : migrated;
        assert.equal(verification.event, 'verify', JSON.stringify(verification));
        assert.equal(verification.selected, expectedSha);
        assert.deepEqual(verification.observed, expectedData);
        fresh.child.send('probe');
        assert.deepEqual(await fresh.next(), { event: 'probe', status: 'verifying' });
        fresh.child.send('verify-ack');
        const execution = await fresh.next();
        assert.equal(execution.event, 'execute', JSON.stringify(execution));
        assert.equal(execution.selected, expectedSha);
        assert.deepEqual(execution.observed, expectedData);
        assert.equal((await fresh.next()).event, 'finished');
        assert.deepEqual(data(f.dbPath), expectedData);
      } finally {
        await fresh?.stop();
        await concurrent?.stop();
        await accepting.stop();
        await fs.rm(f.dir, { recursive: true, force: true });
      }
    },
  );
}
