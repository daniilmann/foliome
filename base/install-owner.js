'use strict';

// This fixed entry runs after dropping to the verified console UID. It owns only
// the inert application tree and the first SQLite marker.
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { deserialize } = require('node:v8');
const { DatabaseSync } = require('node:sqlite');
const { pathToFileURL } = require('node:url');
const {
  exclusive,
  initialDatabasePaths,
  marker,
  sameSelection,
  commitActivation,
} = require('./activation-state.js');
const { preflightAcceptedRelease, verifyInventory } = require('./launcher.js');
const { installationJournal, stat, syncDirectory } = require('./install-transaction.js');
const { readInstallationRelease } = require('./installation-release.js');
const { requireAcl } = require('./install-platform.js');

const root = '/Library/Application Support/Foliome';
const shaPattern = /^[a-f0-9]{40}$/;
const sha256 = /^[a-f0-9]{64}$/;
const maxPayload = 96 * 1024 * 1024;
const uid = process.getuid();
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function requireDir(dir, mode = 0o700) {
  const s = await fs.lstat(dir);
  if (!s.isDirectory() || s.uid !== uid || (s.mode & 0o7777) !== mode) throw Error('owner-path');
}

function ownedFile(s, mode) {
  return s?.isFile() && s.uid === uid && s.nlink === 1 && (s.mode & 0o7777) === mode;
}

async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  await requireDir(dir);
}

async function profileParent(dir, create = false) {
  if (create && !(await stat(dir))) await ensureDir(dir);
  const s = await fs.lstat(dir);
  if (!s.isDirectory() || s.uid !== uid || s.mode & 0o7022) throw Error('owner-path');
}

async function input() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxPayload) throw Error('owner-input');
    chunks.push(chunk);
  }
  return deserialize(Buffer.concat(chunks, size));
}

async function prepare({ sha, data, app, releases }, payload, verifyOnly = false) {
  const { files, settings } = payload;
  if (
    !Array.isArray(files) ||
    !files.length ||
    files.length > 2200 ||
    (settings !== undefined &&
      (!Array.isArray(settings) ||
        settings.length !== 2 ||
        settings.some((value) => typeof value !== 'string' || value.length > 4096)))
  )
    throw Error('owner-input');
  const release = path.join(releases, sha);
  const scratch = path.join(releases, '.install-' + sha);
  const receipt = path.join(data, 'accepted', sha + '.json');
  const ssh = path.join(data, 'ssh_config');
  const hosts = path.join(data, 'known_hosts');
  const hashes = Object.create(null);
  for (const file of files) {
    const parts = file.path.split('/');
    if (
      file.path.length > 1024 ||
      parts.some(
        (part) => !/^[A-Za-z0-9_@.+-]{1,255}$/.test(part) || part === '.' || part === '..',
      ) ||
      ![0o600, 0o700].includes(file.mode) ||
      !sha256.test(file.hash) ||
      !Buffer.isBuffer(file.bytes) ||
      digest(file.bytes) !== file.hash ||
      Object.hasOwn(hashes, file.path)
    )
      throw Error('owner-input');
    hashes[file.path] = file.hash;
  }
  if (!Object.hasOwn(hashes, 'core/system-entrypoint.ts')) throw Error('owner-input');

  const journalDir = path.join(data, 'owner-install');
  await ensureDir(journalDir);
  const journal = installationJournal(journalDir, async (target) => {
    if (
      ![ssh, hosts].includes(target) &&
      !(
        path.dirname(target) === path.join(data, 'accepted') &&
        /^[a-f0-9]{40}\.json$/.test(path.basename(target))
      )
    )
      throw Error('owner-path');
    await requireDir(path.dirname(target));
  });
  if (!verifyOnly) await journal.recover();
  if (await stat(release)) {
    // Only allow the exact privately published bytes on a retry.
    const expected = JSON.stringify({ sha, files: hashes });
    if (
      !ownedFile(await fs.lstat(receipt), 0o600) ||
      (await fs.readFile(receipt, 'utf8')) !== expected
    )
      throw Error('owner-receipt');
    await verifyInventory(release, receipt, sha, uid);
  } else {
    if (verifyOnly) throw Error('owner-receipt');
    const expected = JSON.stringify({ sha, files: hashes });
    const previousReceipt = await stat(receipt);
    if (
      previousReceipt &&
      (!ownedFile(previousReceipt, 0o600) || (await fs.readFile(receipt, 'utf8')) !== expected)
    )
      throw Error('owner-receipt');
    const oldScratch = await stat(scratch);
    if (oldScratch) {
      await requireDir(scratch);
      await fs.rm(scratch, { recursive: true });
    }
    await fs.mkdir(scratch, { mode: 0o700 });
    try {
      for (const file of files) {
        const target = path.join(scratch, file.path);
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.writeFile(target, file.bytes, { flag: 'wx', mode: file.mode });
      }
      await requireDir(app);
      if (!previousReceipt) {
        const transfer = await journal.begin();
        try {
          await transfer.replace(
            receipt,
            (file) => fs.writeFile(file, expected, { flag: 'wx', mode: 0o600 }),
            (s) => {
              if (s) throw Error('owner-receipt');
            },
          );
          await transfer.commit();
        } finally {
          await journal.recover();
        }
      }
      await fs.rename(scratch, release);
      await syncDirectory(releases);
    } finally {
      if (await stat(scratch)) await fs.rm(scratch, { recursive: true });
    }
  }

  if (settings === undefined) {
    if (verifyOnly) throw Error('owner-input');
    return;
  }
  if (verifyOnly) {
    for (const [index, target] of [ssh, hosts].entries()) {
      const existing = await fs.lstat(target);
      if (
        !ownedFile(existing, 0o600) ||
        existing.size > 4096 ||
        (await fs.readFile(target, 'utf8')) !== settings[index]
      )
        throw Error('owner-path');
    }
    return;
  }
  const config = await journal.begin();
  try {
    for (const [target, contents] of [
      [ssh, settings[0]],
      [hosts, settings[1]],
    ]) {
      const existing = await stat(target);
      if (existing) {
        if (
          !ownedFile(existing, 0o600) ||
          existing.size > 4096 ||
          (await fs.readFile(target, 'utf8')) !== contents
        )
          throw Error('owner-path');
        continue;
      }
      await config.replace(
        target,
        (file) => fs.writeFile(file, contents, { flag: 'wx', mode: 0o600 }),
        (s) => {
          if (s) throw Error('owner-path');
        },
      );
    }
    await config.commit();
  } finally {
    await journal.recover();
  }
}

