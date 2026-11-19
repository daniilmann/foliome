'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { DatabaseSync, backup } = require('node:sqlite');
const { pathToFileURL } = require('node:url');

const systemRoot = '/Library/Application Support/Foliome';
const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const maxFile = 128 * 1024 * 1024;
// The signed runtime is verified during installation and is larger than a release source file.
const maxRuntime = 512 * 1024 * 1024;
const maxInventory = 1024 * 1024;
const maxDatabase = 1024 * 1024 * 1024;
const checkTimeout = 10000;

function absolute(p) {
  return (
    typeof p === 'string' && path.isAbsolute(p) && path.normalize(p) === p && !p.includes('\0')
  );
}
async function directory(p, uid, privateDir = true) {
  const s = await fs.lstat(p);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== uid ||
    (s.mode & (privateDir ? 0o077 : 0o022)) !== 0 ||
    (s.mode & 0o7000) !== 0
  )
    throw Error('directory');
}
async function openFile(p, uid, limit, privateFile = true) {
  const h = await fs.open(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = await h.stat();
    const current = await fs.lstat(p);
    if (
      !s.isFile() ||
      s.nlink !== 1 ||
      s.uid !== uid ||
      s.size > limit ||
      (s.mode & (privateFile ? 0o077 : 0o022)) !== 0 ||
      (s.mode & 0o7000) !== 0 ||
      s.dev !== current.dev ||
      s.ino !== current.ino ||
      !current.isFile()
    )
      throw Error('file');
    return { h, s };
  } catch (error) {
    await h.close();
    throw error;
  }
}
async function bytes(p, uid, limit) {
  const { h, s } = await openFile(p, uid, limit);
  try {
    const buffer = Buffer.alloc(s.size + 1);
    let n = 0;
    while (n < buffer.length) {
      const result = await h.read(buffer, n, buffer.length - n, n);
      if (!result.bytesRead) break;
      n += result.bytesRead;
    }
    if (n !== s.size) throw Error('size');
    return buffer.subarray(0, n);
  } finally {
    await h.close();
  }
}
async function verifyInventory(release, record, sha, uid) {
  const value = JSON.parse((await bytes(record, uid, maxInventory)).toString('utf8'));
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'files,sha' ||
    value.sha !== sha ||
    !value.files ||
    typeof value.files !== 'object' ||
    Array.isArray(value.files)
  )
    throw Error('inventory');
  const names = Object.keys(value.files);
  if (!names.length || names.length > 10000 || !names.includes('core/system-entrypoint.ts'))
    throw Error('inventory');
  const directories = new Set();
  for (const name of names) {
    const parts = name.split('/');
    if (
      name.length > 1024 ||
      !/^[A-Za-z0-9_@.+/-]+$/.test(name) ||
      parts.length > 64 ||
      parts.some((part) => !part || part === '.' || part === '..') ||
      typeof value.files[name] !== 'string' ||
      !digestPattern.test(value.files[name])
    )
      throw Error('inventory');
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
  }
  const remaining = new Set(names);
  const deadline = performance.now() + checkTimeout;
  let entries = 0;
  let total = 0;
  async function visit(dir, prefix) {
    await directory(dir, uid);
    for await (const { name } of await fs.opendir(dir)) {
      if (++entries > 20000 || performance.now() > deadline) throw Error('inventory');
      const relative = prefix ? `${prefix}/${name}` : name;
      const file = path.join(dir, name);
      const stat = await fs.lstat(file);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        if (!directories.has(relative)) throw Error('inventory');
        await visit(file, relative);
      } else {
        if (!remaining.delete(relative)) throw Error('inventory');
        total += stat.size;
        if (total > 1024 * 1024 * 1024) throw Error('inventory');
        const content = await bytes(file, uid, maxFile);
        if (createHash('sha256').update(content).digest('hex') !== value.files[relative])
          throw Error('digest');
      }
    }
  }
  await visit(release, '');
  if (remaining.size || performance.now() > deadline) throw Error('inventory');
}
async function installedPaths(home, root) {
  const uid = process.getuid?.();
  if (!uid || process.geteuid?.() !== uid || !absolute(home) || !absolute(root))
    throw Error('boundary');
  const userRoot = path.join(home, 'Library/Application Support/Foliome');
  const data = path.join(userRoot, 'data');
  const app = path.join(userRoot, 'app');
  const releases = path.join(app, 'releases');
  const accepted = path.join(data, 'accepted');
  const tmpdir = path.join(data, 'tmp');
  await directory(home, uid);
  for (const dir of [path.join(home, 'Library'), path.join(home, 'Library/Application Support')])
    await directory(dir, uid, false);
  for (const dir of [userRoot, data, app, releases, accepted]) await directory(dir, uid);
  const base = path.join(root, 'base');
  const node = path.join(base, 'node');
  const systemUid = root === systemRoot ? 0 : uid;
  for (const dir of [root, base]) await directory(dir, systemUid, root !== systemRoot);
  const nodeFile = await openFile(node, systemUid, maxRuntime, root !== systemRoot);
  try {
    if ((nodeFile.s.mode & 0o111) === 0) throw Error('node');
  } finally {
    await nodeFile.h.close();
  }
  return { uid, data, releases, accepted, tmpdir, node, dbPath: path.join(data, 'core.db') };
}

