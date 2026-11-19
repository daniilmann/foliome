'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  isReleaseRepository,
  playwrightArchiveUrl,
  readReleaseArchives,
  readReleaseOrigin,
} = require('./release-origin.js');
const { fetchReleaseCommit, observeRelease } = require('./release-observation.js');
const {
  createProductionPublisherVerifier,
  registryReleaseSignature,
} = require('./publisher-verification.js');
const { validateReleaseCandidate } = require(
  __dirname === '/Library/Application Support/Foliome/base'
    ? './release-policy.ts'
    : '../core/domain/release.ts',
);

const shaPattern = /^[a-f0-9]{40}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const installHooks = [
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'preprepare',
  'prepare',
  'postprepare',
  'dependencies',
];
const dependencyFields = [
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'bundledDependencies',
  'bundleDependencies',
];
const artifactNames = ['node', 'codex', 'playwrightCore'];
const refused = () => ({ ok: false });

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function only(value, key, expected) {
  return isObject(value) && Object.keys(value).length === 1 && value[key] === expected;
}

function hasInstallHook(value) {
  return (
    (value.hasInstallScript !== undefined && value.hasInstallScript !== false) ||
    (value.scripts !== undefined &&
      (!isObject(value.scripts) || installHooks.some((key) => Object.hasOwn(value.scripts, key))))
  );
}

function packageEvidence(entries, manifest, { metadata, publishedAgeDays }) {
  const pkg = JSON.parse(entries.get('package.json').bytes.toString('utf8'));
  const lock = JSON.parse(entries.get('package-lock.json').bytes.toString('utf8'));
  if (!isObject(lock?.packages) || entries.has('binding.gyp')) throw Error();
  const root = lock.packages[''];
  const runtime = lock.packages['node_modules/playwright-core'];
  for (const value of [pkg, root, runtime]) {
    if (
      !isObject(value) ||
      hasInstallHook(value) ||
      ['workspaces', 'overrides', ...dependencyFields].some((key) => Object.hasOwn(value, key))
    )
      throw Error();
  }
  const { version, integrity } = manifest.playwrightCore;
  const registryUrl = playwrightArchiveUrl(version);
  if (
    hasInstallHook(metadata) ||
    ['dependencies', ...dependencyFields].some(
      (key) =>
        metadata[key] !== undefined &&
        (!isObject(metadata[key]) || Object.keys(metadata[key]).length),
    ) ||
    typeof pkg.name !== 'string' ||
    !pkg.name ||
    pkg.type !== 'commonjs' ||
    lock.lockfileVersion !== 3 ||
    Object.hasOwn(lock, 'dependencies') ||
    [pkg, lock, root].some(
      (value) => value.name !== pkg.name || value.version !== manifest.version,
    ) ||
    [pkg, root].some(
      (value) =>
        !only(value.dependencies, 'playwright-core', version) ||
        !only(value.engines, 'node', manifest.node.version),
    ) ||
    runtime.version !== version ||
    runtime.resolved !== registryUrl ||
    runtime.integrity !== integrity ||
    ['dependencies', 'devDependencies'].some((key) => Object.hasOwn(runtime, key)) ||
    ['dev', 'optional', 'devOptional', 'link', 'inBundle'].some(
      (key) => runtime[key] !== undefined && runtime[key] !== false,
    ) ||
    metadata.dist?.tarball !== registryUrl ||
    metadata.dist.integrity !== integrity
  )
    throw Error();

  for (const [name, entry] of Object.entries(lock.packages)) {
    if (name === '' || name === 'node_modules/playwright-core') continue;
    if (
      !isObject(entry) ||
      !name.startsWith('node_modules/') ||
      !name
        .slice('node_modules/'.length)
        .split('/node_modules/')
        .every((part) => packageNamePattern.test(part)) ||
      entry.dev !== true ||
      entry.link ||
      entry.inBundle ||
      hasInstallHook(entry)
    )
      throw Error();
  }
  const dev = pkg.devDependencies === undefined ? {} : pkg.devDependencies;
  const devLock = root.devDependencies === undefined ? {} : root.devDependencies;
  if (
    !isObject(dev) ||
    !isObject(devLock) ||
    Object.keys(dev).length !== Object.keys(devLock).length
  )
    throw Error();
  for (const [name, exact] of Object.entries(dev)) {
    if (
      name === 'playwright-core' ||
      !packageNamePattern.test(name) ||
      typeof exact !== 'string' ||
      !versionPattern.test(exact) ||
      !Object.hasOwn(devLock, name) ||
      devLock[name] !== exact ||
      lock.packages[`node_modules/${name}`]?.version !== exact
    )
      throw Error();
  }
  return [
    { name: 'playwright-core', version, integrity, hasInstallScript: false, publishedAgeDays },
  ];
}

