'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { TextDecoder } = require('node:util');

const sha1 = /^[a-f0-9]{40}$/;
const sha256 = /^[a-f0-9]{64}$/;
const component = /^[A-Za-z0-9._-]+$/;
const maxFiles = 2000;
const maxBlob = 8 * 1024 * 1024;
const maxTreeBytes = 64 * 1024 * 1024;
const maxArchive = 256 * 1024 * 1024;
const executable = 'scripts/telegram-agent.sh';
const artifactDirectory = '.release-artifacts';

function git(repository, args, maxBuffer) {
  return execFileSync(
    '/usr/bin/git',
    ['--no-optional-locks', '-C', repository, '-c', 'core.hooksPath=/dev/null', ...args],
    {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/dev/null',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_NO_REPLACE_OBJECTS: '1',
      },
      encoding: 'buffer',
      timeout: 30000,
      maxBuffer,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
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
          part !== '.' &&
          part !== '..' &&
          part.toLowerCase() !== '.git',
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
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size || bytes.length > limit) throw Error();
    return bytes;
  } finally {
    await handle.close();
  }
}

function observeTree({ repository, commit, manifest, allowedPaths, allowedExecutablePaths }) {
  if (
    typeof repository !== 'string' ||
    !sha1.test(commit) ||
    !manifest ||
    manifest.commit !== commit ||
    !manifest.files ||
    typeof manifest.files !== 'object' ||
    !Array.isArray(allowedPaths)
  )
    throw Error();
  const names = Object.keys(manifest.files);
  if (
    !names.length ||
    names.length > maxFiles ||
    names.length !== allowedPaths.length ||
    new Set(allowedPaths).size !== names.length ||
    names.some((name) => !validPath(name) || !allowedPaths.includes(name))
  )
    throw Error();
  if (
    allowedExecutablePaths !== undefined &&
    (!Array.isArray(allowedExecutablePaths) ||
      allowedExecutablePaths.some((name) => name !== executable))
  )
    throw Error();
  const seen = new Map();
  for (const name of names) {
    const parts = name.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      const key = prefix.toLowerCase();
      const entry = seen.get(key);
      const file = i === parts.length;
      if (entry && (entry.prefix !== prefix || entry.file || file)) throw Error();
      seen.set(key, { prefix, file });
    }
  }
  if (git(repository, ['cat-file', '-t', commit], 1024).toString('ascii') !== 'commit\n')
    throw Error();
  const raw = git(repository, ['ls-tree', '-r', '-z', '--full-tree', commit], 4 * 1024 * 1024);
  if (!raw.length || raw[raw.length - 1] !== 0) throw Error();
  const records = raw.subarray(0, -1).toString('latin1').split('\0');
  if (records.length !== names.length) throw Error();
  const result = [];
  let total = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const record of records) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\x20-\x7e]+)$/.exec(record);
    if (!match) throw Error();
    const [, mode, blobSha, name] = match;
    const expected = manifest.files[name];
    if (
      !validPath(name) ||
      !Object.hasOwn(manifest.files, name) ||
      !allowedPaths.includes(name) ||
      !expected ||
      expected.mode !== mode ||
      expected.blobSha !== blobSha ||
      !sha256.test(expected.sha256) ||
      (mode === '100755' &&
        (name !== executable ||
          (allowedExecutablePaths !== undefined && !allowedExecutablePaths.includes(name))))
    )
      throw Error();
    const bytes = git(repository, ['cat-file', 'blob', blobSha], maxBlob + 1);
    total += bytes.length;
    if (bytes.length > maxBlob || total > maxTreeBytes || bytes.includes(0)) throw Error();
    decoder.decode(bytes);
    if (
      hash('sha1', Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])) !== blobSha ||
      hash('sha256', bytes) !== expected.sha256
    )
      throw Error();
    result.push({ path: name, mode, blobSha, sha256: expected.sha256, bytes });
  }
  result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (new Set(result.map((entry) => entry.path)).size !== names.length) throw Error();
  return result;
}

async function observeRelease(input) {
  let tree;
  try {
    tree = observeTree(input);
  } catch {
    return { ok: false, code: 'tree' };
  }
  const checked = [];
  try {
    if (
      !Array.isArray(input.artifacts) ||
      input.artifacts.length !== 3 ||
      typeof input.verifyPublisher !== 'function'
    )
      throw Error();
    const names = new Set();
    for (const item of input.artifacts) {
      if (
        !item ||
        typeof item.name !== 'string' ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(item.name) ||
        names.has(item.name) ||
        !sha256.test(item.sha256)
      )
        throw Error();
      names.add(item.name);
      const bytes = await readBounded(item.archivePath, maxArchive);
      const signature = await readBounded(item.signaturePath, 1024 * 1024);
      if (hash('sha256', bytes) !== item.sha256) throw Error();
      checked.push({ name: item.name, bytes, signature });
    }
  } catch {
    return { ok: false, code: 'artifact' };
  }
  for (const item of checked) {
    try {
      if (
        (await input.verifyPublisher({
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
    const root = await fs.lstat(input.stagingRoot);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      root.uid !== process.getuid() ||
      root.mode & 0o077
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

module.exports = { observeRelease };
