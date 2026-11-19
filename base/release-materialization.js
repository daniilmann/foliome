'use strict';

const { createHash } = require('node:crypto');
const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { crc32, inflateRawSync } = require('node:zlib');

// Envelope limits measured on the approved playwright-core archive.
const maxArchive = 3_172_161;
const maxTar = 13_746_688;
const maxPackageFile = 3_585_406;
const maxPackageFiles = 115;
// Same source budget as release observation.
const maxSourceFile = 8 * 1024 * 1024;
const maxSourceBytes = 64 * 1024 * 1024;
const maxSourceFiles = 2000;
const sha1 = /^[a-f0-9]{40}$/;
const sha256 = /^[a-f0-9]{64}$/;
const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const dependency = 'playwright-core';
const packageDir = `node_modules/${dependency}`;
const artifactDir = '.release-artifacts';
const dependencyFields = [
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'bundledDependencies',
  'bundleDependencies',
];
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

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const allZero = (bytes) => bytes.every((byte) => byte === 0);
const privateMode = (mode) => (mode === '100755' ? 0o700 : 0o600);
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

function validPath(name) {
  if (typeof name !== 'string' || name.length > 1024) return false;
  const parts = name.split('/');
  const foldedName = name.toLowerCase();
  return (
    parts[0].toLowerCase() !== artifactDir &&
    foldedName !== 'binding.gyp' &&
    !foldedName.endsWith('.node') &&
    parts.every(
      (part) =>
        part.length <= 255 &&
        /^[A-Za-z0-9._-]+$/.test(part) &&
        !['.', '..', '.git', '.gitmodules', 'node_modules'].includes(part.toLowerCase()),
    )
  );
}

function recordPath(index, name) {
  for (let end = name.indexOf('/'); end !== -1; end = name.indexOf('/', end + 1)) {
    const directory = name.slice(0, end);
    const folded = directory.toLowerCase();
    const previous = index.get(folded);
    if (previous !== undefined && previous !== `${directory}/`) throw Error();
    index.set(folded, `${directory}/`);
  }
  const folded = name.toLowerCase();
  if (index.has(folded)) throw Error();
  index.set(folded, name);
}

function sourceInventory(tree) {
  if (!Array.isArray(tree) || !tree.length || tree.length > maxSourceFiles) throw Error();
  const paths = new Map();
  return tree.map(({ path: name, mode, blobSha, sha256: hash }) => {
    if (
      !validPath(name) ||
      (mode !== '100644' && !(mode === '100755' && name === 'scripts/telegram-agent.sh')) ||
      typeof blobSha !== 'string' ||
      !sha1.test(blobSha) ||
      typeof hash !== 'string' ||
      !sha256.test(hash)
    )
      throw Error();
    recordPath(paths, name);
    return { path: name, mode, blobSha, sha256: hash };
  });
}

async function privateDirectory(directory, owner) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.uid !== owner || (stat.mode & 0o7777) !== 0o700) throw Error();
  return stat;
}

async function privateRoot(directory, owner) {
  if (
    typeof directory !== 'string' ||
    !path.isAbsolute(directory) ||
    path.resolve(directory) !== directory
  )
    throw Error();
  // Darwin's system temporary paths use these root-owned aliases.
  const canonical =
    process.platform === 'darwin' && /^\/(?:tmp|var)\//.test(directory)
      ? `/private${directory}`
      : directory;
  const root = await privateDirectory(canonical, owner);
  if ((await fs.realpath(directory)) !== canonical) throw Error();
  for (let parent = path.dirname(canonical); ; parent = path.dirname(parent)) {
    const stat = await fs.lstat(parent);
    if (
      !stat.isDirectory() ||
      (stat.uid !== 0 && stat.uid !== owner) ||
      ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)
    )
      throw Error();
    if (parent === path.dirname(parent)) break;
  }
  return { directory: canonical, stat: root };
}

