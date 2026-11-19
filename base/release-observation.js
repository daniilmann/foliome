'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { TextDecoder } = require('node:util');
const { isReleaseRepository } = require('./release-origin.js');

const sha1 = /^[a-f0-9]{40}$/;
const sha256 = /^[a-f0-9]{64}$/;
const component = /^[A-Za-z0-9._-]+$/;
const maxFiles = 2000;
const maxBlob = 8 * 1024 * 1024;
const maxTreeBytes = 64 * 1024 * 1024;
const maxArchive = 256 * 1024 * 1024;
const gitTimeout = 30000;
const executable = 'scripts/telegram-agent.sh';
const artifactDirectory = '.release-artifacts';

function git(repository, args, maxBuffer, timeout = gitTimeout) {
  return execFileSync(
    '/usr/bin/git',
    [
      '--no-optional-locks',
      '--no-replace-objects',
      '-C',
      repository,
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'protocol.allow=never',
      '-c',
      'protocol.https.allow=always',
      '-c',
      'credential.helper=',
      '-c',
      'http.followRedirects=false',
      '-c',
      'http.sslVerify=true',
      '-c',
      'http.proxy=',
      '-c',
      'http.lowSpeedLimit=1024',
      '-c',
      'http.lowSpeedTime=15',
      '-c',
      'fetch.fsckObjects=true',
      ...args,
    ],
    {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/dev/null',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_ALLOW_PROTOCOL: 'https',
      },
      encoding: 'buffer',
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

async function fetchReleaseCommit(repository, slug, commit) {
  if (!isReleaseRepository(slug) || typeof commit !== 'string' || !sha1.test(commit)) throw Error();
  await fs.mkdir(repository, { mode: 0o700 });
  git(repository, ['init', '--bare', '--template=', '--object-format=sha1'], 1024 * 1024);
  git(
    repository,
    [
      'fetch',
      '--no-tags',
      '--depth=1',
      '--no-recurse-submodules',
      '--no-auto-maintenance',
      '--no-write-fetch-head',
      '--',
      `https://github.com/${slug}.git`,
      commit,
    ],
    1024 * 1024,
  );
}

function validPath(name) {
  return (
    typeof name === 'string' &&
    name.length <= 1024 &&
    name
      .split('/')
      .every(
        (part) =>
          part.length > 0 &&
          part.length <= 255 &&
          component.test(part) &&
          !['.', '..', '.git', '.gitmodules', 'node_modules'].includes(part.toLowerCase()),
      ) &&
    !name.toLowerCase().endsWith('.node') &&
    name.split('/')[0].toLowerCase() !== artifactDirectory
  );
}

function hash(algorithm, bytes) {
  return crypto.createHash(algorithm).update(bytes).digest('hex');
}

async function readBounded(file, limit) {
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw Error();
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw Error();
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function observeTree({
  repository,
  commit,
  manifest,
  allowedPaths,
  allowedExecutablePaths,
  policy,
}) {
  if (
    typeof repository !== 'string' ||
    typeof commit !== 'string' ||
    !sha1.test(commit) ||
    (manifest !== undefined &&
      (manifest?.commit !== commit ||
        !manifest.files ||
        typeof manifest.files !== 'object' ||
        !Array.isArray(allowedPaths))) ||
    (manifest === undefined &&
      (!Array.isArray(policy?.allowedRootFiles) || !Array.isArray(policy.allowedDirectories)))
  )
    throw Error();
  const expectedPaths = new Set(allowedPaths);
  if (
    manifest &&
    (expectedPaths.size !== allowedPaths.length ||
      expectedPaths.size > maxFiles ||
      Object.keys(manifest.files).length !== expectedPaths.size)
  )
    throw Error();
  if (
    allowedExecutablePaths !== undefined &&
    (!Array.isArray(allowedExecutablePaths) ||
      allowedExecutablePaths.some((name) => name !== executable))
  )
    throw Error();
  const rootFiles = new Set(policy?.allowedRootFiles);
  const rootDirs = new Set(policy?.allowedDirectories);
  const expectedDirs = new Set();
  for (const name of expectedPaths) {
    if (!validPath(name)) throw Error();
    for (let end = name.indexOf('/'); end !== -1; end = name.indexOf('/', end + 1)) {
      expectedDirs.add(name.slice(0, end));
    }
  }
  const result = [];
  let total = 0;
  let objects = 0;
  const deadline = performance.now() + gitTimeout;
  const decoder = new TextDecoder('utf-8', { fatal: true });

  function readObject(type, sha, limit) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) throw Error('network-timeout');
    if (++objects > maxFiles * 2 + 1) throw Error('release-invalid');
    const bytes = git(repository, ['cat-file', type, sha], limit + 1, remaining);
    const actual = crypto.createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes);
    if (bytes.length > limit || actual.digest('hex') !== sha) throw Error();
    return bytes;
  }

  function visit(treeSha, prefix = '') {
    const bytes = readObject('tree', treeSha, 4 * 1024 * 1024);
    if (!bytes.length) throw Error('release-invalid');
    const seen = new Set();
    for (let offset = 0; offset < bytes.length;) {
      const end = bytes.indexOf(0, offset);
      if (end === -1 || end + 21 > bytes.length) throw Error('release-invalid');
      const entry = /^(40000|100644|100755) ([A-Za-z0-9._-]+)$/.exec(
        bytes.toString('latin1', offset, end),
      );
      if (!entry) throw Error('release-invalid');
      const [, mode, componentName] = entry;
      const objectSha = bytes.toString('hex', end + 1, end + 21);
      offset = end + 21;
      const name = prefix ? `${prefix}/${componentName}` : componentName;
      const folded = componentName.toLowerCase();
      if (!validPath(name) || seen.has(folded)) throw Error('release-invalid');
      seen.add(folded);
      if (mode === '40000') {
        if (manifest ? !expectedDirs.has(name) : !prefix && !rootDirs.has(name))
          throw Error('release-invalid');
        visit(objectSha, name);
      } else {
        if (
          (manifest && !expectedPaths.has(name)) ||
          (!manifest && !prefix && !rootFiles.has(name))
        )
          throw Error('release-invalid');
        readBlob(name, mode, objectSha);
      }
    }
  }

  function readBlob(name, mode, blobSha) {
    const expected = manifest?.files[name];
    if (
      result.length === maxFiles ||
      (manifest &&
        (!Object.hasOwn(manifest.files, name) ||
          expected?.mode !== mode ||
          expected.blobSha !== blobSha)) ||
      (mode === '100755' &&
        (name !== executable ||
          (allowedExecutablePaths !== undefined && !allowedExecutablePaths.includes(name))))
    )
      throw Error('release-invalid');
    const bytes = readObject('blob', blobSha, maxBlob);
    total += bytes.length;
    if (total > maxTreeBytes || bytes.includes(0)) throw Error('release-invalid');
    try {
      decoder.decode(bytes);
    } catch {
      throw Error('release-invalid');
    }
    const digest = hash('sha256', bytes);
    if (manifest && expected.sha256 !== digest) throw Error();
    result.push({ path: name, mode, blobSha, sha256: digest, bytes });
  }

  const commitBytes = readObject('commit', commit, maxBlob);
  const head = /^tree ([a-f0-9]{40})\n$/.exec(commitBytes.toString('latin1', 0, 46));
  if (!head) throw Error('release-invalid');
  visit(head[1]);
  if (!result.length || (manifest && result.length !== expectedPaths.size))
    throw Error('release-invalid');
  result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return result;
}