function releaseArgs(home, tmpdir, node, release) {
  return [
    '-i',
    `HOME=${home}`,
    'PATH=/usr/bin:/bin:/usr/sbin:/sbin',
    `TMPDIR=${tmpdir}`,
    node,
    '--disable-sigusr1',
    path.join(release, 'core/system-entrypoint.ts'),
  ];
}

async function launchAcceptedRelease({ home, systemRoot: root, run }) {
  if (typeof run !== 'function') throw Error('boundary');
  const { uid, data, releases, accepted, tmpdir, node, dbPath } = await installedPaths(home, root);
  await directory(tmpdir, uid);
  const { exclusive, marker } = require('./activation-state.js');
  await exclusive(path.join(data, 'activation.json'), async () => {
    const file = await openFile(dbPath, uid, Number.MAX_SAFE_INTEGER);
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      let state;
      try {
        const now = await fs.lstat(dbPath);
        if (now.dev !== file.s.dev || now.ino !== file.s.ino || !now.isFile())
          throw Error('database');
        state = marker(db);
      } finally {
        db.close();
      }
      if (!state || !shaPattern.test(state.current)) throw Error('state');
      const release = path.join(releases, state.current);
      await verifyInventory(
        release,
        path.join(accepted, `${state.current}.json`),
        state.current,
        uid,
      );
      await run('/usr/bin/env', releaseArgs(home, tmpdir, node, release), {
        stdio: 'ignore',
        env: {},
      });
    } finally {
      await file.h.close();
    }
  });
}

async function optionalDatabaseFile(file, uid) {
  try {
    const { h, s } = await openFile(file, uid, maxDatabase);
    await h.close();
    if ((s.mode & 0o7777) !== 0o600) throw Error('copy');
    return s;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function sameFile(first, second) {
  return first?.dev === second?.dev && first?.ino === second?.ino;
}

async function snapshotDatabase(dbPath, copy, uid) {
  const live = await optionalDatabaseFile(dbPath, uid);
  const wal = await optionalDatabaseFile(`${dbPath}-wal`, uid);
  const shm = await optionalDatabaseFile(`${dbPath}-shm`, uid);
  if (!live || !!wal !== !!shm || (await optionalDatabaseFile(`${dbPath}-journal`, uid)))
    throw Error('copy');
  const dest = await fs.open(copy, 'wx', 0o600);
  await dest.close();
  const source = pathToFileURL(dbPath);
  // Without WAL sidecars, a normal read-only open can create them on a closed WAL store.
  if (!wal) source.searchParams.set('immutable', '1');
  const db = new DatabaseSync(source, { readOnly: true, defensive: true });
  try {
    // Pin a SQLite read transaction before backup. The WAL can contain committed pages.
    db.exec('BEGIN');
    const pageSize = db.prepare('PRAGMA page_size').get().page_size;
    const pageCount = db.prepare('PRAGMA page_count').get().page_count;
    if (pageSize * pageCount > maxDatabase) throw Error('copy');
    const deadline = performance.now() + checkTimeout;
    await backup(db, copy, {
      progress({ totalPages }) {
        if (totalPages * pageSize > maxDatabase || performance.now() > deadline)
          throw Error('copy');
      },
    });
    const current = await optionalDatabaseFile(dbPath, uid);
    if (
      performance.now() > deadline ||
      !sameFile(live, current) ||
      (!wal &&
        (live.size !== current.size ||
          live.mtimeMs !== current.mtimeMs ||
          live.ctimeMs !== current.ctimeMs)) ||
      !sameFile(wal, await optionalDatabaseFile(`${dbPath}-wal`, uid)) ||
      !sameFile(shm, await optionalDatabaseFile(`${dbPath}-shm`, uid)) ||
      (await optionalDatabaseFile(`${dbPath}-journal`, uid))
    )
      throw Error('copy');
    const snapshot = await optionalDatabaseFile(copy, uid);
    if (!snapshot || sameFile(live, snapshot)) throw Error('copy');
  } finally {
    db.close();
  }
}

async function runSelfCheck(args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/env', args, {
      cwd,
      env: {},
      stdio: 'ignore',
      timeout: checkTimeout,
      killSignal: 'SIGKILL',
    });
    child.once('error', () => reject(Error('self-check')));
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(Error(signal === 'SIGKILL' ? 'self-check-timeout' : 'self-check'));
    });
  });
}

