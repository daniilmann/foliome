'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

async function stat(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

const identity = (s) => (s ? [s.dev, s.ino] : null);
const same = (s, id) => s && id && s.dev === id[0] && s.ino === id[1];

async function syncDirectory(dir) {
  const handle = await fs.open(
    dir,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writePrivate(file, bytes) {
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// The caller authorizes every destination and checks its ancestors before each use.
// Backup and replacement are siblings so renames preserve metadata and work across volumes.
function installationJournal(directory, authorize, swapDirectories) {
  const record = path.join(directory, 'pending.json');
  const next = path.join(directory, 'pending.next');
  const siblings = (operation) => {
    const parent = path.dirname(operation.target);
    const prefix = path.join(parent, '.foliome-install-' + operation.token);
    return { parent, staged: prefix + '.new', backup: prefix + '.old' };
  };

  async function save(value) {
    await fs.rm(next, { force: true });
    await writePrivate(next, JSON.stringify(value));
    await fs.rename(next, record);
    await syncDirectory(directory);
  }

  async function settle(value, restoreExternal) {
    for (const operation of [...value.operations].reverse()) {
      const { target, before, after, directory: isDirectory, tree } = operation;
      await authorize(target);
      const { parent, staged, backup } = siblings(operation);
      const old = await stat(backup);
      const pending = await stat(staged);
      const installed = await stat(target);
      if (operation.atomic) {
        // The sibling changes roles at the swap. Its inode identifies which
        // side of the swap we reached, even if the journal was never rewritten.
        if (
          !swapDirectories ||
          old ||
          !installed?.isDirectory() ||
          installed.uid !== process.getuid() ||
          (pending && (!pending.isDirectory() || pending.uid !== process.getuid()))
        )
          throw Error('restore-failed');
        if (value.committed) {
          if (!same(installed, after) || (pending && !same(pending, before)))
            throw Error('restore-failed');
        } else if (same(installed, after)) {
          if (!same(pending, before)) throw Error('restore-failed');
          await swapDirectories(target, staged);
        } else if (!same(installed, before) || (pending && after && !same(pending, after))) {
          throw Error('restore-failed');
        }
        if (pending) await fs.rm(staged, { recursive: true });
        await syncDirectory(parent);
        continue;
      }
      if ((old && !same(old, before)) || (pending && after && !same(pending, after)))
        throw Error('restore-failed');
      if (value.committed) {
        if (!same(installed, after)) throw Error('restore-failed');
        if (old) {
          if (tree) await fs.rm(backup, { recursive: true });
          else await fs.unlink(backup);
        }
      } else if (old) {
        if (installed && !same(installed, after)) throw Error('restore-failed');
        if (tree && installed) {
          if (pending) throw Error('restore-failed');
          await fs.rename(target, staged);
        }
        await fs.rename(backup, target);
      } else if (same(installed, after)) {
        if (before) throw Error('restore-failed');
        if (isDirectory) await fs.rmdir(target);
        else await fs.unlink(target);
      } else if (before ? !same(installed, before) : installed) {
        throw Error('restore-failed');
      }
      if (pending || (tree && !value.committed && old && installed)) {
        if (tree) await fs.rm(staged, { recursive: true });
        else if (isDirectory) await fs.rmdir(staged);
        else await fs.unlink(staged);
      }
      await syncDirectory(parent);
    }
    if (!value.committed && value.external !== null) await restoreExternal(value.external);
    await fs.unlink(record);
    await syncDirectory(directory);
  }

  async function recover(restoreExternal, selectActivation) {
    const s = await stat(record);
    if (!s) return;
    if (
      !s.isFile() ||
      s.nlink !== 1 ||
      s.uid !== process.getuid() ||
      (s.mode & 0o7777) !== 0o600 ||
      s.size > 1024 * 1024
    )
      throw Error('restore-failed');
    const value = JSON.parse(await fs.readFile(record, 'utf8'));
    if (
      !Array.isArray(value.operations) ||
      typeof value.committed !== 'boolean' ||
      value.operations.some(
        (op) =>
          typeof op.target !== 'string' ||
          !/^[a-f0-9]{32}$/.test(op.token) ||
          typeof op.directory !== 'boolean' ||
          (op.atomic !== undefined && (op.atomic !== true || !op.tree || !op.before)) ||
          (op.tree !== undefined && (op.tree !== true || !op.directory)),
      )
    )
      throw Error('restore-failed');
    if (value.activation !== undefined) {
      if (!selectActivation) throw Error('restore-failed');
      const committed = await selectActivation(value.activation);
      if (typeof committed !== 'boolean') throw Error('restore-failed');
      value.committed = committed;
    }
    await settle(value, restoreExternal);
  }

  async function begin(activation) {
    if (await stat(record)) throw Error('restore-failed');
    const value = { operations: [], committed: false, external: null, activation };
    await save(value);
    return {
      async replace(target, prepare, validate, isDirectory = false, tree = false) {
        await authorize(target);
        const before = await stat(target);
        await validate(before);
        const atomic = tree && typeof swapDirectories === 'function';
        if (atomic && !before?.isDirectory()) throw Error('install-files');
        const operation = {
          target,
          token: randomBytes(16).toString('hex'),
          before: identity(before),
          after: null,
          directory: isDirectory,
          ...(tree && { tree }),
          ...(atomic && { atomic }),
        };
        value.operations.push(operation);
        await save(value);
        const { parent, staged, backup } = siblings(operation);
        await prepare(staged);
        const prepared = await fs.lstat(staged);
        if (
          atomic &&
          (!prepared.isDirectory() ||
            prepared.uid !== before.uid ||
            prepared.gid !== before.gid ||
            prepared.mode !== before.mode ||
            prepared.dev !== before.dev)
        )
          throw Error('install-files');
        operation.after = identity(prepared);
        await syncDirectory(parent);
        await save(value);
        const current = await stat(target);
        if (before ? !same(current, operation.before) : current) throw Error('install-files');
        if (atomic) await swapDirectories(target, staged);
        else {
          if (before) await fs.rename(target, backup);
          await fs.rename(staged, target);
        }
        await syncDirectory(parent);
      },
      async external(snapshot) {
        if (value.external !== null) throw Error('install-files');
        value.external = snapshot;
        await save(value);
      },
      async commit() {
        value.committed = true;
        await save(value);
      },
    };
  }

  return { begin, recover };
}

module.exports = { installationJournal, stat, syncDirectory };