function digest(algorithm, bytes, encoding) {
  return crypto.createHash(algorithm).update(bytes).digest(encoding);
}

function artifactEvidence(checked, observations) {
  const byName = new Map(checked.map((item) => [item.name, item]));
  const { manifest, codexBytes } = observations;
  const node = byName.get('node');
  const codex = byName.get('codex');
  const playwright = byName.get('playwrightCore');
  if (!node?.bytes.length || !codex || !playwright?.bytes.length || !codex.bytes.equals(codexBytes))
    throw Error();
  const integrity = `sha512-${digest('sha512', playwright.bytes, 'base64')}`;
  if (
    node.sha256 !== manifest.node.sha256 ||
    codex.sha256 !== manifest.codex.sha256 ||
    integrity !== manifest.playwrightCore.integrity
  )
    throw Error();
  return {
    signatures: {
      node: { status: 'verified', sha256: node.sha256 },
      codex: { status: 'verified', sha256: codex.sha256 },
      playwrightCore: { status: 'verified', integrity },
    },
    archive: { sha256: playwright.sha256, integrity },
  };
}

function boundaryPath(name) {
  return /^(base|system)\//i.test(name);
}

function matchingBoundary(tree, manifest, installed) {
  if (manifest.rootChange !== false || manifest.baseChange !== false || !isObject(installed?.files))
    return false;
  const boundary = tree.filter((entry) => boundaryPath(entry.path));
  return (
    boundary.length === Object.keys(installed.files).length &&
    boundary.every(
      ({ path, mode, sha256 }) =>
        Object.hasOwn(installed.files, path) &&
        installed.files[path]?.mode === mode &&
        installed.files[path].sha256 === sha256,
    ) &&
    ['node', 'codex'].every(
      (name) =>
        manifest[name]?.version === installed[name]?.version &&
        manifest[name]?.sha256 === installed[name]?.sha256,
    )
  );
}

async function compose(input, checkBoundary, provideArtifacts, beforeStage = () => {}) {
  let checks;
  let version;
  let archive;
  const result = await observeRelease(input, async (tree) => {
    const entries = new Map(tree.map((entry) => [entry.path, entry]));
    const manifestBytes = entries.get('release/manifest.json').bytes;
    const committed = JSON.parse(manifestBytes.toString('utf8'));
    version = input.version ?? committed.version;
    if (
      typeof version !== 'string' ||
      !versionPattern.test(version) ||
      committed.version !== version ||
      !checkBoundary(tree, committed) ||
      typeof committed.node?.version !== 'string' ||
      !/^26\.13\.(0|[1-9]\d*)$/.test(committed.node.version) ||
      typeof committed.node.sha256 !== 'string' ||
      !sha256Pattern.test(committed.node.sha256) ||
      typeof committed.codex?.sha256 !== 'string' ||
      !sha256Pattern.test(committed.codex.sha256)
    )
      throw Error();

    let observations;
    const origin = await readReleaseOrigin({
      policy: input.policy,
      version,
      sha: input.commit,
      now: input.now,
      transport: input.transport,
      verifyBase: (observed) => {
        if (!observed.manifestBytes.equals(manifestBytes)) return false;
        observations = observed;
        return true;
      },
    });
    if (!origin.ok) throw Error();
    const runtimeDependencies = packageEvidence(entries, committed, observations.registry);
    const { artifacts, verifyPublisher } = await provideArtifacts(observations);
    if (
      artifacts.length !== artifactNames.length ||
      !artifactNames.every((name) => artifacts.some((item) => item.name === name))
    )
      throw Error();

    return {
      artifacts,
      verifyPublisher,
      validate: async (checked) => {
        const { signatures, archive: checkedArchive } = artifactEvidence(checked, observations);
        const decision = validateReleaseCandidate(
          {
            tag: observations.tag,
            manifest: committed,
            run: observations.candidateRun,
            evidence: {
              commitSha: input.commit,
              tree: tree.map(({ path, mode, blobSha }) => ({ path, mode, blobSha })),
              runtimeDependencies,
              signatures,
            },
          },
          input.policy,
        );
        if (!decision.ok) return false;
        await beforeStage();
        checks = decision.checks;
        archive = checkedArchive;
        return true;
      },
    };
  });
  if (!result.ok) return refused();
  return { ...result, sha: input.commit, version, checks, archive };
}

