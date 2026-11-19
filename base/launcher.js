'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { DatabaseSync, backup } = require('node:sqlite');
const { promisify } = require('node:util');
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
async function readInventory(record, sha, uid) {
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
  }
  return value.files;
}

async function verifyInventory(release, record, sha, uid) {
  const files = await readInventory(record, sha, uid);
  const names = Object.keys(files);
  const directories = new Set();
  for (const name of names) {
    const parts = name.split('/');
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
        if (createHash('sha256').update(content).digest('hex') !== files[relative])
          throw Error('digest');
      }
    }
  }
  await visit(release, '');
  if (remaining.size || performance.now() > deadline) throw Error('inventory');
  return files;
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

async function launchAcceptedRelease({ home, systemRoot: root, run, supervise }) {
  if (typeof run !== 'function' && typeof supervise !== 'function') throw Error('boundary');
  const { uid, data, releases, accepted, tmpdir, node, dbPath } = await installedPaths(home, root);
  await directory(tmpdir, uid);
  const { exclusive, marker } = require('./activation-state.js');
  return exclusive(path.join(data, 'activation.json'), async (withoutLease) => {
    const paths = { uid, home, data, releases, accepted, tmpdir, node, dbPath, withoutLease };
    if (supervise && root === systemRoot) {
      const { rootFence } = require('./install-production.js');
      const { stat } = require('./install-transaction.js');
      // A killed SQLite writer may leave a hot journal. The installed recovery
      // helper must settle it under the owner UID before reading the marker.
      if (await stat(rootFence)) return supervise(paths);
    }
    const file = await openFile(dbPath, uid, Number.MAX_SAFE_INTEGER);
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      let state;
      try {
        const now = await fs.lstat(dbPath);
        if (now.dev !== file.s.dev || now.ino !== file.s.ino || !now.isFile())
          throw Error('database');
        db.exec('PRAGMA trusted_schema = OFF');
        state = marker(db);
      } finally {
        db.close();
      }
      if (!state || !shaPattern.test(state.current)) throw Error('state');
      const release = path.join(releases, state.current);
      if (supervise) return await supervise({ ...paths, state, release });
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

async function removeCheckWorkspace(scratch, releases, uid, root) {
  const { stat } = require('./install-transaction.js');
  const entry = await stat(scratch);
  if (!entry) return;
  const device = (await fs.lstat(releases)).dev;
  async function check(dir, info) {
    if (
      !info.isDirectory() ||
      info.uid !== uid ||
      (info.mode & 0o7777) !== 0o700 ||
      info.dev !== device ||
      dir !== (await fs.realpath(dir))
    )
      throw Error('copy');
    if (root === systemRoot) await require('./install-platform.js').requireAcl(dir, []);
  }
  await check(scratch, entry);
  const data = path.join(scratch, 'data');
  const contents = await stat(data);
  if (contents) {
    await check(data, contents);
    for (const name of await fs.readdir(data)) {
      if (!/^core\.db(?:-(?:wal|shm|journal))?$/.test(name)) throw Error('copy');
      const file = path.join(data, name);
      const info = await fs.lstat(file);
      if (!info.isFile() || info.uid !== uid || info.nlink !== 1 || info.dev !== device)
        throw Error('copy');
      await fs.unlink(file);
    }
    await fs.rmdir(data);
  }
  await fs.rmdir(scratch);
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
    child.once('error', () => reject(Error('self-check-unavailable')));
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else if (signal === 'SIGKILL') reject(Error('self-check-timeout'));
      else if (signal || code === 126 || code === 127) reject(Error('self-check-unavailable'));
      else reject(Error('self-check'));
    });
  });
}