async function preflightAcceptedRelease({ home, systemRoot: root, sha, accept }) {
  if (typeof sha !== 'string' || !shaPattern.test(sha) || typeof accept !== 'function')
    throw Error('boundary');
  const { uid, releases, accepted, node, dbPath } = await installedPaths(home, root);
  if (releases !== (await fs.realpath(releases)) || dbPath !== (await fs.realpath(dbPath)))
    throw Error('boundary');
  // The caller supplies the owner decision for this exact staged SHA.
  if ((await accept(sha)) !== true) throw Error('acceptance');
  const release = path.join(releases, sha);
  try {
    await verifyInventory(release, path.join(accepted, `${sha}.json`), sha, uid);
  } catch {
    throw Error('receipt');
  }
  const scratch = path.join(releases, `${sha}.check`);
  const data = path.join(scratch, 'data');
  try {
    await fs.mkdir(scratch, { mode: 0o700 });
  } catch {
    throw Error('copy');
  }
  try {
    try {
      await fs.mkdir(data, { mode: 0o700 });
      await snapshotDatabase(dbPath, path.join(data, 'core.db'), uid);
    } catch {
      throw Error('copy');
    }
    await runSelfCheck([...releaseArgs(home, data, node, release), '--self-check'], release);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

module.exports = { launchAcceptedRelease, preflightAcceptedRelease, verifyInventory };

if (require.main === module) {
  void (async () => {
    const argv = process.argv.slice(2);
    const preflight =
      argv.length === 2 && argv[0] === '--accept-preflight' && shaPattern.test(argv[1]);
    if (
      (argv.length && !preflight) ||
      process.platform !== 'darwin' ||
      __filename !== path.join(systemRoot, 'base/launcher.js') ||
      process.execPath !== path.join(systemRoot, 'base/node')
    )
      throw Error('boundary');
    for (const dir of [
      '/Library',
      '/Library/Application Support',
      systemRoot,
      path.join(systemRoot, 'base'),
    ])
      await directory(dir, 0, false);
    for (const file of [
      __filename,
      path.join(systemRoot, 'base/activation-state.js'),
      process.execPath,
    ]) {
      const opened = await openFile(
        file,
        0,
        file === process.execPath ? maxRuntime : maxFile,
        false,
      );
      await opened.h.close();
    }
    process.umask(0o077);
    const home = os.userInfo().homedir;
    if (preflight) {
      try {
        await preflightAcceptedRelease({
          home,
          systemRoot,
          sha: argv[1],
          accept: (sha) => sha === argv[1],
        });
      } catch (error) {
        const codes = ['acceptance', 'receipt', 'copy', 'self-check', 'self-check-timeout'];
        process.stderr.write(`${codes.includes(error.message) ? error.message : 'boundary'}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write('ok\n');
      return;
    }
    await launchAcceptedRelease({
      home,
      systemRoot,
      run: (command, args, options) =>
        new Promise((resolve, reject) => {
          const child = spawn(command, args, options);
          child.once('error', reject);
          child.once('spawn', () => {
            child.unref();
            resolve();
          });
        }),
    });
  })().catch(() => {
    process.exitCode = 1;
  });
}