// Local test port. The repository and issuer ports are supplied by the fixture.
async function stageRelease(input) {
  try {
    const {
      repository,
      commit,
      expectedTree,
      allowedPaths,
      stagingRoot,
      policy,
      version,
      now,
      transport,
      artifacts,
      verifyPublisher,
    } = input;
    if (!expectedTree || typeof version !== 'string' || typeof transport !== 'function')
      return refused();
    return await compose(
      {
        repository,
        commit,
        manifest: expectedTree,
        allowedPaths,
        stagingRoot,
        policy,
        version,
        now,
        transport,
      },
      (tree, manifest) =>
        manifest.rootChange === false &&
        manifest.baseChange === false &&
        !tree.some(({ path }) => boundaryPath(path)),
      () => ({
        artifacts: artifacts.map(({ name, archivePath, signaturePath, sha256 }) => ({
          name,
          archivePath,
          signaturePath,
          sha256,
        })),
        verifyPublisher,
      }),
    );
  } catch {
    return refused();
  }
}

async function publisherArtifacts({ manifest, registry, codexBytes }, scratchRoot) {
  const signature = registryReleaseSignature(registry.metadata);
  const { node, nodeArchive, playwright } = await readReleaseArchives(
    manifest.node.version,
    manifest.playwrightCore.version,
    registry.metadata.dist.tarball,
  );
  const archives = [
    {
      name: 'node',
      kind: 'node',
      version: manifest.node.version,
      archiveName: nodeArchive,
      sha256: manifest.node.sha256,
      bytes: node,
      signature: Buffer.alloc(0),
    },
    {
      name: 'codex',
      kind: 'codex',
      version: manifest.codex.version,
      archiveName: 'codex-aarch64-apple-darwin.tar.gz',
      sha256: manifest.codex.sha256,
      bytes: codexBytes,
      signature: Buffer.alloc(0),
    },
    {
      name: 'playwrightCore',
      kind: 'playwright',
      version: manifest.playwrightCore.version,
      archiveName: `playwright-core-${manifest.playwrightCore.version}.tgz`,
      sha256: digest('sha256', playwright, 'hex'),
      bytes: playwright,
      signature,
    },
  ];
  const entries = archives.map(({ name, kind, version, archiveName, sha256 }) => ({
    name,
    kind,
    version,
    archiveName,
    sha256,
  }));
  return {
    artifacts: archives,
    verifyPublisher: createProductionPublisherVerifier({ entries, registry, scratchRoot }),
  };
}

// The installed caller supplies its policy and state separately from the selected SHA.
// Initial mode receives the exact locally approved commit and observes its version from Git.
// Administrative mode observes boundary bytes for the installer to authorize separately.
async function stageReleaseFromOrigin(selection, installed) {
  let scratch;
  const removeScratch = async () => {
    await fs.rm(scratch, { recursive: true, force: true });
    scratch = undefined;
  };
  try {
    const { commit, version } = selection;
    const scratchRoot = installed.scratchRoot ?? os.tmpdir();
    const { mode, stagingRoot, policy, boundary, rejectedShas } = structuredClone(installed);
    if (
      typeof commit !== 'string' ||
      !shaPattern.test(commit) ||
      !isReleaseRepository(policy?.repository) ||
      typeof stagingRoot !== 'string' ||
      !path.isAbsolute(stagingRoot) ||
      !['initial', 'update', 'admin'].includes(mode)
    )
      return refused();
    if (mode === 'initial') {
      if (version !== undefined) return refused();
      policy.installedVersion = '0.0.0';
    } else if (
      mode === 'update' &&
      (typeof version !== 'string' ||
        !versionPattern.test(version) ||
        !boundary ||
        !Array.isArray(rejectedShas) ||
        rejectedShas.includes(commit) ||
        rejectedShas.some((sha) => typeof sha !== 'string' || !shaPattern.test(sha)))
    ) {
      return refused();
    }
    scratch = await fs.mkdtemp(path.join(scratchRoot, '.release-read-'));
    await fs.chmod(scratch, 0o700);
    const repository = path.join(scratch, 'git');
    await fetchReleaseCommit(repository, policy.repository, commit);
    return await compose(
      { repository, commit, stagingRoot, policy, version, now: new Date().toISOString() },
      (tree, manifest) => mode !== 'update' || matchingBoundary(tree, manifest, boundary),
      (observed) => publisherArtifacts(observed, scratch),
      removeScratch,
    );
  } catch {
    return refused();
  } finally {
    if (scratch) await removeScratch().catch(() => {});
  }
}

module.exports = { stageRelease, stageReleaseFromOrigin };