function requireRootParent() {
  if (
    execFileSync('/bin/ps', ['-p', String(process.ppid), '-o', 'uid='], {
      env: {},
      cwd: '/',
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 1024,
    }).trim() !== '0'
  )
    throw Error('owner-authority');
}

async function requireInitialAuthority(sha) {
  requireRootParent();
  const approved = await readInstallationRelease();
  if (approved.sha !== sha || approved.initialSha !== sha || approved.ownerUid !== uid)
    throw Error('owner-authority');
}

async function requireInitialMarker(file, sha) {
  if (!ownedFile(await fs.lstat(file), 0o600)) throw Error('owner-database');
  const wal = await stat(file + '-wal');
  const shm = await stat(file + '-shm');
  if (
    (await stat(file + '-journal')) ||
    !!wal !== !!shm ||
    (wal && (!ownedFile(wal, 0o600) || !ownedFile(shm, 0o600)))
  )
    throw Error('owner-database');
  const source = pathToFileURL(file);
  if (!wal) source.searchParams.set('immutable', '1');
  const db = new DatabaseSync(source, { readOnly: true, defensive: true });
  try {
    const state = marker(db);
    if (state?.current !== sha || state.previous !== null) throw Error('owner-database');
  } finally {
    db.close();
  }
}

async function alreadyActive(live, staging, sha) {
  const active = await stat(live);
  if (!active) return false;
  const pending = await stat(staging);
  if (
    pending &&
    pending.isFile() &&
    pending.uid === uid &&
    pending.nlink === 2 &&
    (pending.mode & 0o7777) === 0o600 &&
    pending.ino === active.ino &&
    pending.dev === active.dev
  )
    await fs.unlink(staging);
  await requireInitialMarker(live, sha);
  return true;
}

