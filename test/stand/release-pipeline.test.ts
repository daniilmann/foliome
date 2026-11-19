const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { test }: typeof import('node:test') = require('node:test');
const fs: typeof import('node:fs/promises') = require('node:fs/promises');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const crypto: typeof import('node:crypto') = require('node:crypto');
const { execFileSync }: typeof import('node:child_process') = require('node:child_process');

/* Proposed trusted public port: base/release-pipeline.js exports stageRelease(input).
 * Input: {repository, commit, expectedTree, allowedPaths, stagingRoot, policy,
 * version, now, transport, artifacts, verifyPublisher}. expectedTree is the
 * independently supplied closed {commit, files:{path:{mode,blobSha,sha256}}};
 * artifact paths/digests and verifyPublisher are installed trusted inputs, not
 * assertions from the fetched release. transport is the bounded origin transport.
 * Success: {ok:true, sha, version, checks, tree, stagingDir}, where tree contains
 * exact path/mode/blobSha/sha256 entries and stagingDir contains only those bytes
 * and .release-artifacts/<name>. Failure: {ok:false}; no stage is created.
 * The port composes origin, commit observation and domain validation, validates
 * committed manifest/package/lock metadata against registry and verified bytes,
 * and never executes candidate code. Only staging is authorized by this call.
 */
