'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const systemRoot = '/Library/Application Support/Foliome';
const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const maxFile = 128 * 1024 * 1024;
const maxInventory = 1024 * 1024;

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
  const h = await fs.open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
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
  for (const name of names) {
    if (
      name.length > 1024 ||
      !/^[A-Za-z0-9_@.+/-]+$/.test(name) ||
      name.split('/').some((part) => !part || part === '.' || part === '..') ||
      typeof value.files[name] !== 'string' ||
      !digestPattern.test(value.files[name])
    )
      throw Error('inventory');
  }
  const remaining = new Set(names);
  let entries = 0;
  let total = 0;
  async function visit(dir, prefix) {
    if (prefix.split('/').length > 64) throw Error('inventory');
    await directory(dir, uid);
    for (const name of await fs.readdir(dir)) {
      if (++entries > 20000) throw Error('inventory');
      const relative = prefix ? `${prefix}/${name}` : name;
      const file = path.join(dir, name);
      const stat = await fs.lstat(file);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        if (!names.some((entry) => entry.startsWith(`${relative}/`))) throw Error('inventory');
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
  if (remaining.size) throw Error('inventory');
}
async function launchAcceptedRelease({ home, systemRoot: root, run }) {
  const uid = process.getuid?.();
  if (
    !uid ||
    process.geteuid?.() !== uid ||
    !absolute(home) ||
    !absolute(root) ||
    typeof run !== 'function'
  )
    throw Error('boundary');
  const userRoot = path.join(home, 'Library/Application Support/Foliome');
  const data = path.join(userRoot, 'data');
  const app = path.join(userRoot, 'app');
  const releases = path.join(app, 'releases');
  const accepted = path.join(data, 'accepted');
  const tmpdir = path.join(data, 'tmp');
  for (const dir of [
    home,
    path.join(home, 'Library'),
    path.join(home, 'Library/Application Support'),
  ])
    await directory(dir, uid, false);
  for (const dir of [userRoot, data, app, releases, accepted, tmpdir]) await directory(dir, uid);
  const base = path.join(root, 'base');
  const node = path.join(base, 'node');
  const systemUid = root === systemRoot ? 0 : uid;
  for (const dir of [root, base]) await directory(dir, systemUid, root !== systemRoot);
  const nodeFile = await openFile(node, systemUid, maxFile, root !== systemRoot);
  try {
    if ((nodeFile.s.mode & 0o111) === 0) throw Error('node');
  } finally {
    await nodeFile.h.close();
  }
  const dbPath = path.join(data, 'core.db');
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
      await run(
        '/usr/bin/env',
        [
          '-i',
          `HOME=${home}`,
          'PATH=/usr/bin:/bin:/usr/sbin:/sbin',
          `TMPDIR=${tmpdir}`,
          node,
          '--disable-sigusr1',
          path.join(release, 'core/system-entrypoint.ts'),
        ],
        { stdio: 'ignore', env: {} },
      );
    } finally {
      await file.h.close();
    }
  });
}
module.exports = { launchAcceptedRelease };

if (require.main === module) {
  void (async () => {
    if (
      process.argv.length !== 2 ||
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
      const opened = await openFile(file, 0, maxFile, false);
      await opened.h.close();
    }
    await launchAcceptedRelease({
      home: os.userInfo().homedir,
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
