const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { test }: typeof import('node:test') = require('node:test');
const fs: typeof import('node:fs/promises') = require('node:fs/promises');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const crypto: typeof import('node:crypto') = require('node:crypto');
const zlib: typeof import('node:zlib') = require('node:zlib');

/* Proposed local port: base/release-materialization.js exports materializeRelease.
 * Input {stage, approval, releasesRoot}: stage is the trusted successful result of
 * stageRelease (sha, version, tree and stagingDir), augmented by the independently
 * trusted archive {sha256, integrity, files:{relative path:{sha256, mode}}};
 * approval is the exact approved SHA. releasesRoot is a private local directory.
 * Success {ok:true, sha, releaseDir, inventory}, inventory is a path-sorted array
 * of {path, mode, sha256} for every installed regular file, and releaseDir is
 * releasesRoot/<sha>. Only source files and the listed package files are installed.
 * Failure {ok:false} publishes no partial SHA and leaves other releases unchanged.
 * A retry after a failed attempt must succeed. No source, package, npm or scripts run.
 * The archive is gzip containing strict USTAR: regular files only, package/ prefix,
 * closed trusted file inventory, matching package metadata and runtime dependency.
 */
const commit = 'a'.repeat(40);
const digest = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const sri = (b: Buffer) => `sha512-${crypto.createHash('sha512').update(b).digest('base64')}`;
const blob = (b: Buffer) =>
  crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
const pkg = Buffer.from('{"name":"playwright-core","version":"1.64.1"}\n');
const moduleBytes = Buffer.from('module.exports = "inert fixture";\n');
const source = Buffer.from(
  'require("node:fs").writeFileSync(process.env.MATERIALIZATION_MARKER, "source ran");\n',
);
const rootPackage = Buffer.from(
  '{"name":"fixture","version":"1.0.0","dependencies":{"playwright-core":"1.64.1"},"scripts":{"test":"node source.js"}}\n',
);

function tar(entries: { name: string; bytes: Buffer; type?: string; mode?: number }[]) {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    const field = (offset: number, size: number, value: string) =>
      header.write(value, offset, size, 'ascii');
    const octal = (offset: number, size: number, value: number) =>
      field(offset, size, value.toString(8).padStart(size - 1, '0') + '\0');
    field(0, 100, entry.name);
    octal(100, 8, entry.mode ?? 0o644);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, entry.bytes.length);
    octal(136, 12, 0);
    header.fill(0x20, 148, 156);
    field(156, 1, entry.type ?? '0');
    field(257, 6, 'ustar\0');
    field(263, 2, '00');
    octal(
      148,
      8,
      header.reduce((sum, byte) => sum + byte, 0),
    );
    parts.push(header, entry.bytes, Buffer.alloc((512 - (entry.bytes.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}
const entries = () => [
  { name: 'package/package.json', bytes: pkg },
  { name: 'package/index.js', bytes: moduleBytes },
];

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'materialization-'));
  await fs.chmod(dir, 0o700);
  const stagingDir = path.join(dir, 'stage');
  const releasesRoot = path.join(dir, 'releases');
  await fs.mkdir(stagingDir, { mode: 0o700 });
  await fs.mkdir(releasesRoot, { mode: 0o700 });
  await fs.mkdir(path.join(stagingDir, '.release-artifacts'), { mode: 0o700 });
  const sources = { 'package.json': rootPackage, 'source.js': source };
  for (const [name, bytes] of Object.entries(sources))
    await fs.writeFile(path.join(stagingDir, name), bytes, { mode: 0o600 });
  const archive = tar(entries());
  assert.equal(digest(archive), '87106f22abf2e85a7d12afcdcef973f9aa52e3de0eb10a93a93a591343cd66da');
  assert.equal(
    sri(archive),
    'sha512-hgnnr2jNK0DbgmJNYzaLxSpN3M/6H265XvC0MmChC3yEyr+syqvUrE6I0I5vM1XNsbJzge/SVLtePo6YFinx6Q==',
  );
  assert.equal(
    digest(rootPackage),
    'f624cbcbd22acad359d3816e21ff7cc9f87704bed1c066683aa0e2de504528fc',
  );
  assert.equal(digest(source), '21dc83c47d55114f541ded74c4d78c5145eab9037b85d0820769fc8095a00597');
  assert.equal(digest(pkg), '3e501518b84a03e45b54d37f7426e5b1b3720e8229f17bbbd971766a2726efcf');
  assert.equal(
    digest(moduleBytes),
    'd17edffe8b4c0fcc7fae79347d3de7e7ebaafab7db61913667d63e606fcaa80b',
  );
  const marker = path.join(dir, 'executed');
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin, { mode: 0o700 });
  await fs.writeFile(path.join(bin, 'npm'), `#!/bin/sh\nprintf npm > "${marker}"\n`, {
    mode: 0o700,
  });
  await fs.writeFile(path.join(stagingDir, '.release-artifacts/playwrightCore'), archive, {
    mode: 0o600,
  });
  const tree = Object.entries(sources).map(([name, bytes]) => ({
    path: name,
    mode: '100644',
    blobSha: blob(bytes),
    sha256: digest(bytes),
  }));
  const stage = {
    ok: true,
    sha: commit,
    version: '1.0.0',
    checks: 'pinned',
    tree,
    stagingDir,
    archive: {
      sha256: digest(archive),
      integrity: sri(archive),
      files: {
        'index.js': { mode: '100644', sha256: digest(moduleBytes) },
        'package.json': { mode: '100644', sha256: digest(pkg) },
      },
    },
  };
  const previous = path.join(releasesRoot, 'previous');
  await fs.mkdir(previous, { mode: 0o700 });
  await fs.writeFile(path.join(previous, 'sentinel'), 'previous release', { mode: 0o600 });
  return { dir, stagingDir, releasesRoot, stage, sources, previous, archive, marker, bin };
}
async function withFixture(run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture();
  const oldPath = process.env.PATH;
  const oldMarker = process.env.MATERIALIZATION_MARKER;
  process.env.PATH = `${f.bin}:/usr/bin:/bin`;
  process.env.MATERIALIZATION_MARKER = f.marker;
  try {
    await run(f);
    await assert.rejects(fs.access(f.marker), { code: 'ENOENT' });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldMarker === undefined) delete process.env.MATERIALIZATION_MARKER;
    else process.env.MATERIALIZATION_MARKER = oldMarker;
    await fs.rm(f.dir, { recursive: true, force: true });
  }
}
function materialize(input: unknown): Promise<any> {
  return require('../../base/release-materialization.js').materializeRelease(input);
}
async function unchanged(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal(await fs.readFile(path.join(f.previous, 'sentinel'), 'utf8'), 'previous release');
  assert.deepEqual(await fs.readdir(f.releasesRoot), ['previous']);
}