const git = (dir: string, ...args: string[]) =>
  execFileSync('/usr/bin/git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const blob = (bytes: Buffer) =>
  crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const integrity = (bytes: Buffer) =>
  `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`;
const api = 'https://api.github.com/repos/example/project';
const now = '2026-11-01T00:00:00.000Z';
const codexUrl =
  'https://github.com/openai/codex/releases/download/rust-v1.2.3/codex-aarch64-apple-darwin.tar.gz';
const assetUrl = 'https://release-assets.githubusercontent.com/synthetic/archive';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'release-pipeline-'));
  const repository = path.join(dir, 'repo');
  const stagingRoot = path.join(dir, 'stage');
  await fs.mkdir(repository);
  await fs.mkdir(stagingRoot, { mode: 0o700 });
  git(repository, 'init', '-q');
  git(repository, 'config', 'user.name', 'Fixture');
  git(repository, 'config', 'user.email', 'fixture@example.invalid');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const packets = ['node', 'codex', 'playwrightCore'].map((name) => ({
    name,
    bytes: Buffer.from(`inert synthetic ${name} package\n`),
  }));
  const artifacts = [];
  for (const packet of packets) {
    const archivePath = path.join(dir, `${packet.name}.bin`);
    const signaturePath = path.join(dir, `${packet.name}.sig`);
    await fs.writeFile(archivePath, packet.bytes);
    await fs.writeFile(signaturePath, crypto.sign('sha256', packet.bytes, privateKey));
    artifacts.push({ name: packet.name, archivePath, signaturePath, sha256: sha256(packet.bytes) });
  }
  const [node, codex, playwright] = packets;
  assert.ok(node && codex && playwright);
  const manifest = {
    schema: 'foliome-release/1',
    version: '2.0.0',
    node: { version: '26.13.0', sha256: sha256(node.bytes) },
    codex: { version: '1.2.3', sha256: sha256(codex.bytes), url: codexUrl },
    playwrightCore: { version: '1.64.0', integrity: integrity(playwright.bytes) },
    securityFix: null,
    securityNarrowing: null,
    rootChange: false,
    baseChange: false,
    notesRu: 'Тест',
  };
  const packageName = 'playwright-core';
  const packageVersion = manifest.playwrightCore.version;
  const registryArchive = 'https://registry.npmjs.org/playwright-core/-/playwright-core-1.64.0.tgz';
  const dependencies = { [packageName]: packageVersion };
  const engines = { node: manifest.node.version };
  const files: Record<string, Buffer> = {
    '.github/workflows/release.yml': Buffer.from('name: synthetic\n'),
    'README.md': Buffer.from('Synthetic release\n'),
    'package.json': Buffer.from(
      JSON.stringify({
        name: 'synthetic-release',
        version: manifest.version,
        type: 'commonjs',
        engines,
        dependencies,
      }),
    ),
    'package-lock.json': Buffer.from(
      JSON.stringify({
        name: 'synthetic-release',
        version: manifest.version,
        lockfileVersion: 3,
        packages: {
          '': { name: 'synthetic-release', version: manifest.version, engines, dependencies },
          'node_modules/playwright-core': {
            version: packageVersion,
            resolved: registryArchive,
            integrity: integrity(playwright.bytes),
          },
        },
      }),
    ),
    'release/manifest.json': Buffer.from(JSON.stringify(manifest)),
    'release/notes.en.md': Buffer.from('Synthetic notes\n'),
    'source.js': Buffer.from('globalThis.syntheticReleaseExecuted = true;\n'),
  };
  for (const [name, bytes] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(repository, name)), { recursive: true });
    await fs.writeFile(path.join(repository, name), bytes);
  }
  git(repository, 'add', '-A');
  git(repository, 'commit', '-qm', 'synthetic release');
  const commit = git(repository, 'rev-parse', 'HEAD');
  const expectedFiles = Object.fromEntries(
    Object.entries(files).map(([name, bytes]) => [
      name,
      {
        mode: '100644',
        blobSha: blob(bytes),
        sha256: sha256(bytes),
      },
    ]),
  );
  const checks = ['.github/workflows/release.yml', 'package.json', 'package-lock.json'];
  const policy = {
    installedVersion: '1.0.0',
    repository: 'example/project',
    workflowId: 7,
    codexArchiveUrlPrefix: 'https://github.com/openai/codex/releases/download/',
    allowedRootFiles: ['README.md', 'package.json', 'package-lock.json', 'source.js'],
    allowedDirectories: ['.github', 'release'],
    pinnedCheckBlobs: Object.fromEntries(checks.map((name) => [name, expectedFiles[name].blobSha])),
  };
  const run = {
    id: 9,
    run_attempt: 1,
    workflow_id: 7,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_sha: commit,
    head_branch: 'v2.0.0',
    head_repository: { full_name: 'example/project' },
    repository: { full_name: 'example/project' },
    pull_requests: [],
  };
  const jobs = [
    'typescript',
    'eslint',
    'prettier',
    'unit',
    'stand',
    'protective',
    'signatures',
    'advisory',
    'migration',
    'publish',
  ].map((name) => ({
    name,
    run_id: 9,
    head_sha: commit,
    head_branch: 'v2.0.0',
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
  }));
  const registry = {
    name: 'playwright-core',
    versions: {
      '1.64.0': {
        name: 'playwright-core',
        version: '1.64.0',
        dist: { integrity: integrity(playwright.bytes), tarball: registryArchive },
      },
    },
    time: { '1.64.0': '2026-01-01T00:00:00.000Z' },
  };
  const routes = new Map<
    string,
    { status: number; headers: Record<string, string>; body: Buffer }
  >();
  const json = (url: string, value: unknown) =>
    routes.set(url, { status: 200, headers: {}, body: Buffer.from(JSON.stringify(value)) });
  json(`${api}/git/ref/tags/v2.0.0`, {
    ref: 'refs/tags/v2.0.0',
    object: { type: 'commit', sha: commit },
  });
  json(`${api}/contents/release/manifest.json?ref=${commit}`, {
    encoding: 'base64',
    content: files['release/manifest.json'].toString('base64'),
  });
  json(`${api}/actions/workflows/7/runs?event=push&head_sha=${commit}&per_page=100&page=1`, {
    total_count: 1,
    workflow_runs: [run],
  });
  json(`${api}/actions/runs/9/attempts/1/jobs?per_page=100&page=1`, {
    total_count: jobs.length,
    jobs,
  });
  json('https://registry.npmjs.org/playwright-core', registry);
  routes.set(codexUrl, { status: 302, headers: { location: assetUrl }, body: Buffer.alloc(0) });
  routes.set(assetUrl, { status: 200, headers: {}, body: codex.bytes });
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
    const packet = packets.find((item) => item.name === name);
    if (!packet || !bytes.equals(packet.bytes)) return false;
    verified.push(name);
    return crypto.verify('sha256', bytes, publicKey, signature);
  };
  const transport = async (url: string, limit: number) => {
    const response = routes.get(url);
    assert.ok(response, `unexpected synthetic URL ${url}`);
    assert.ok(response.body.length <= limit);
    return response;
  };
  return {
    dir,
    repository,
    stagingRoot,
    commit,
    expectedTree: { commit, files: expectedFiles },
    allowedPaths: Object.keys(files),
    policy,
    version: '2.0.0',
    now,
    transport,
    artifacts,
    verifyPublisher,
    verified,
    files,
    routes,
    json,
    manifest,
    registry,
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
function stage(input: unknown): Promise<any> {
  return require('../../base/release-pipeline.js').stageRelease(input);
}
async function refused(f: Awaited<ReturnType<typeof fixture>>, input: unknown) {
  assert.deepEqual(await stage(input), { ok: false });
  assert.deepEqual(await fs.readdir(f.stagingRoot), []);
}

test('ставит проверенные байты точного коммита без исполнения исходного кода', async () => {
  await withFixture(async (f) => {
    await fs.writeFile(path.join(f.repository, 'source.js'), 'dirty worktree\n');
    const result = await stage(f);
    assert.equal(result.ok, true);
    assert.equal(result.sha, f.commit);
    assert.equal(result.version, '2.0.0');
    assert.equal(result.checks, 'pinned');
    const expected = Object.entries(f.expectedTree.files)
      .map(([name, metadata]) => ({ path: name, ...metadata }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    assert.deepEqual(result.tree, expected);
    assert.equal(path.dirname(result.stagingDir), f.stagingRoot);
    for (const [name, bytes] of Object.entries(f.files))
      assert.deepEqual(await fs.readFile(path.join(result.stagingDir, name)), bytes);
    for (const item of f.artifacts)
      assert.deepEqual(
        await fs.readFile(path.join(result.stagingDir, '.release-artifacts', item.name)),
        await fs.readFile(item.archivePath),
      );
    assert.deepEqual(f.verified.sort(), ['codex', 'node', 'playwrightCore']);
    assert.equal((globalThis as any).syntheticReleaseExecuted, undefined);
  });
});

test('классифицирует изменённые проверки по установленным закреплениям', async () => {
  await withFixture(async (f) => {
    f.policy.pinnedCheckBlobs['package.json'] = '1'.repeat(40);
    const result = await stage(f);
    assert.equal(result.ok, true);
    assert.equal(result.checks, 'changed');
    assert.equal(result.sha, f.commit);
  });
});

test('отклоняет другой commit, неверные метаданные и несовместимые пути до staging', async () => {
  for (const kind of ['commit', 'blob', 'manifest', 'package', 'paths']) {
    await withFixture(async (f) => {
      if (kind === 'commit') {
        await fs.writeFile(path.join(f.repository, 'source.js'), 'different committed bytes\n');
        git(f.repository, 'add', '-A');
        git(f.repository, 'commit', '-qm', 'different commit');
        f.commit = git(f.repository, 'rev-parse', 'HEAD');
      }
      if (kind === 'blob') f.expectedTree.files['source.js'].sha256 = '0'.repeat(64);
      if (kind === 'manifest') {
        const changed = structuredClone(f.manifest);
        changed.node.version = '26.13.1';
        f.json(`${api}/contents/release/manifest.json?ref=${f.commit}`, {
          encoding: 'base64',
          content: Buffer.from(JSON.stringify(changed)).toString('base64'),
        });
      }
      if (kind === 'package')
        f.registry.versions['1.64.0'].dist.integrity =
          `sha512-${Buffer.alloc(64).toString('base64')}`;
      if (kind === 'package') f.json('https://registry.npmjs.org/playwright-core', f.registry);
      if (kind === 'paths') f.allowedPaths = f.allowedPaths.filter((name) => name !== 'source.js');
      await refused(f, f);
    });
  }
});

test('отклоняет неверную подпись, издателя, закреплённый digest и свежий пакет до staging', async () => {
  for (const kind of ['signature', 'issuer', 'digest', 'age']) {
    await withFixture(async (f) => {
      const packet = f.artifacts[2];
      assert.ok(packet);
      if (kind === 'signature')
        await fs.writeFile(packet.signaturePath, Buffer.from('synthetic invalid signature'));
      if (kind === 'issuer') f.verifyPublisher = async () => false;
      if (kind === 'digest') packet.sha256 = '0'.repeat(64);
      if (kind === 'age') {
        f.registry.time['1.64.0'] = '2026-10-31T00:00:00.000Z';
        f.json('https://registry.npmjs.org/playwright-core', f.registry);
      }
      await refused(f, f);
    });
  }
});
