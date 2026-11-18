const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

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
  // The update/session/migration portion is intentionally pending: this test
  // currently establishes only the root transaction required by this row.
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
    } }), { message: 'synthetic boundary failure' });
    assert.equal(checked, true);
    for (const [name, text] of Object.entries(before)) assert.equal(await fs.readFile(path.join(rootDir, name), 'utf8'), text);
    await assert.rejects(fs.lstat(path.join(rootDir, 'system/new.conf')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(activeFile, 'utf8'), oldSha);
    assert.fail('Pending: exercise real update acceptance, session, self-check and SQLite migration');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