async function observeRelease(input, prepare) {
  let tree;
  try {
    if (!prepare && input.manifest === undefined) throw Error();
    tree = observeTree(input);
  } catch (error) {
    if (input.productionErrors) throw error;
    return { ok: false, code: 'tree' };
  }
  const checked = [];
  let configuration;
  try {
    configuration = prepare ? await prepare(tree) : input;
    if (
      !Array.isArray(configuration.artifacts) ||
      configuration.artifacts.length !== 3 ||
      typeof configuration.verifyPublisher !== 'function'
    )
      throw Error();
    const names = new Set();
    for (const item of configuration.artifacts) {
      if (
        !item ||
        typeof item.name !== 'string' ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(item.name) ||
        names.has(item.name) ||
        !sha256.test(item.sha256)
      )
        throw Error();
      names.add(item.name);
      const bytes =
        prepare && Buffer.isBuffer(item.bytes)
          ? item.bytes
          : await readBounded(item.archivePath, maxArchive);
      const signature =
        prepare && Buffer.isBuffer(item.signature)
          ? item.signature
          : await readBounded(item.signaturePath, 1024 * 1024);
      if (
        bytes.length > maxArchive ||
        signature.length > 1024 * 1024 ||
        hash('sha256', bytes) !== item.sha256
      )
        throw Error();
      checked.push({ name: item.name, bytes, signature, sha256: item.sha256 });
    }
  } catch {
    return { ok: false, code: 'artifact' };
  }
  for (const item of checked) {
    try {
      if (
        (await configuration.verifyPublisher({
          name: item.name,
          bytes: Buffer.from(item.bytes),
          signature: Buffer.from(item.signature),
        })) !== true
      )
        return { ok: false, code: 'signature' };
    } catch {
      return { ok: false, code: 'signature' };
    }
  }
  let stage;
  try {
    if (prepare && (await configuration.validate(checked)) !== true) throw Error();
    const root = await fs.lstat(input.stagingRoot);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      root.uid !== process.getuid() ||
      (root.mode & 0o7777) !== 0o700
    )
      throw Error();
    stage = await fs.mkdtemp(path.join(input.stagingRoot, '.stage-'));
    await fs.chmod(stage, 0o700);
    for (const entry of tree) {
      const target = path.join(stage, entry.path);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const handle = await fs.open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        entry.mode === '100755' ? 0o700 : 0o600,
      );
      try {
        await handle.writeFile(entry.bytes);
      } finally {
        await handle.close();
      }
    }
    await fs.mkdir(path.join(stage, artifactDirectory), { mode: 0o700 });
    for (const item of checked) {
      const handle = await fs.open(
        path.join(stage, artifactDirectory, item.name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(item.bytes);
      } finally {
        await handle.close();
      }
    }
    return {
      ok: true,
      tree: tree.map(({ path, mode, blobSha, sha256 }) => ({ path, mode, blobSha, sha256 })),
      stagingDir: stage,
    };
  } catch {
    if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    return { ok: false, code: 'artifact' };
  }
}

module.exports = {
  observeRelease,
  fetchReleaseCommit,
  createProductionPublisherVerifier: require('./publisher-verification.js')
    .createProductionPublisherVerifier,
};
