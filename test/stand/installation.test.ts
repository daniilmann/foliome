const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Proposed port: installInitial({ releaseDir, rootDir, activeFile, sha, tree,
// allowedPaths, checkBoundary }) -> Promise<void>; failures reject. tree maps
// relative paths to Git blob SHA-1 and SHA-256 of the exact UTF-8 bytes.
// checkBoundary({rootDir, stagingDir}) runs after root files are replaced, in
// the same call; the adapter owns staging, verification, backup and restore.
const sha = '1111111111111111111111111111111111111111';
const files: Record<string, string> = {
  'base/launcher.js': 'synthetic launcher v1\n',
  'system/policy.conf': 'synthetic policy v1\n',
};
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
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'install-stand-'));
  const releaseDir = path.join(dir, 'release');
  const rootDir = path.join(dir, 'root');
  const activeFile = path.join(dir, 'active');
  for (const [name, text] of Object.entries(files)) await put(releaseDir, name, text);
  await fs.mkdir(rootDir);
  const tree = Object.fromEntries(Object.entries(files).map(([name, text]) => [name, hashes(text)]));
  return { dir, releaseDir, rootDir, activeFile, sha, tree, allowedPaths: Object.keys(files) };
}
async function absent(file: string) {
  await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
}

test('ставит и восстанавливает основу и оставляет выпуск неактивным при сбое первой установки', async () => {
  const { installInitial } = require('../../base/install-root.js');
  const f = await fixture();
  try {
    let checks = 0;
    const checkBoundary = async ({ rootDir, stagingDir }: any) => {
      checks++;
      assert.notEqual(stagingDir, f.releaseDir);
      assert.equal(await fs.readFile(path.join(rootDir, 'system/policy.conf'), 'utf8'), files['system/policy.conf']);
      assert.equal(await fs.readFile(path.join(stagingDir, 'base/launcher.js'), 'utf8'), files['base/launcher.js']);
    };
    await installInitial({ ...f, checkBoundary });
    assert.equal(await fs.readFile(f.activeFile, 'utf8'), sha);
    for (const [name, text] of Object.entries(files)) assert.equal(await fs.readFile(path.join(f.rootDir, name), 'utf8'), text);
    await put(f.rootDir, 'base/launcher.js', 'damaged synthetic launcher\n');
    await installInitial({ ...f, checkBoundary });
    assert.equal(await fs.readFile(path.join(f.rootDir, 'base/launcher.js'), 'utf8'), files['base/launcher.js']);
    assert.equal(await fs.readFile(f.activeFile, 'utf8'), sha);
    assert.equal(checks, 2);

    const empty = await fixture();
    try {
      await assert.rejects(installInitial({ ...empty, checkBoundary: async () => { throw new Error('synthetic boundary failure'); } }), (error: Error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'boundary-failed');
        assert.doesNotMatch(error.message, /synthetic boundary failure/);
        return true;
      });
      await absent(empty.activeFile);
      for (const name of Object.keys(files)) await absent(path.join(empty.rootDir, name));
    } finally { await fs.rm(empty.dir, { recursive: true, force: true }); }

    for (const kind of ['digest', 'symlink', 'hardlink', 'extra']) {
      const bad = await fixture();
      try {
        const target = path.join(bad.releaseDir, 'system/policy.conf');
        if (kind === 'digest') await fs.writeFile(target, 'tampered synthetic policy\n');
        if (kind === 'symlink') { await fs.unlink(target); await fs.symlink(path.join(bad.releaseDir, 'base/launcher.js'), target); }
        if (kind === 'hardlink') { await fs.unlink(target); await fs.link(path.join(bad.releaseDir, 'base/launcher.js'), target); }
        if (kind === 'extra') await put(bad.releaseDir, 'system/extra.conf', 'unexpected\n');
        let called = false;
        await assert.rejects(installInitial({ ...bad, checkBoundary: async () => { called = true; } }), kind);
        assert.equal(called, false, kind);
        await absent(bad.activeFile);
        for (const name of Object.keys(files)) await absent(path.join(bad.rootDir, name));
      } finally { await fs.rm(bad.dir, { recursive: true, force: true }); }
    }
  } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
});