test('материализует точный выпуск и полную квитанцию без исполнения', async () => {
  await withFixture(async (f) => {
    const result = await materialize({
      stage: f.stage,
      approval: commit,
      releasesRoot: f.releasesRoot,
    });
    assert.equal(result.ok, true);
    assert.equal(result.sha, commit);
    assert.equal(result.releaseDir, path.join(f.releasesRoot, commit));
    const expected = [
      {
        path: 'node_modules/playwright-core/index.js',
        mode: '100644',
        sha256: digest(moduleBytes),
      },
      { path: 'node_modules/playwright-core/package.json', mode: '100644', sha256: digest(pkg) },
      ...f.stage.tree.map(({ path: name, mode, sha256 }) => ({ path: name, mode, sha256 })),
    ].sort((a, b) => a.path.localeCompare(b.path, 'en'));
    assert.deepEqual(result.inventory, expected);
    for (const [name, bytes] of Object.entries(f.sources))
      assert.deepEqual(await fs.readFile(path.join(result.releaseDir, name)), bytes);
    assert.deepEqual(
      await fs.readFile(path.join(result.releaseDir, 'node_modules/playwright-core/package.json')),
      pkg,
    );
    assert.deepEqual(
      await fs.readFile(path.join(result.releaseDir, 'node_modules/playwright-core/index.js')),
      moduleBytes,
    );
    assert.deepEqual(await fs.readdir(path.join(result.releaseDir, 'node_modules')), [
      'playwright-core',
    ]);
    assert.deepEqual(
      (await fs.readdir(path.join(result.releaseDir, 'node_modules/playwright-core'))).sort(),
      ['index.js', 'package.json'],
    );
    assert.deepEqual((await fs.readdir(result.releaseDir)).sort(), [
      'node_modules',
      'package.json',
      'source.js',
    ]);
    assert.equal(await fs.readFile(path.join(f.previous, 'sentinel'), 'utf8'), 'previous release');
  });
});

test('отказывает без точного утверждения и сохраняет прежний выпуск', async () => {
  await withFixture(async (f) => {
    assert.deepEqual(
      await materialize({ stage: f.stage, approval: 'b'.repeat(40), releasesRoot: f.releasesRoot }),
      { ok: false },
    );
    await unchanged(f);
  });
});

test('отказывает неверным архивам и метаданным атомарно, исправление позволяет повтор', async () => {
  for (const kind of ['link', 'extra', 'outside', 'digest', 'mode', 'metadata']) {
    await withFixture(async (f) => {
      const bad = entries();
      if (kind === 'link')
        bad.push({ name: 'package/link', bytes: Buffer.alloc(0), type: '2' } as any);
      if (kind === 'extra') bad.push({ name: 'package/unlisted', bytes: Buffer.from('inert') });
      if (kind === 'outside') bad.push({ name: 'outside/inert', bytes: Buffer.from('inert') });
      if (kind === 'mode') bad[1] = { ...bad[1]!, mode: 0o755 } as any;
      if (kind === 'metadata') bad.shift();
      const archive = tar(bad);
      if (kind === 'digest') {
        // The gzip OS field changes the archive bytes without changing its files.
        archive[9] = archive[9]! ^ 1;
        assert.deepEqual(zlib.gunzipSync(archive), zlib.gunzipSync(f.archive));
      }
      await fs.writeFile(path.join(f.stagingDir, '.release-artifacts/playwrightCore'), archive);
      if (kind !== 'digest') {
        f.stage.archive.sha256 = digest(archive);
        f.stage.archive.integrity = sri(archive);
      }
      assert.deepEqual(
        await materialize({ stage: f.stage, approval: commit, releasesRoot: f.releasesRoot }),
        { ok: false },
        kind,
      );
      await unchanged(f);
      await fs.writeFile(path.join(f.stagingDir, '.release-artifacts/playwrightCore'), f.archive);
      f.stage.archive.sha256 = digest(f.archive);
      f.stage.archive.integrity = sri(f.archive);
      const result = await materialize({
        stage: f.stage,
        approval: commit,
        releasesRoot: f.releasesRoot,
      });
      assert.equal(result.ok, true, `repair: ${kind}`);
      assert.equal(result.releaseDir, path.join(f.releasesRoot, commit));
    });
  }
});
