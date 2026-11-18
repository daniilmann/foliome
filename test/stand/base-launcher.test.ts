{
  const assert = require('node:assert/strict');
  const { createHash } = require('node:crypto');
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const test = require('node:test');

  // launchAcceptedRelease({ home, systemRoot, run }) uses the actual layout
  // and a private acceptance record separately provisioned from release bytes.
  // The fixture supplies an inert launch port; file and SQLite checks are real.
  const entrypoint = 'synthetic system entrypoint\n';
  const sha = createHash('sha1').update('synthetic accepted release').digest('hex');
  const olderSha = createHash('sha1').update('synthetic older release').digest('hex');
  const unknownSha = createHash('sha1').update('synthetic unrecorded release').digest('hex');
  const imported = 'synthetic loaded dependency\n';
  const digest = (content: string) => createHash('sha256').update(content).digest('hex');

  type Launch = {
    command: string;
    args: string[];
    options: { stdio: 'ignore'; env: Record<string, never> };
  };

  async function fixture() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'base-launch-'));
    const home = path.join(dir, 'home');
    const systemRoot = path.join(dir, 'system');
    const userRoot = path.join(home, 'Library/Application Support/Foliome');
    const data = path.join(userRoot, 'data');
    const accepted = path.join(data, 'accepted');
    const release = path.join(userRoot, 'app', 'releases', sha);
    const program = path.join(release, 'core', 'system-entrypoint.ts');
    const module = path.join(release, 'core', 'main.ts');
    const node = path.join(systemRoot, 'base', 'node');
    const tmpdir = path.join(data, 'tmp');
    const dbPath = path.join(data, 'core.db');
    await Promise.all(
      [accepted, tmpdir, path.dirname(program), path.dirname(node)].map((p) =>
        fs.mkdir(p, { recursive: true, mode: 0o700 }),
      ),
    );
    await fs.writeFile(program, entrypoint, { mode: 0o600 });
    await fs.writeFile(module, imported, { mode: 0o600 });
    await fs.writeFile(node, 'synthetic node\n', { mode: 0o700 });
    await fs.writeFile(
      path.join(accepted, sha + '.json'),
      JSON.stringify({
        sha,
        files: {
          'core/system-entrypoint.ts': digest(entrypoint),
          'core/main.ts': digest(imported),
        },
      }),
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(data, 'activation.json'),
      JSON.stringify({ current: olderSha, previous: null }),
      { mode: 0o600 },
    );
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(
        'CREATE TABLE activation_state (id INTEGER PRIMARY KEY CHECK (id = 1), current_sha TEXT NOT NULL, previous_sha TEXT) STRICT',
      );
      db.prepare('INSERT INTO activation_state VALUES (1, ?, ?)').run(sha, olderSha);
    } finally {
      db.close();
    }
    await fs.chmod(dbPath, 0o600);
    const calls: Launch[] = [];
    const run = (command: string, args: string[], options: Launch['options']) => {
      calls.push({ command, args, options });
    };
    return { dir, home, systemRoot, dbPath, release, program, module, node, tmpdir, calls, run };
  }

  test('launches the committed release using the trusted inventory instead of the older mirror', async () => {
    const { launchAcceptedRelease } = require('../../base/launcher.js');
    const f = await fixture();
    try {
      await launchAcceptedRelease(f);
      assert.deepEqual(f.calls, [
        {
          command: '/usr/bin/env',
          args: [
            '-i',
            'HOME=' + f.home,
            'PATH=/usr/bin:/bin:/usr/sbin:/sbin',
            'TMPDIR=' + f.tmpdir,
            f.node,
            '--disable-sigusr1',
            f.program,
          ],
          options: { stdio: 'ignore', env: {} },
        },
      ]);
    } finally {
      await fs.rm(f.dir, { recursive: true, force: true });
    }
  });

  test('accepts an installed runtime larger than the source-file limit', async () => {
    const { launchAcceptedRelease } = require('../../base/launcher.js');
    const f = await fixture();
    try {
      await fs.truncate(f.node, 150 * 1024 * 1024);
      await launchAcceptedRelease(f);
      assert.equal(f.calls.length, 1);
    } finally {
      await fs.rm(f.dir, { recursive: true, force: true });
    }
  });

  for (const failure of [
    'digest',
    'dependency',
    'extra-module',
    'symlink',
    'missing-state',
    'corrupt-state',
    'unrecorded',
  ]) {
    test(`refuses launch before run on ${failure}`, async () => {
      const { launchAcceptedRelease } = require('../../base/launcher.js');
      const f = await fixture();
      try {
        if (failure === 'digest') await fs.writeFile(f.program, 'tampered synthetic entrypoint\n');
        if (failure === 'dependency') await fs.writeFile(f.module, 'tampered synthetic import\n');
        if (failure === 'extra-module')
          await fs.writeFile(path.join(f.release, 'core/new.ts'), 'extra synthetic import\n');
        if (failure === 'symlink') {
          const target = path.join(f.dir, 'linked-entrypoint');
          await fs.rename(f.program, target);
          await fs.symlink(target, f.program);
        }
        if (failure === 'missing-state') await fs.rm(f.dbPath);
        if (failure === 'corrupt-state') await fs.writeFile(f.dbPath, 'not sqlite');
        if (failure === 'unrecorded') {
          const db = new DatabaseSync(f.dbPath);
          try {
            db.prepare('UPDATE activation_state SET current_sha = ? WHERE id = 1').run(unknownSha);
          } finally {
            db.close();
          }
        }
        await assert.rejects(async () => launchAcceptedRelease(f));
        assert.deepEqual(f.calls, []);
      } finally {
        await fs.rm(f.dir, { recursive: true, force: true });
      }
    });
  }
}
