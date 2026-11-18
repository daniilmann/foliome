const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { test }: typeof import('node:test') = require('node:test');
const fs: typeof import('node:fs/promises') = require('node:fs/promises');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const crypto: typeof import('node:crypto') = require('node:crypto');
const { execFileSync }: typeof import('node:child_process') = require('node:child_process');

/* Proposed closed port in base/release-observation.js:
 * observeRelease({ repository, commit, manifest, allowedPaths, artifacts,
 *   verifyPublisher, stagingRoot }) -> Promise<{ok:true, tree, stagingDir} |
 *   {ok:false, code:'tree'|'artifact'|'signature'}>.
 * manifest is independently supplied: {commit, files:{path:{mode,blobSha,sha256}}}.
 * The adapter reads the exact Git commit's recursive ls-tree and blob bytes, rehashes
 * every blob, checks UTF-8/NUL and exact path/mode set, and materializes those bytes
 * in a fresh staging directory; it must not read the candidate worktree as authority.
 * artifacts is an array of {name, archivePath, sha256, signaturePath}; the third
 * entry is the registry package archive and its signature is the registry proof.
 * verifyPublisher({name, bytes, signature}) is an independently supplied verifier,
 * called with the actual archive bytes and detached proof, and returns a boolean.
 * The adapter stages checked bytes as files only after hash and signature verification.
 * Refusal returns only the bounded code above, never untrusted exception text.
 */
const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const digest = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const blob = (bytes: Buffer) =>
  crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'release-observation-'));
  const repository = path.join(dir, 'repo');
  await fs.mkdir(repository);
  git(repository, 'init', '-q');
  git(repository, 'config', 'user.name', 'Fixture');
  git(repository, 'config', 'user.email', 'fixture@example.invalid');
  const marker = Buffer.from('checked-in synthetic release marker\n');
  await fs.writeFile(path.join(repository, 'marker.txt'), marker);
  git(repository, 'add', 'marker.txt');
  git(repository, 'commit', '-qm', 'fixture');
  const commit = git(repository, 'rev-parse', 'HEAD');
  const manifest = {
    commit,
    files: { 'marker.txt': { mode: '100644', blobSha: blob(marker), sha256: digest(marker) } },
  };
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const artifacts: { name: string; archivePath: string; signaturePath: string; sha256: string }[] =
    [];
  for (const name of ['runtime', 'tool', 'registry']) {
    const source = path.join(dir, `${name}-source`);
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'payload.txt'), `synthetic ${name} archive\n`);
    const archivePath = path.join(dir, `${name}.tar.gz`);
    execFileSync('tar', ['-czf', archivePath, '-C', source, 'payload.txt']);
    const bytes = await fs.readFile(archivePath);
    const signaturePath = path.join(dir, `${name}.sig`);
    await fs.writeFile(signaturePath, crypto.sign('sha256', bytes, privateKey));
    artifacts.push({ name, archivePath, signaturePath, sha256: digest(bytes) });
  }
  const stagingRoot = path.join(dir, 'verified');
  await fs.mkdir(stagingRoot, { mode: 0o700 });
  const verified: string[] = [];
  const verifyPublisher = async ({
    name,
    bytes,
    signature,
  }: {
    name: string;
    bytes: Buffer;
    signature: Buffer;
  }) => {
    const artifact = artifacts.find((item) => item.name === name);
    assert.ok(artifact);
    assert.deepEqual(bytes, await fs.readFile(artifact.archivePath));
    assert.deepEqual(signature, await fs.readFile(artifact.signaturePath));
    verified.push(name);
    return crypto.verify('sha256', bytes, publicKey, signature);
  };
  return {
    dir,
    repository,
    commit,
    manifest,
    marker,
    artifacts,
    verifyPublisher,
    stagingRoot,
    verified,
    allowedPaths: ['marker.txt'],
  };
}

