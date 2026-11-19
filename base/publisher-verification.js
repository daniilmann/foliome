'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');

const keyId = 'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U';
const keyDer = Buffer.from(
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W++7aUPzvMTrezH6Ycx3c+HOKYCcNGybJZSCJq/fd7Qa8uuAKtdIkUQtQiEKERhAmE5lMMJhP8OkDOa2g==',
  'base64',
);
const limit = 512 * 1024 * 1024;
const timeout = 120000;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const hashPattern = /^[a-f0-9]{64}$/;
const env = { PATH: '/usr/bin:/bin', HOME: '/dev/null', LC_ALL: 'C' };

function command(program, args, maxBuffer = 1024 * 1024) {
  return execFileSync(program, args, {
    env,
    timeout,
    maxBuffer,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function extract(archive, member, destination) {
  const handle = await fs.open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  const child = spawn('/usr/bin/tar', ['-xOzf', archive, '--', member], {
    env,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(Error())));
  });
  const copy = async () => {
    let size = 0;
    for await (const chunk of child.stdout) {
      size += chunk.length;
      if (size > limit) throw Error();
      await handle.writeFile(chunk);
    }
    if (!size) throw Error();
  };
  try {
    await Promise.all([copy(), exited]);
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    await handle.close();
  }
}

async function verifyBinary(bytes, entry, scratchRoot, returnBytes = false) {
  const root = await fs.lstat(scratchRoot);
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    root.uid !== process.getuid() ||
    root.mode & 0o077
  )
    throw Error();
  const scratch = await fs.mkdtemp(path.join(scratchRoot, '.publisher-'));
  try {
    await fs.chmod(scratch, 0o700);
    const archive = path.join(scratch, 'archive');
    const file = path.join(scratch, 'binary');
    await fs.writeFile(archive, bytes, { flag: 'wx', mode: 0o600 });
    const listing = command('/usr/bin/tar', ['-tvzf', archive, '--', entry.member]).toString(
      'utf8',
    );
    const lines = listing.split('\n');
    if (
      lines.length !== 2 ||
      lines[1] !== '' ||
      !/^-[rwxstST-]{9}\s/.test(lines[0]) ||
      lines[0].includes(' link to ') ||
      !lines[0].endsWith(` ${entry.member}`)
    )
      throw Error();
    await extract(archive, entry.member, file);
    const handle = await fs.open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > limit) throw Error();
    } finally {
      await handle.close();
    }
    command('/usr/bin/codesign', [
      '--verify',
      '--strict',
      '--check-notarization',
      '-R',
      `=anchor apple generic and identifier "${entry.identifier}" and certificate leaf[subject.OU] = "${entry.team}"`,
      file,
    ]);
    command('/usr/sbin/spctl', ['-a', '-t', 'install', '--ignore-cache', '--no-cache', file]);
    if (returnBytes) return await fs.readFile(file);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

function registryReleaseSignature(metadata) {
  const signatures = metadata?.dist?.signatures;
  if (!Array.isArray(signatures) || signatures.length > 16) throw Error();
  for (const item of signatures) {
    if (item?.keyid !== keyId || typeof item.sig !== 'string' || item.sig.length > 256) continue;
    const signature = Buffer.from(item.sig, 'base64');
    if (
      signature.length &&
      signature.toString('base64') === item.sig &&
      matchesRegistrySignature(metadata.version, metadata.dist.integrity, signature)
    )
      return signature;
  }
  throw Error();
}

function matchesRegistrySignature(version, integrity, signature) {
  return crypto.verify(
    'sha256',
    Buffer.from(`playwright-core@${version}:${integrity}`, 'utf8'),
    { key: keyDer, format: 'der', type: 'spki' },
    signature,
  );
}

