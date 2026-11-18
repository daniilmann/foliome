{
  const assert = require('node:assert/strict');
  const { createHash } = require('node:crypto');
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const test = require('node:test');

  // Proposed public port: base/launcher.js exports async launchAcceptedRelease({
  // home, systemRoot, run }). The private home contains data/activation.sqlite,
  // data/activation.json (an older mirror), and releases/<sha>/core/system-entrypoint.ts.
  // The independently provisioned systemRoot contains bin/node and inventory.json:
  // { releases: { [sha]: { entrypointSha256 } } }. The inventory is trusted input;
  // the launcher must hash the actual regular entrypoint, reject symlinks in its
  // path, and require a valid committed activation_state row listed in inventory.
  // run(command, args, options) is the launch port; options.stdio is the exact
  // tuple ['ignore', 'pipe', 'pipe']. It need not execute the synthetic program.
  const entrypoint = 'synthetic system entrypoint\n';
  const sha = createHash('sha1').update('synthetic accepted release').digest('hex');
  const olderSha = createHash('sha1').update('synthetic older release').digest('hex');
  const unknownSha = createHash('sha1').update('synthetic unrecorded release').digest('hex');
  const digest = createHash('sha256').update(entrypoint).digest('hex');

  type Launch = {
    command: string;
    args: string[];
    options: { stdio: ['ignore', 'pipe', 'pipe'] };
  };

  async function fixture() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'base-launch-'));
    const home = path.join(dir, 'home');
    const systemRoot = path.join(dir, 'system');
    const data = path.join(home, 'data');
    const release = path.join(home, 'releases', sha);
    const program = path.join(release, 'core', 'system-entrypoint.ts');
    const node = path.join(systemRoot, 'bin', 'node');
    const dbPath = path.join(data, 'activation.sqlite');
    await Promise.all(
      [data, path.dirname(program), path.dirname(node)].map((p) =>
        fs.mkdir(p, { recursive: true, mode: 0o700 }),
      ),
    );
    await fs.writeFile(program, entrypoint, { mode: 0o600 });
    await fs.writeFile(node, 'synthetic node\n', { mode: 0o700 });
    await fs.writeFile(
      path.join(systemRoot, 'inventory.json'),
      JSON.stringify({ releases: { [sha]: { entrypointSha256: digest } } }),
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
    return { dir, home, systemRoot, dbPath, release, program, node, calls, run };
  }

  test('launches the committed release using the trusted inventory instead of the older mirror', async () => {
    const { launchAcceptedRelease } = require('../../base/launcher.js');
    const f = await fixture();
    try {
      await launchAcceptedRelease(f);
      assert.deepEqual(f.calls, [
        {
          command: '/usr/bin/env',
          args: ['-i', f.node, '--disable-sigusr1', f.program],
          options: { stdio: ['ignore', 'pipe', 'pipe'] },
        },
      ]);
    } finally {
      await fs.rm(f.dir, { recursive: true, force: true });
    }
  });

  for (const failure of ['digest', 'symlink', 'missing-state', 'corrupt-state', 'unrecorded']) {
    test(`refuses launch before run on ${failure}`, async () => {
      const { launchAcceptedRelease } = require('../../base/launcher.js');
      const f = await fixture();
      try {
        if (failure === 'digest') await fs.writeFile(f.program, 'tampered synthetic entrypoint\n');
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