async function withFixture(run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture();
  try {
    await run(f);
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
}

function port(): { observeRelease: (input: unknown) => Promise<any> } {
  return require('../../base/release-observation.js');
}

test('наблюдает точный Git commit и проверяет реальные архивы и подписи до активации', async () => {
  await withFixture(async (f) => {
    // Dirty worktree is deliberately different: only the committed blob is authoritative.
    await fs.writeFile(path.join(f.repository, 'marker.txt'), 'untrusted worktree\n');
    const result = await port().observeRelease(f);
    assert.equal(result.ok, true);
    assert.deepEqual(result.tree, [
      { path: 'marker.txt', mode: '100644', blobSha: blob(f.marker), sha256: digest(f.marker) },
    ]);
    assert.deepEqual(f.verified.sort(), ['registry', 'runtime', 'tool']);
    assert.equal(path.dirname(result.stagingDir), f.stagingRoot);
    assert.deepEqual(await fs.readFile(path.join(result.stagingDir, 'marker.txt')), f.marker);
  });
});

test('отклоняет несовпадающий commit, лишний путь, режим и недопустимое содержимое Git', async () => {
  for (const kind of ['commit', 'extra', 'mode', 'utf8', 'nul', 'symlink', 'blob', 'sha256']) {
    await withFixture(async (f) => {
      if (kind === 'commit') f.manifest.commit = '0'.repeat(40);
      if (kind === 'blob') f.manifest.files['marker.txt'].blobSha = '0'.repeat(40);
      if (kind === 'sha256') f.manifest.files['marker.txt'].sha256 = '0'.repeat(64);
      if (kind === 'extra') await fs.writeFile(path.join(f.repository, 'extra.txt'), 'extra\n');
      if (kind === 'mode') await fs.chmod(path.join(f.repository, 'marker.txt'), 0o755);
      if (kind === 'utf8')
        await fs.writeFile(path.join(f.repository, 'marker.txt'), Buffer.from([0xff]));
      if (kind === 'nul')
        await fs.writeFile(path.join(f.repository, 'marker.txt'), Buffer.from([65, 0, 66]));
      if (kind === 'symlink') {
        await fs.unlink(path.join(f.repository, 'marker.txt'));
        await fs.symlink('target.txt', path.join(f.repository, 'marker.txt'));
      }
      if (['extra', 'mode', 'utf8', 'nul', 'symlink'].includes(kind)) {
        git(f.repository, 'add', '-A');
        git(f.repository, 'commit', '-qm', 'changed fixture');
        f.commit = git(f.repository, 'rev-parse', 'HEAD');
        f.manifest.commit = f.commit;
        // For content cases, align hashes so text validation is independently exercised.
        if (kind === 'utf8' || kind === 'nul' || kind === 'symlink') {
          const bytes =
            kind === 'symlink'
              ? Buffer.from('target.txt')
              : await fs.readFile(path.join(f.repository, 'marker.txt'));
          f.manifest.files['marker.txt'].blobSha = blob(bytes);
          f.manifest.files['marker.txt'].sha256 = digest(bytes);
        }
      }
      const result = await port().observeRelease(f);
      assert.deepEqual(result, { ok: false, code: 'tree' }, kind);
      assert.deepEqual(await fs.readdir(f.stagingRoot), [], kind);
      assert.deepEqual(f.verified, [], kind);
    });
  }
});

test('отклоняет неверный digest или отказ независимого проверяющего до активации', async () => {
  for (const kind of ['hash', 'signature', 'verifier-refusal', 'verifier-error']) {
    await withFixture(async (f) => {
      const registry = f.artifacts.find((a) => a.name === 'registry');
      assert.ok(registry);
      if (kind === 'hash') registry.sha256 = '0'.repeat(64);
      if (kind === 'signature')
        await fs.writeFile(registry.signaturePath, Buffer.from('invalid proof'));
      const verifyPublisher =
        kind === 'verifier-refusal'
          ? async () => false
          : kind === 'verifier-error'
            ? async () => {
                throw new Error('untrusted verifier detail');
              }
            : f.verifyPublisher;
      const result = await port().observeRelease({ ...f, verifyPublisher });
      assert.deepEqual(
        result,
        { ok: false, code: kind === 'hash' ? 'artifact' : 'signature' },
        kind,
      );
      assert.deepEqual(await fs.readdir(f.stagingRoot), [], kind);
    });
  }
});