async function prepareInitialDatabase({ sha, data, releases }) {
  const { live, staging } = initialDatabasePaths(data, sha);
  if (await alreadyActive(live, staging, sha)) return;
  for (const suffix of ['', '-journal', '-shm', '-wal'])
    if (await stat(live + suffix)) throw Error('owner-database');
  for (const suffix of ['', '-journal', '-shm', '-wal']) {
    const stale = await stat(staging + suffix);
    if (stale) {
      if (!ownedFile(stale, 0o600)) throw Error('owner-database');
      await fs.unlink(staging + suffix);
    }
  }
  const file = await fs.open(staging, 'wx', 0o600);
  await file.close();
  const release = path.join(releases, sha);
  await verifyInventory(release, path.join(data, 'accepted', sha + '.json'), sha, uid);
  const db = new DatabaseSync(staging, { defensive: true });
  try {
    // On first install the accepted release initializes the same schema used by
    // its ordinary entry. This process has the owner's UID and no root groups.
    const { createActionProtocol } = require(
      path.join(release, 'core/adapters/store/action-protocol.ts'),
    );
    const { createTextSnapshotStore } = require(
      path.join(release, 'core/adapters/store/text-snapshot-store.ts'),
    );
    createActionProtocol(db, Date.now);
    createTextSnapshotStore(db, Date.now);
    db.exec('BEGIN IMMEDIATE');
    db.exec(
      'CREATE TABLE activation_state (id INTEGER PRIMARY KEY CHECK (id = 1), current_sha TEXT NOT NULL, previous_sha TEXT) STRICT',
    );
    db.prepare('INSERT INTO activation_state VALUES (1, ?, NULL)').run(sha);
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  await requireInitialMarker(staging, sha);
  await syncDirectory(data);
}

const systemAppName = 'Система.app';
const systemAppScript = `
ObjC.import('AppKit');
function run() {
  const previous = ($.NSEvent.modifierFlags & $.NSEventModifierFlagOption) !== 0;
  const task = $.NSTask.alloc.init;
  task.launchPath = '/Library/Application Support/Foliome/base/launch';
  task.arguments = previous ? ['--previous'] : [];
  task.currentDirectoryPath = '/';
  task.environment = $({});
  const sink = $.NSFileHandle.fileHandleWithNullDevice;
  task.standardInput = sink;
  task.standardOutput = sink;
  task.standardError = sink;
  task.launch;
}
`.trim();

async function verifySystemApp(bundle) {
  const executable = path.join(bundle, 'Contents/MacOS/applet');
  const script = path.join(bundle, 'Contents/Resources/Scripts/main.scpt');
  let entries = 0;
  async function visit(dir) {
    await requireDir(dir);
    await requireAcl(dir, []);
    for await (const { name } of await fs.opendir(dir)) {
      if (++entries > 64) throw Error('owner-app');
      const file = path.join(dir, name);
      const info = await fs.lstat(file);
      if (info.isDirectory()) await visit(file);
      else {
        if (!ownedFile(info, file === executable ? 0o700 : 0o600)) throw Error('owner-app');
        await requireAcl(file, []);
      }
    }
  }
  await visit(bundle);
  if (!ownedFile(await fs.lstat(executable), 0o700) || !ownedFile(await fs.lstat(script), 0o600))
    throw Error('owner-app');
  const options = { cwd: '/', env: {}, timeout: 10000, maxBuffer: 65536, encoding: 'utf8' };
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', bundle], options);
  if (execFileSync('/usr/bin/osadecompile', [script], options).trim() !== systemAppScript)
    throw Error('owner-app');
}

async function installSystemApp(app) {
  await requireDir(app);
  await requireAcl(path.dirname(app), []);
  await requireAcl(app, []);
  const bundle = path.join(app, systemAppName);
  const scratch = path.join(app, '.system-app');
  if (await stat(scratch)) {
    await requireDir(scratch);
    await requireAcl(scratch, []);
    await fs.rm(scratch, { recursive: true });
  }
  if (await stat(bundle)) return verifySystemApp(bundle);
  await fs.mkdir(scratch, { mode: 0o700 });
  try {
    const staged = path.join(scratch, systemAppName);
    execFileSync('/usr/bin/osacompile', ['-l', 'JavaScript', '-o', staged, '-e', systemAppScript], {
      cwd: scratch,
      env: { TMPDIR: scratch },
      timeout: 10000,
      stdio: 'ignore',
    });
    await verifySystemApp(staged);
    await fs.rename(staged, bundle);
    await syncDirectory(app);
  } finally {
    await fs.rm(scratch, { recursive: true });
  }
}

async function activate({ sha, data, app, releases }) {
  await requireInitialAuthority(sha);
  const release = path.join(releases, sha);
  await verifyInventory(release, path.join(data, 'accepted', sha + '.json'), sha, uid);
  const { live, staging } = initialDatabasePaths(data, sha);
  const active = await alreadyActive(live, staging, sha);
  if (!active) {
    for (const suffix of ['-journal', '-shm', '-wal'])
      if ((await stat(live + suffix)) || (await stat(staging + suffix)))
        throw Error('owner-database');
    await requireInitialMarker(staging, sha);
    await requireDir(data);
  }
  await installSystemApp(app);
  if (active) return;
  await fs.link(staging, live);
  await fs.unlink(staging);
  await syncDirectory(data);
}

async function ownerActivation(mode, data, sha) {
  requireRootParent();
  const file = path.join(data, 'core.db');
  if (!ownedFile(await fs.lstat(file), 0o600)) throw Error('owner-database');
  if (mode === 'activation-status') {
    const db = new DatabaseSync(file, { readOnly: true, defensive: true });
    try {
      const selected = marker(db);
      if (!selected) throw Error('owner-database');
      process.stdout.write(JSON.stringify(selected));
    } finally {
      db.close();
    }
    return;
  }
  if (!process.send || !process.connected) throw Error('owner-authority');
  // The root parent uses this already loaded owner helper after replacing base.
  const db = new DatabaseSync(file, { defensive: true });
  try {
    const receive = () =>
      new Promise((resolve, reject) => {
        process.once('message', resolve);
        process.once('disconnect', reject);
      });
    const request = receive();
    process.send('listening');
    const selection = await request;
    if (selection?.sha !== sha || !sameSelection(marker(db), selection))
      throw Error('owner-database');
    const decision = receive();
    process.send('ready');
    const operation = await decision;
    if (operation !== 'commit' && operation !== 'status') throw Error('owner-authority');
    if (operation === 'commit') {
      try {
        commitActivation(db, selection, sha);
      } catch {
        // The journal settles from the actual marker even after a failed transaction.
      }
    }
    process.send({ state: marker(db) }, () => process.disconnect());
  } finally {
    db.close();
  }
}

async function main() {
  const [mode, sha] = process.argv.slice(2);
  const user = os.userInfo();
  if (
    process.platform !== 'darwin' ||
    __filename !== path.join(root, 'base/install-owner.js') ||
    process.execPath !== path.join(root, 'base/node') ||
    process.argv.length !== 4 ||
    ![
      'prepare',
      'prepare-initial',
      'activate',
      'prepare-executor',
      'verify-update',
      'activate-update',
      'activation-status',
    ].includes(mode) ||
    !shaPattern.test(sha) ||
    Object.keys(process.env).length ||
    !uid ||
    process.geteuid() !== uid ||
    user.uid !== uid ||
    user.gid !== process.getgid() ||
    process.getegid() !== user.gid ||
    process.getgroups().some((gid) => gid !== user.gid)
  )
    throw Error('owner-boundary');
  process.umask(0o077);
  const home = user.homedir;
  const library = path.join(home, 'Library');
  const support = path.join(library, 'Application Support');
  const application = path.join(support, 'Foliome');
  await requireDir(home);
  if (mode === 'prepare-executor') {
    if (user.username !== 'executor' || home !== '/Users/executor') throw Error('owner-path');
    for (const dir of [library, support]) await profileParent(dir, true);
    for (const dir of [application, path.join(application, 'codex'), path.join(application, 'tmp')])
      await ensureDir(dir);
    return;
  }
  for (const dir of [library, support]) await profileParent(dir);
  await requireDir(application);
  const data = path.join(application, 'data');
  await requireDir(data);
  const app = path.join(application, 'app');
  const releases = path.join(app, 'releases');
  if (mode === 'activate-update' || mode === 'activation-status')
    return ownerActivation(mode, data, sha);
  if (mode === 'verify-update') {
    requireRootParent();
    return prepare({ sha, data, app, releases }, await input(), true);
  }
  if (mode === 'prepare-initial') requireRootParent();
  await exclusive(path.join(data, 'activation.json'), async () => {
    for (const dir of [app, releases, path.join(data, 'accepted'), path.join(data, 'tmp')])
      await ensureDir(dir);
    const keys = path.join(data, 'ssh');
    await requireDir(keys);
    for (const name of ['launch_ed25519', 'owner_ed25519'])
      if (!ownedFile(await fs.lstat(path.join(keys, name)), 0o600)) throw Error('owner-keys');
    const paths = { sha, data, app, releases };
    if (mode === 'activate') await activate(paths);
    else {
      await prepare(paths, await input());
      if (mode === 'prepare-initial') {
        await prepareInitialDatabase(paths);
        await preflightAcceptedRelease({
          home,
          systemRoot: root,
          sha,
          accept: (requested) => requested === sha,
          initial: true,
          compatible: true,
        });
      }
    }
  });
}

module.exports = { prepare };

if (require.main === module)
  main().catch(() => {
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