// Compare the actual copy with the schema built by the accepted release's
// ordinary store initializers. P1 has no source-approval store or schema migration.
const schemaCheck = `
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const live = new DatabaseSync(path.join(process.env.TMPDIR, 'core.db'), {readOnly: true, defensive: true});
const schema = new DatabaseSync(':memory:', {defensive: true});
const records = (db) => db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name').all();
const tables = ['action_browser_events', 'action_log_events', 'action_outcomes',
  'action_snapshot_deviations', 'action_verdicts', 'activation_state', 'channel_denials',
  'sqlite_sequence', 'text_snapshots'];
if (JSON.stringify(records(live).filter(row => row.type === 'table').map(row => row.name)) !== JSON.stringify(tables))
  process.exit(1);
live.exec('PRAGMA trusted_schema = OFF');
if (live.prepare('PRAGMA user_version').get().user_version !== 0 ||
  live.prepare('PRAGMA application_id').get().application_id !== 0 ||
  live.prepare('PRAGMA table_list').all().some(row => row.name === 'activation_state' && row.strict !== 1))
  process.exit(1);
schema.exec('CREATE TABLE activation_state (id INTEGER PRIMARY KEY CHECK (id = 1), current_sha TEXT NOT NULL, previous_sha TEXT) STRICT');
const entry = process.argv[1];
require(path.join(entry, 'core/adapters/store/action-protocol.ts')).createActionProtocol(schema, () => 0);
require(path.join(entry, 'core/adapters/store/text-snapshot-store.ts')).createTextSnapshotStore(schema, () => 0);
if (JSON.stringify(records(live)) !== JSON.stringify(records(schema))) process.exit(1);
`;

async function preflightAcceptedRelease({
  home,
  systemRoot: root,
  sha,
  accept,
  compatible = false,
  runtimeNode,
  initial = false,
  selection,
  expectedFiles,
}) {
  if (typeof sha !== 'string' || !shaPattern.test(sha) || typeof accept !== 'function')
    throw Error('boundary');
  const {
    uid,
    data: ownerData,
    releases,
    accepted,
    node,
    dbPath,
  } = await installedPaths(home, root);
  if (releases !== (await fs.realpath(releases))) throw Error('boundary');
  // The caller supplies the owner decision for this exact staged SHA.
  if ((await accept(sha)) !== true) throw Error('acceptance');
  const { stat } = require('./install-transaction.js');
  const {
    holdsExclusive,
    initialDatabasePaths,
    marker,
    sameSelection,
  } = require('./activation-state.js');
  if (!holdsExclusive(path.join(ownerData, 'activation.json'))) throw Error('boundary-state');
  const initialSeed = initial && !(await stat(dbPath));
  const source = initialSeed ? initialDatabasePaths(ownerData, sha).staging : dbPath;
  if (source !== (await fs.realpath(source))) throw Error('boundary');
  const release = path.join(releases, sha);
  try {
    const files = await verifyInventory(release, path.join(accepted, `${sha}.json`), sha, uid);
    if (expectedFiles && receiptDigest(files) !== receiptDigest(expectedFiles))
      throw Error('receipt');
  } catch {
    throw Error('receipt');
  }
  const scratch = path.join(releases, `${sha}.check`);
  const data = path.join(scratch, 'data');
  try {
    // A killed preflight can leave only this exact private workspace behind.
    await removeCheckWorkspace(scratch, releases, uid, root);
    await fs.mkdir(scratch, { mode: 0o700 });
  } catch {
    throw Error('copy');
  }
  try {
    try {
      await fs.mkdir(data, { mode: 0o700 });
      await snapshotDatabase(source, path.join(data, 'core.db'), uid);
    } catch {
      throw Error('copy');
    }
    if (selection) {
      const copy = pathToFileURL(path.join(data, 'core.db'));
      copy.searchParams.set('immutable', '1');
      const db = new DatabaseSync(copy, { readOnly: true, defensive: true });
      try {
        db.exec('PRAGMA trusted_schema = OFF');
        if (!sameSelection(marker(db), selection)) throw Error('boundary-state');
      } finally {
        db.close();
      }
    }
    const args = releaseArgs(home, data, initial ? node : (runtimeNode ?? node), release);
    await runSelfCheck(
      [...args, '--self-check', ...(initialSeed ? ['--initial-seed'] : [])],
      release,
    );
    if (compatible) {
      try {
        await runSelfCheck([...args.slice(0, -1), '-e', schemaCheck, release], release);
      } catch (error) {
        if (error.message !== 'self-check') throw error;
        throw Error('incompatible');
      }
    }
  } finally {
    await removeCheckWorkspace(scratch, releases, uid, root);
  }
}