function verifyRegistry(bytes, signature, entry, registry) {
  const { metadata, publishedAt, now } = registry;
  const dist = metadata?.dist;
  const integrity = `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`;
  const expectedUrl = `https://registry.npmjs.org/playwright-core/-/playwright-core-${entry.version}.tgz`;
  const attestation = `https://registry.npmjs.org/-/npm/v1/attestations/playwright-core@${entry.version}`;
  const published = Date.parse(publishedAt);
  const current = Date.parse(now);
  if (
    metadata?.name !== 'playwright-core' ||
    metadata.version !== entry.version ||
    dist?.tarball !== expectedUrl ||
    dist.integrity !== integrity ||
    dist.attestations?.url !== attestation ||
    dist.attestations?.provenance?.predicateType !== 'https://slsa.dev/provenance/v1' ||
    !Number.isFinite(published) ||
    !Number.isFinite(current) ||
    current - published < 30 * 86400000 ||
    ['dependencies', 'optionalDependencies', 'peerDependencies'].some(
      (key) =>
        metadata[key] != null &&
        (typeof metadata[key] !== 'object' || Object.keys(metadata[key]).length !== 0),
    ) ||
    (metadata.scripts != null &&
      (typeof metadata.scripts !== 'object' ||
        ['preinstall', 'install', 'postinstall'].some((key) =>
          Object.hasOwn(metadata.scripts, key),
        ))) ||
    !Array.isArray(dist.signatures) ||
    !dist.signatures.some(
      (item) =>
        item?.keyid === keyId &&
        typeof item.sig === 'string' &&
        Buffer.from(item.sig, 'base64').equals(signature),
    ) ||
    !matchesRegistrySignature(entry.version, integrity, signature)
  )
    throw Error();
}

// The caller supplies closed release entries and trusted registry metadata, not archive claims.
function createProductionPublisherVerifier({
  entries,
  registry,
  scratchRoot = os.tmpdir(),
  observeRuntime,
}) {
  if (!Array.isArray(entries) || entries.length !== 3 || !registry) throw Error('configuration');
  const trustedRegistry = structuredClone(registry);
  const byName = new Map();
  const kinds = new Set();
  for (const item of entries) {
    if (
      !item ||
      typeof item.name !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(item.name) ||
      byName.has(item.name) ||
      kinds.has(item.kind) ||
      !versionPattern.test(item.version) ||
      !hashPattern.test(item.sha256) ||
      !['node', 'codex', 'playwright'].includes(item.kind)
    )
      throw Error('configuration');
    const archiveName =
      item.kind === 'node'
        ? `node-v${item.version}-darwin-arm64.tar.gz`
        : item.kind === 'codex'
          ? 'codex-aarch64-apple-darwin.tar.gz'
          : `playwright-core-${item.version}.tgz`;
    if (item.archiveName !== archiveName) throw Error('configuration');
    const member =
      item.kind === 'node'
        ? `node-v${item.version}-darwin-arm64/bin/node`
        : 'codex-aarch64-apple-darwin';
    byName.set(item.name, {
      ...item,
      member,
      identifier: item.kind,
      team: item.kind === 'node' ? 'HX7739G8FX' : '2DC432GLL2',
    });
    kinds.add(item.kind);
  }
  return async ({ name, bytes, signature }) => {
    try {
      const entry = byName.get(name);
      if (
        !entry ||
        !Buffer.isBuffer(bytes) ||
        bytes.length > 256 * 1024 * 1024 ||
        !Buffer.isBuffer(signature) ||
        signature.length > 1024 * 1024 ||
        crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256
      )
        return false;
      if (entry.kind === 'playwright') verifyRegistry(bytes, signature, entry, trustedRegistry);
      else {
        const binary = await verifyBinary(bytes, entry, scratchRoot, !!observeRuntime);
        if (observeRuntime)
          observeRuntime(name, crypto.createHash('sha256').update(binary).digest('hex'));
      }
      return true;
    } catch {
      return false;
    }
  };
}

async function verifiedRuntime(bytes, kind, { version, sha256 }, scratchRoot) {
  if (
    !Buffer.isBuffer(bytes) ||
    !bytes.length ||
    bytes.length > 256 * 1024 * 1024 ||
    !['node', 'codex'].includes(kind) ||
    !versionPattern.test(version) ||
    !hashPattern.test(sha256) ||
    crypto.createHash('sha256').update(bytes).digest('hex') !== sha256
  )
    throw Error('publisher');
  return verifyBinary(
    bytes,
    {
      member:
        kind === 'node' ? `node-v${version}-darwin-arm64/bin/node` : 'codex-aarch64-apple-darwin',
      identifier: kind,
      team: kind === 'node' ? 'HX7739G8FX' : '2DC432GLL2',
    },
    scratchRoot,
    true,
  );
}

module.exports = { createProductionPublisherVerifier, registryReleaseSignature, verifiedRuntime };