async function readPrivateFile(root, name, owner, limit, mode) {
  const parts = name.split('/');
  const leaf = parts.pop();
  const parents = [root];
  for (const part of parts) {
    const directory = path.join(parents.at(-1).directory, part);
    parents.push({ directory, stat: await privateDirectory(directory, owner) });
  }
  const file = path.join(parents.at(-1).directory, leaf);
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const allowed = (stat) =>
    stat.isFile() &&
    stat.uid === owner &&
    stat.nlink === 1 &&
    stat.size <= limit &&
    (stat.mode & 0o7777) === mode;
  try {
    const stat = await handle.stat();
    if (!allowed(stat)) throw Error();
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const current = await fs.lstat(file);
    if (
      offset !== stat.size ||
      offset !== current.size ||
      !allowed(current) ||
      !sameFile(stat, current)
    )
      throw Error();
    for (const { directory, stat } of parents) {
      if (!sameFile(stat, await privateDirectory(directory, owner))) throw Error();
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function octal(field, emptyIsZero = false) {
  if (emptyIsZero && allZero(field)) return 0;
  const value = /^ *([0-7]+)[ \0]+$/.exec(field.toString('latin1'));
  if (!value) throw Error();
  return Number.parseInt(value[1], 8);
}

function tarString(field) {
  const end = field.indexOf(0);
  if (end !== -1 && !allZero(field.subarray(end))) throw Error();
  const value = field.toString('latin1', 0, end === -1 ? field.length : end);
  if (!/^[ -~]*$/.test(value)) throw Error();
  return value;
}

function unpackGzip(archive) {
  // The accepted envelope is one gzip member with no optional header fields.
  if (archive.length <= 18 || archive.readUInt32BE(0) !== 0x1f8b0800) throw Error();
  const trailer = archive.length - 8;
  const deflate = archive.subarray(10, trailer);
  const { buffer, engine } = inflateRawSync(deflate, { maxOutputLength: maxTar, info: true });
  if (
    engine.bytesWritten !== deflate.length ||
    buffer.length !== archive.readUInt32LE(trailer + 4) ||
    crc32(buffer) !== archive.readUInt32LE(trailer)
  )
    throw Error();
  return buffer;
}

function unpackHeader(header) {
  if (
    header[156] !== 0x30 ||
    !allZero(header.subarray(157, 257)) ||
    header.toString('latin1', 257, 265) !== 'ustar\0' + '00' ||
    !allZero(header.subarray(500))
  )
    throw Error();
  let checksum = 8 * 0x20;
  for (let i = 0; i < header.length; i++) if (i < 148 || i >= 156) checksum += header[i];
  if (octal(header.subarray(148, 156)) !== checksum) throw Error();
  const mode = octal(header.subarray(100, 108));
  if (mode !== 0o644 && mode !== 0o755) throw Error();
  octal(header.subarray(108, 116), true); // uid
  octal(header.subarray(116, 124), true); // gid
  octal(header.subarray(136, 148)); // mtime
  tarString(header.subarray(265, 297)); // uname
  tarString(header.subarray(297, 329)); // gname
  if (octal(header.subarray(329, 337), true) || octal(header.subarray(337, 345), true))
    throw Error();
  const prefix = tarString(header.subarray(345, 500));
  const basename = tarString(header.subarray(0, 100));
  const full = prefix ? `${prefix}/${basename}` : basename;
  const name = full.slice('package/'.length);
  const size = octal(header.subarray(124, 136));
  if (!full.startsWith('package/') || !validPath(name) || size > maxPackageFile) throw Error();
  return { name, size, mode: mode === 0o644 ? '100644' : '100755' };
}

function unpackPackage(archive, pins) {
  const tar = unpackGzip(archive);
  const end = tar.length - 1024;
  if (end < 512 || end % 512 !== 0 || !allZero(tar.subarray(end))) throw Error();
  if (pins !== undefined && (!isRecord(pins) || Object.keys(pins).length > maxPackageFiles))
    throw Error();
  const paths = new Map();
  const files = new Map();
  for (let offset = 0; offset < end;) {
    if (files.size === maxPackageFiles) throw Error();
    const start = offset + 512;
    const { name, size, mode } = unpackHeader(tar.subarray(offset, start));
    recordPath(paths, name);
    offset = start + Math.ceil(size / 512) * 512;
    if (offset > end || !allZero(tar.subarray(start + size, offset))) throw Error();
    const bytes = tar.subarray(start, start + size);
    const hash = digest(bytes);
    if (
      pins !== undefined &&
      (!Object.hasOwn(pins, name) || pins[name]?.mode !== mode || pins[name]?.sha256 !== hash)
    )
      throw Error();
    files.set(name, { mode, sha256: hash, bytes });
  }
  if (pins !== undefined && Object.keys(pins).length !== files.size) throw Error();
  return files;
}

function packageMetadata(bytes) {
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (
    !isRecord(value) ||
    (value.hasInstallScript !== undefined && value.hasInstallScript !== false) ||
    (value.scripts !== undefined &&
      (!isRecord(value.scripts) || installHooks.some((key) => Object.hasOwn(value.scripts, key))))
  )
    throw Error();
  return value;
}

function verifyPackages(source, installed, releaseVersion) {
  const root = packageMetadata(source);
  const pkg = packageMetadata(installed);
  if (
    root.version !== releaseVersion ||
    !isRecord(root.dependencies) ||
    Object.keys(root.dependencies).length !== 1 ||
    !Object.hasOwn(root.dependencies, dependency) ||
    ['workspaces', 'overrides', ...dependencyFields].some((key) => Object.hasOwn(root, key)) ||
    pkg.name !== dependency ||
    typeof pkg.version !== 'string' ||
    !version.test(pkg.version) ||
    root.dependencies[dependency] !== pkg.version ||
    ['dependencies', ...dependencyFields].some(
      (key) =>
        Object.hasOwn(pkg, key) && (!isRecord(pkg[key]) || Object.keys(pkg[key]).length !== 0),
    )
  )
    throw Error();
}

async function writePrivateFile(directory, name, bytes, mode, directories) {
  for (let end = name.indexOf('/'); end !== -1; end = name.indexOf('/', end + 1)) {
    const parent = name.slice(0, end);
    if (directories.has(parent)) continue;
    const target = path.join(directory, parent);
    await fs.mkdir(target, { mode: 0o700 });
    await fs.chmod(target, 0o700);
    directories.add(parent);
  }
  const file = await fs.open(
    path.join(directory, name),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    privateMode(mode),
  );
  try {
    await file.chmod(privateMode(mode));
    await file.writeFile(bytes);
  } finally {
    await file.close();
  }
}

async function requireAbsent(file) {
  try {
    await fs.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw Error();
}

// Consumes a trusted stage from release-pipeline. Approval identifies exactly which
// stage may be composed. Launcher receipts and activation are owned by the caller.
async function materializeRelease(input) {
  let scratch;
  try {
    const { stage, approval, releasesRoot } = input;
    const owner = process.getuid?.();
    if (!owner || process.geteuid?.() !== owner || stage?.ok !== true) throw Error();
    const { sha, version: releaseVersion, tree, stagingDir, archive } = stage;
    if (
      typeof sha !== 'string' ||
      !sha1.test(sha) ||
      approval !== sha ||
      typeof releaseVersion !== 'string' ||
      !version.test(releaseVersion) ||
      !isRecord(archive)
    )
      throw Error();
    const { sha256: archiveHash, integrity, files: pins } = archive;
    const sources = sourceInventory(tree);
    const sourceRoot = await privateRoot(stagingDir, owner);
    const releases = await privateRoot(releasesRoot, owner);
    const sourceKey = `${sourceRoot.directory.toLowerCase()}/`;
    const releasesKey = `${releases.directory.toLowerCase()}/`;
    if (sourceKey.startsWith(releasesKey) || releasesKey.startsWith(sourceKey)) throw Error();
    const destination = path.join(releases.directory, sha);
    await requireAbsent(destination);

    const packed = await readPrivateFile(
      sourceRoot,
      `${artifactDir}/playwrightCore`,
      owner,
      maxArchive,
      0o600,
    );
    if (
      digest(packed) !== archiveHash ||
      `sha512-${createHash('sha512').update(packed).digest('base64')}` !== integrity
    )
      throw Error();
    const packageFiles = unpackPackage(packed, pins);
    const packageJson = packageFiles.get('package.json');
    if (!packageJson || !sources.some(({ path: name }) => name === 'package.json')) throw Error();

    scratch = await fs.mkdtemp(path.join(releases.directory, '.materialize-'));
    await fs.chmod(scratch, 0o700);
    const directories = new Set();
    const inventory = [];
    let total = 0;
    for (const { path: name, mode, blobSha, sha256: expected } of sources) {
      const bytes = await readPrivateFile(
        sourceRoot,
        name,
        owner,
        maxSourceFile,
        privateMode(mode),
      );
      total += bytes.length;
      const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if (total > maxSourceBytes || blob !== blobSha || digest(bytes) !== expected) throw Error();
      if (name === 'package.json') verifyPackages(bytes, packageJson.bytes, releaseVersion);
      await writePrivateFile(scratch, name, bytes, mode, directories);
      inventory.push({ path: name, mode, sha256: expected });
    }
    for (const [name, { bytes, mode, sha256 }] of packageFiles) {
      const installed = `${packageDir}/${name}`;
      await writePrivateFile(scratch, installed, bytes, mode, directories);
      inventory.push({ path: installed, mode, sha256 });
    }
    inventory.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    if (!sameFile(releases.stat, await privateDirectory(releases.directory, owner))) throw Error();
    await requireAbsent(destination);
    // A competing materializer can only publish a nonempty tree at this destination.
    await fs.rename(scratch, destination);
    return { ok: true, sha, releaseDir: path.join(releasesRoot, sha), inventory };
  } catch {
    if (scratch) await fs.rm(scratch, { recursive: true, force: true, maxRetries: 3 });
    return { ok: false };
  }
}

// Projection of a successful materialization to the launcher's accepted-file format.
function releaseReceipt({ sha, inventory }) {
  return { sha, files: Object.fromEntries(inventory.map(({ path, sha256 }) => [path, sha256])) };
}

module.exports = { materializeRelease, releaseReceipt };