async function atomicRecord(file, value) {
  const { syncDirectory } = require('./install-transaction.js');
  const temporary = `${file}.${randomUUID()}`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function makePrivate(dir, uid) {
  await fs.mkdir(dir, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  await directory(dir, uid);
}

function readActivation(dbPath, write) {
  const { marker } = require('./activation-state.js');
  const db = new DatabaseSync(dbPath, { readOnly: !write, defensive: true });
  try {
    db.exec('PRAGMA trusted_schema = OFF');
    const state = marker(db);
    if (!state) throw Error('boundary-state');
    return write ? write(db, state) : state;
  } finally {
    db.close();
  }
}

async function readRecord(file, uid, limit = 4096) {
  try {
    return JSON.parse((await bytes(file, uid, limit)).toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function trustedMetadata(paths, sha, files) {
  const release = path.join(paths.releases, sha);
  files ??= await verifyInventory(
    release,
    path.join(paths.accepted, sha + '.json'),
    sha,
    paths.uid,
  );
  return readMetadata(path.join(release, 'release/manifest.json'), paths.uid, files);
}

async function readMetadata(file, uid, files) {
  const raw = await bytes(file, uid, 65536);
  if (createHash('sha256').update(raw).digest('hex') !== files['release/manifest.json'])
    throw Error('receipt');
  return { manifest: JSON.parse(raw.toString('utf8')), files };
}

const retryable = [
  'admin-canceled',
  'admin-timeout',
  'ci-awaiting',
  'network',
  'network-timeout',
  'release-observation',
  'self-check-timeout',
  'self-check-unavailable',
];

function ownerCode(error) {
  const code = error.message;
  if (
    [
      'self-check',
      'incompatible',
      'previous-unavailable',
      'release-verification',
      'release-invalid',
      'boundary-failed',
      'boundary-refused',
      'restore-failed',
      ...retryable,
    ].includes(code)
  )
    return code;
  if (/^boundary-/.test(code)) return 'boundary-failed';
  if (/^release-|^receipt$/.test(code)) return 'release-verification';
  return 'update-failed';
}

function visibleCode(code) {
  if (code === 'release-invalid') return 'release-verification';
  if (code === 'boundary-refused') return 'boundary-failed';
  if (code === 'release-observation' || code === 'self-check-unavailable') return 'update-failed';
  return code;
}

async function rejectedShas(dir, uid) {
  const rejected = [];
  for await (const entry of await fs.opendir(dir)) {
    if (entry.isFile() && /^[a-f0-9]{40}\.[a-f0-9-]{36}$/.test(entry.name)) {
      // An interrupted atomic write left an unpublished record.
      await fs.unlink(path.join(dir, entry.name));
      continue;
    }
    if (rejected.length >= 10000 || !entry.isFile() || !shaPattern.test(entry.name))
      throw Error('boundary-state');
    const sha = await readRecord(path.join(dir, entry.name), uid, 128);
    if (sha !== entry.name) throw Error('boundary-state');
    rejected.push(sha);
  }
  return rejected;
}

async function releaseProof(paths, updates, sha, authority, files) {
  const proofFile = path.join(updates, sha + '.json');
  const proof = await readRecord(proofFile, paths.uid);
  if (proof) {
    if (
      !['pinned', 'changed'].includes(proof.checks) ||
      !proof.workflow ||
      Object.keys(proof.workflow).length !== 3 ||
      !['id', 'runId', 'attempt'].every(
        (key) => Number.isSafeInteger(proof.workflow[key]) && proof.workflow[key] > 0,
      ) ||
      proof.workflow.id !== authority.initialWorkflow.id ||
      (sha === authority.initialSha &&
        (proof.checks !== 'pinned' ||
          proof.workflow.runId !== authority.initialWorkflow.runId ||
          proof.workflow.attempt !== authority.initialWorkflow.attempt)) ||
      !proof.runtime ||
      Object.keys(proof.runtime).length !== 3 ||
      !['node', 'codex', 'planner'].every((key) => digestPattern.test(proof.runtime[key])) ||
      proof.runtime.planner !== files['base/system-install-layout.js'] ||
      (proof.receipt !== undefined && proof.receipt !== receiptDigest(files)) ||
      (proof.previous !== undefined && !shaPattern.test(proof.previous))
    )
      throw Error('receipt');
    return proof;
  }
  if (sha !== authority.initialSha || sha !== authority.sha) throw Error('release-verification');
  const { installedRuntime } = require('./install-production.js');
  const initial = {
    checks: 'pinned',
    workflow: authority.initialWorkflow,
    runtime: await installedRuntime(authority),
    receipt: receiptDigest(files),
  };
  if (files['base/system-install-layout.js'] !== initial.runtime.planner)
    throw Error('release-verification');
  await atomicRecord(proofFile, initial);
  return initial;
}

function receiptDigest(files) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        Object.keys(files)
          .sort()
          .map((name) => [name, files[name]]),
      ),
    )
    .digest('hex');
}

async function savedCurrentMetadata(paths, updates, { current: sha, previous }, authority) {
  const files = await readInventory(path.join(paths.accepted, sha + '.json'), sha, paths.uid);
  const stage = path.join(paths.data, 'install-staging');
  const manifestDir = path.join(stage, sha, 'release');
  for (const dir of [stage, path.join(stage, sha), manifestDir]) await directory(dir, paths.uid);
  const saved = await readMetadata(path.join(manifestDir, 'manifest.json'), paths.uid, files);
  const proof = await releaseProof(paths, updates, sha, authority, files);
  if (
    saved.manifest.schema !== 'foliome-release/1' ||
    (previous && proof.previous !== undefined && proof.previous !== previous) ||
    (authority.sha === sha && authority.version !== saved.manifest.version)
  )
    throw Error('receipt');
  return saved;
}

function boundaryChanges(from, to) {
  const { isReleaseCheckPath } = require('./release-policy.ts');
  const covered =
    /^(?:base|system|executor|core\/adapters\/(?:browser|channel|system|ui|executor|version|update)|core\/domain|agents|\.claude)\/|^(?:README\.md|core\/(?:main|system-entrypoint)\.ts)$/;
  return [...new Set([...Object.keys(from), ...Object.keys(to)])].some(
    (name) => (isReleaseCheckPath(name) || covered.test(name)) && from[name] !== to[name],
  );
}

function descriptor(kind, sha, from, to, checks, password, boundary) {
  return {
    kind,
    sha,
    from: from.version,
    to: to.version,
    checks,
    password,
    boundary,
    notes: kind === 'update' ? to.notesRu : '',
    node: [process.versions.node, kind === 'previous' ? process.versions.node : to.node.version],
    codex: [from.codex.version, to.codex.version],
    playwright: [from.playwrightCore.version, to.playwrightCore.version],
  };
}

async function stageOwnerRelease(paths, updates, selection, authority, activeVersion, rejected) {
  const { stageReleaseFromOrigin } = require('./release-pipeline.js');
  const { releasePolicy, keySetSha256 } = require('./installation-release.js');
  const { materializeRelease } = require('./release-materialization.js');
  const { publishStage, readPrivate } = require('./first-install.js');
  const { ownerPayload, needsRoot } = require('./install-production.js');
  const { prepare } = require('./install-owner.js');
  const stageParent = path.join(paths.data, 'install-staging');
  await directory(stageParent, paths.uid);
  const scratch = await fs.mkdtemp(path.join(stageParent, '.owner-'));
  try {
    const stage = await stageReleaseFromOrigin(selection, {
      mode: 'owner',
      stagingRoot: scratch,
      scratchRoot: scratch,
      policy: releasePolicy(activeVersion, authority),
      rejectedShas: rejected,
      productionErrors: true,
    });
    if (!stage.ok) throw Error(stage.code ?? 'release-verification');
    const manifest = JSON.parse(
      (await readPrivate(path.join(stage.stagingDir, 'release/manifest.json'), 65536)).toString(
        'utf8',
      ),
    );
    if (
      manifest.securityFix !== null ||
      manifest.securityNarrowing !== null ||
      stage.tree.some(({ path }) => /^(system|executor)\//i.test(path))
    )
      throw Error('incompatible');
    const password = await needsRoot(
      { stage, manifest, runtime: stage.runtime, kind: 'update' },
      authority,
    );
    const target = path.join(scratch, 'materialized');
    await fs.mkdir(target, { mode: 0o700 });
    const materialized = await materializeRelease({
      stage,
      approval: stage.sha,
      releasesRoot: target,
    });
    if (!materialized.ok) throw Error('release-verification');
    const initialStage = path.join(stageParent, authority.initialSha);
    for (const dir of [initialStage, path.join(initialStage, '.install-keys')])
      await directory(dir, paths.uid);
    const keys = Object.fromEntries(
      await Promise.all(
        ['owner', 'launch', 'dev'].map(async (kind) => [
          kind,
          (await readPrivate(path.join(initialStage, '.install-keys', kind + '.pub'), 256))
            .toString('utf8')
            .trimEnd(),
        ]),
      ),
    );
    if (keySetSha256(keys) !== authority.keySetSha256) throw Error('boundary-state');
    await publishStage(stageParent, stage, keys);
    await prepare(
      { sha: stage.sha, ...paths, app: path.dirname(paths.releases) },
      await ownerPayload(materialized),
    );
    const planner = stage.tree.find(({ path }) => path === 'base/system-install-layout.js').sha256;
    const metadata = await trustedMetadata(paths, stage.sha);
    const proof = {
      checks: stage.checks,
      workflow: stage.workflow,
      runtime: { ...stage.runtime, planner },
      receipt: receiptDigest(metadata.files),
      previous: paths.state.current,
    };
    await atomicRecord(path.join(updates, stage.sha + '.json'), proof);
    return { password, proof, tree: stage.tree, ...metadata };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

async function ownOffer(paths, updates, authority, active, kind, rejected) {
  const { releaseTags } = require('./release-origin.js');
  const { isReleaseNewer } = require('./installation-release.js');
  const { needsRoot, parseHandoff } = require('./install-production.js');
  let selection;
  if (kind === 'update') {
    for (const tag of await releaseTags()) {
      if (
        tag.commit !== paths.state.current &&
        !rejected.includes(tag.commit) &&
        isReleaseNewer(tag.version, selection?.version ?? active.manifest.version)
      )
        selection = tag;
    }
  } else selection = { commit: paths.state.previous };
  if (!selection?.commit || rejected.includes(selection.commit)) return null;
  let target;
  try {
    if (kind === 'update') {
      target = await stageOwnerRelease(
        paths,
        updates,
        selection,
        authority,
        active.manifest.version,
        rejected,
      );
    } else {
      const metadata = await trustedMetadata(paths, selection.commit);
      const proof = await releaseProof(paths, updates, selection.commit, authority, metadata.files);
      if (!isReleaseNewer(active.manifest.version, metadata.manifest.version))
        throw Error('incompatible');
      const tree = [
        {
          path: 'base/system-install-layout.js',
          sha256: metadata.files['base/system-install-layout.js'],
        },
      ];
      const password = await needsRoot(
        {
          stage: { tree },
          manifest: metadata.manifest,
          kind,
          runtime: proof.runtime,
        },
        authority,
      );
      target = { ...metadata, proof, password, tree };
    }
  } catch (error) {
    if (kind === 'update' && ['release-invalid', 'incompatible'].includes(error.message))
      await atomicRecord(path.join(updates, 'rejected', selection.commit), selection.commit);
    throw error;
  }
  const card = descriptor(
    kind,
    selection.commit,
    active.manifest,
    target.manifest,
    target.proof.checks,
    target.password,
    target.password || boundaryChanges(active.files, target.files),
  );
  return {
    card,
    runtime: target.proof.runtime,
    files: target.files,
    manifest: target.manifest,
    tree: target.tree,
    handoff: parseHandoff({
      kind,
      sha: selection.commit,
      ...paths.state,
      version: card.to,
      fromVersion: card.from,
      workflow: target.proof.workflow,
      password: card.password,
    }),
  };
}

async function askAdministrator(sha) {
  if (!shaPattern.test(sha)) throw Error('boundary-state');
  const command =
    '/usr/bin/env -i "' +
    path.join(systemRoot, 'base/node') +
    '" "' +
    path.join(systemRoot, 'base/install-root.js') +
    '" ' +
    sha;
  const script =
    'with timeout of 600 seconds\ntry\ndo shell script ' +
    JSON.stringify(command) +
    ' with administrator privileges\nreturn "ok"\non error messageText number errorNumber\n' +
    'if errorNumber = -128 then return "admin-canceled"\n' +
    'if errorNumber = -1712 then return "admin-timeout"\nreturn messageText\nend try\nend timeout';
  const result = await promisify(execFile)('/usr/bin/osascript', ['-e', script], {
    cwd: '/',
    env: {},
    maxBuffer: 4096,
  });
  const code = result.stdout.trim();
  if (code !== 'ok') {
    if (
      [
        ...retryable,
        'release-invalid',
        'release-verification',
        'restore-failed',
        'boundary-refused',
        'boundary-entry',
        'boundary-permissions',
        'boundary-base',
        'self-check',
        'incompatible',
      ].includes(code)
    )
      throw Error(code);
    throw Error('boundary-failed');
  }
}

async function confirmDialog(prompt, button) {
  const script =
    'try\n' +
    'display dialog ' +
    JSON.stringify(prompt) +
    ' buttons {"Отмена", ' +
    JSON.stringify(button) +
    '} default button 1 cancel button 1\nreturn "confirm"\non error number -128\nreturn "cancel"\nend try';
  const result = await promisify(execFile)('/usr/bin/osascript', ['-e', script], {
    cwd: '/',
    env: {},
    maxBuffer: 4096,
    timeout: 120000,
  });
  return result.stdout.trim() === 'confirm';
}

function confirmPrevious(card, startupFailed) {
  const prompt = [
    startupFailed ? 'Ядро не запустилось.' : '',
    `Вернуть v${card.from} → v${card.to}?`,
    card.checks === 'changed' ? 'Набор проверок изменён.' : 'Набор проверок закреплён.',
    card.boundary ? 'Подтвердите ранее утверждённые изменения границы.' : '',
    card.password ? 'Нужен пароль администратора.' : 'Пароль администратора не нужен.',
  ]
    .filter(Boolean)
    .join(' ');
  return confirmDialog(prompt, 'Вернуть и подтвердить');
}

async function recordHandoff(paths, updates, handoff, code) {
  const { activationCommitted, rootFence } = require('./install-production.js');
  const { stat, syncDirectory } = require('./install-transaction.js');
  if (await stat(rootFence)) throw Error('restore-failed');
  const { sameSelection } = require('./activation-state.js');
  const marker = readActivation(paths.dbPath);
  if (activationCommitted(marker, handoff)) {
    if (handoff.kind === 'previous')
      await atomicRecord(path.join(updates, 'rejected', handoff.current), handoff.current);
    await atomicRecord(path.join(updates, 'result.json'), {
      code: handoff.kind === 'previous' ? 'restored' : 'updated',
      version: handoff.version,
      sha: marker.current,
    });
  } else {
    if (!sameSelection(marker, handoff)) throw Error('restore-failed');
    if (
      handoff.kind === 'update' &&
      ['self-check', 'incompatible', 'release-invalid', 'boundary-refused'].includes(code)
    )
      await atomicRecord(path.join(updates, 'rejected', handoff.sha), handoff.sha);
    await atomicRecord(path.join(updates, 'result.json'), {
      code: visibleCode(code),
      sha: marker.current,
    });
  }
  await fs.rm(path.join(updates, 'handoff.json'), { force: true });
  await syncDirectory(updates);
}

async function preflightSelection(home, handoff, runtimeNode, currentFiles, targetFiles) {
  const releases = [[handoff.sha, targetFiles]];
  if (handoff.kind === 'update') releases.unshift([handoff.current, currentFiles]);
  for (const [sha, expectedFiles] of releases) {
    await preflightAcceptedRelease({
      home,
      systemRoot,
      sha,
      accept: (requested) => requested === sha,
      compatible: true,
      runtimeNode,
      selection: handoff,
      expectedFiles,
    });
  }
  const paths = await installedPaths(home, systemRoot);
  if (paths.releases !== (await fs.realpath(paths.releases))) throw Error('boundary');
  for (const [sha, expected] of releases) {
    const { files } = await trustedMetadata(paths, sha);
    if (receiptDigest(files) !== receiptDigest(expected)) throw Error('release-verification');
  }
}

async function applyOwnerOffer(paths, updates, offer, authority) {
  const { handoff } = offer;
  const { sameSelection, commitActivation } = require('./activation-state.js');
  const { isReleaseNewer } = require('./installation-release.js');
  const { rootFence, needsRoot, installedRuntime } = require('./install-production.js');
  const { stat } = require('./install-transaction.js');
  if (
    !sameSelection(readActivation(paths.dbPath), handoff) ||
    (await stat(rootFence)) ||
    (handoff.kind === 'update' &&
      (!isReleaseNewer(handoff.version, handoff.fromVersion) ||
        (await rejectedShas(path.join(updates, 'rejected'), paths.uid)).includes(handoff.sha)))
  )
    throw Error('boundary-state');
  const { readInstallationRelease } = require('./installation-release.js');
  const now = await readInstallationRelease();
  if (
    JSON.stringify(now) !== JSON.stringify(authority) ||
    (await needsRoot(
      {
        stage: { tree: offer.tree },
        manifest: offer.manifest,
        runtime: offer.runtime,
        kind: handoff.kind,
      },
      now,
    )) !== handoff.password
  )
    throw Error('boundary-state');
  let code = 'update-failed';
  let runtimeWork;
  try {
    if (handoff.kind === 'previous') {
      const active = await savedCurrentMetadata(paths, updates, handoff, now);
      if (active.manifest.version !== handoff.fromVersion) throw Error('boundary-state');
    }
    let runtimeNode;
    if (handoff.kind === 'update') {
      // Build the same known schema and ensure the selected runtime also supports rollback.
      if (offer.runtime.node !== (await installedRuntime(authority)).node) {
        const { verifiedRuntime } = require('./publisher-verification.js');
        runtimeWork = await fs.mkdtemp(path.join(paths.tmpdir, 'runtime-'));
        const archive = path.join(
          paths.data,
          'install-staging',
          handoff.sha,
          '.release-artifacts/node',
        );
        const binary = await verifiedRuntime(
          await bytes(archive, paths.uid, 128 * 1024 * 1024),
          'node',
          offer.manifest.node,
          runtimeWork,
        );
        if (createHash('sha256').update(binary).digest('hex') !== offer.runtime.node)
          throw Error('release-verification');
        runtimeNode = path.join(runtimeWork, 'node');
        await fs.writeFile(runtimeNode, binary, { flag: 'wx', mode: 0o700 });
      }
    }
    await preflightSelection(paths.home, handoff, runtimeNode, paths.inventory, offer.files);
    if (!sameSelection(readActivation(paths.dbPath), handoff)) throw Error('boundary-state');
    await atomicRecord(path.join(updates, 'handoff.json'), handoff);
    if (handoff.password) await paths.withoutLease(() => askAdministrator(handoff.sha));
    else readActivation(paths.dbPath, (db) => commitActivation(db, handoff, handoff.sha));
  } catch (error) {
    code = ownerCode(error);
  } finally {
    if (runtimeWork) await fs.rm(runtimeWork, { recursive: true, force: true });
  }
  await recordHandoff(paths, updates, handoff, code);
}

async function restorePrevious(paths, updates, authority, startupFailed) {
  if (!paths.state.previous) throw Error('previous-unavailable');
  const active = await savedCurrentMetadata(paths, updates, paths.state, authority);
  const rejected = await rejectedShas(path.join(updates, 'rejected'), paths.uid);
  const previous = await ownOffer(paths, updates, authority, active, 'previous', rejected);
  if (!previous) {
    if (startupFailed) return false;
    throw Error('previous-unavailable');
  }
  if (!(await confirmPrevious(previous.card, startupFailed))) return false;
  await applyOwnerOffer(paths, updates, previous, authority);
  if (readActivation(paths.dbPath).current === previous.card.sha) return true;
  const failure = await readRecord(path.join(updates, 'result.json'), paths.uid);
  throw Error(failure?.code ?? 'update-failed');
}

async function superviseOwner(paths, previousOnly) {
  const { readInstallationRelease } = require('./installation-release.js');
  const { parseHandoff, rootFence } = require('./install-production.js');
  const { stat } = require('./install-transaction.js');
  const { requireAcl } = require('./install-platform.js');
  for (const directory of [
    paths.data,
    paths.accepted,
    path.dirname(paths.releases),
    paths.releases,
    paths.tmpdir,
  ])
    await requireAcl(directory, []);
  const updates = path.join(paths.data, 'updates');
  await makePrivate(updates, paths.uid);
  await makePrivate(path.join(updates, 'rejected'), paths.uid);
  await requireAcl(updates, []);
  await requireAcl(path.join(updates, 'rejected'), []);
  const saved = await readRecord(path.join(updates, 'handoff.json'), paths.uid);
  const interrupted = saved && parseHandoff(saved);
  if (await stat(rootFence)) {
    if (previousOnly || !interrupted?.password) throw Error('restore-failed');
    if (
      !(await confirmDialog(
        'Установка прервана. Восстановить системные файлы? Нужен пароль администратора.',
        'Восстановить',
      ))
    )
      throw Error('restore-failed');
    await paths.withoutLease(() => askAdministrator(interrupted.sha));
    if (await stat(rootFence)) throw Error('restore-failed');
    return true;
  }
  if (interrupted) await recordHandoff(paths, updates, interrupted, 'update-failed');
  if (await stat(rootFence)) throw Error('restore-failed');
  if (!paths.state) return true;
  const authority = await readInstallationRelease();
  if (authority.ownerUid !== paths.uid) throw Error('boundary-state');
  if (previousOnly) return restorePrevious(paths, updates, authority, false);
  try {
    paths.inventory = await verifyInventory(
      paths.release,
      path.join(paths.accepted, paths.state.current + '.json'),
      paths.state.current,
      paths.uid,
    );
  } catch (error) {
    if (!paths.state.previous) throw error;
    return restorePrevious(paths, updates, authority, true);
  }
  const result = await readRecord(path.join(updates, 'result.json'), paths.uid);
  const args = releaseArgs(paths.home, paths.tmpdir, paths.node, paths.release);
  const child = spawn(paths.node, args.slice(5), {
    cwd: '/',
    env: { HOME: paths.home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: paths.tmpdir },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let ready = false;
  let applying;
  let released = false;
  let exited = false;
  const offers = new Map();
  const send = (message) => {
    if (child.connected) child.send(message, () => {});
  };
  const done = new Promise((resolve) => {
    child.once('error', () => resolve(null));
    child.once('close', resolve);
  });
  async function discover() {
    const active = await trustedMetadata(paths, paths.state.current, paths.inventory);
    await releaseProof(paths, updates, paths.state.current, authority, active.files);
    const rejected = await rejectedShas(path.join(updates, 'rejected'), paths.uid);
    // Publish a usable previous-release card without waiting for GitHub.
    for (const kind of ['previous', 'update']) {
      if (exited || applying) return;
      try {
        const offer = await ownOffer(paths, updates, authority, active, kind, rejected);
        if (offer && !exited && !applying) {
          offers.set(offer.card.sha, offer);
          send({ type: 'release-card', card: offer.card });
        }
      } catch (error) {
        if (!result && error.message !== 'ci-awaiting') {
          send({ type: 'release-result', code: visibleCode(ownerCode(error)) });
        }
      }
    }
  }
  let discovery;
  child.on('message', (message) => {
    if (message?.type === 'release-ready' && !ready) {
      ready = true;
      if (result?.sha === paths.state.current)
        send({ type: 'release-result', code: result.code, version: result.version });
      discovery = discover().catch((error) => {
        if (!result) send({ type: 'release-result', code: visibleCode(ownerCode(error)) });
      });
    } else if (message?.type === 'release-accept' && typeof message.sha === 'string') {
      const offer = offers.get(message.sha);
      if (offer && !applying) {
        applying = offer;
        offers.clear();
        send({ type: 'release-handoff', accepted: true, sha: message.sha });
      } else send({ type: 'release-handoff', accepted: false, sha: message.sha });
    } else if (message?.type === 'release-closed' && message.sha === applying?.card.sha) {
      released = true;
    }
  });
  const status = await done;
  exited = true;
  if (!released || status !== 0) {
    if (status !== 0 && !applying && paths.state.previous)
      return restorePrevious(paths, updates, authority, true);
    return false;
  }
  await discovery;
  try {
    await applyOwnerOffer(paths, updates, applying, authority);
  } catch (error) {
    if (await stat(rootFence)) throw Error('restore-failed');
    await atomicRecord(path.join(updates, 'result.json'), {
      code: ownerCode(error),
      sha: paths.state.current,
    });
  }
  return true;
}

module.exports = {
  launchAcceptedRelease,
  preflightAcceptedRelease,
  preflightSelection,
  savedCurrentMetadata,
  verifyInventory,
};

if (require.main === module) {
  void (async () => {
    const previousOnly = process.argv.length === 3 && process.argv[2] === '--previous';
    if (
      (process.argv.length !== 2 && !previousOnly) ||
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
    const { exclusive } = require('./activation-state.js');
    const paths = await installedPaths(home, systemRoot);
    // Serialize launcher sessions while the installed root helper holds the activation lease.
    const relaunch = await exclusive(path.join(paths.data, 'launcher'), () =>
      launchAcceptedRelease({
        home,
        systemRoot,
        supervise: (paths) => superviseOwner(paths, previousOnly),
      }),
    );
    if (relaunch) {
      const child = spawn(path.join(systemRoot, 'base/launch'), [], {
        cwd: '/',
        env: {},
        stdio: 'ignore',
        detached: true,
      });
      child.once('error', () => {
        process.exitCode = 1;
      });
      child.once('spawn', () => child.unref());
    }
  })().catch((error) => {
    if (process.platform === 'darwin' && __filename === path.join(systemRoot, 'base/launcher.js')) {
      const code = ownerCode(error);
      const title =
        code === 'restore-failed'
          ? 'Требуется восстановление системных файлов'
          : code === 'previous-unavailable'
            ? 'Предыдущая версия недоступна'
            : 'Запуск системы не завершён';
      const child = spawn(
        '/usr/bin/osascript',
        ['-e', 'display alert ' + JSON.stringify(title) + ' message "Код ' + code + '."'],
        { cwd: '/', env: {}, stdio: 'ignore' },
      );
      child.on('error', () => {});
    }
    process.exitCode = 1;
  });
}
