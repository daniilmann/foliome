'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { execFileSync, spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { exclusive } = require('./activation-state.js');
const { installationJournal, stat, syncDirectory } = require('./install-transaction.js');
const { dirMode, fileMode, requireAcl, rootParents } = require('./install-platform.js');
const {
  initialProofSha256,
  keySetSha256,
  readInstallationRelease,
  releasePolicy,
} = require('./installation-release.js');
const { stageReleaseFromOrigin } = require('./release-pipeline.js');

const system = '/Library/Application Support/Foliome';
const { parseInstalledConfig, parseInstalledSource } = require(
  __dirname === path.join(system, 'base')
    ? './installed-config.ts'
    : '../core/domain/installed-config.ts',
);
const shaPattern = /^[a-f0-9]{40}$/;
const uid = process.getuid();
const sshKeys = ['owner', 'launch'];
const archiveLimit = 256 * 1024 * 1024;
const keyLine = /^(ssh-ed25519 [A-Za-z0-9+/]{68})(?: [^\r\n]*)?\n?$/;

async function privateDirectory(dir, create = false) {
  if (create) {
    try {
      await fs.mkdir(dir, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  if (!dirMode(await fs.lstat(dir), uid, 0o700)) throw Error('owner-path');
}

async function readPrivate(file, limit, mode = 0o600) {
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const s = await handle.stat();
    if (!fileMode(s, uid, mode) || s.size > limit) throw Error('owner-path');
    const bytes = Buffer.alloc(s.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== s.size) throw Error('owner-path');
    return bytes.subarray(0, length);
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

function publicKey(value) {
  if (typeof value !== 'string' || !/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(value))
    throw Error('owner-keys');
  const prefix = Buffer.from('0000000b7373682d6564323535313900000020', 'hex');
  if (!Buffer.from(value.slice(12), 'base64').subarray(0, prefix.length).equals(prefix))
    throw Error('owner-keys');
  return value;
}

function keygen(args) {
  return execFileSync('/usr/bin/ssh-keygen', args, {
    cwd: '/',
    env: {},
    timeout: 10000,
    maxBuffer: 4096,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
}

async function ensureKeyPair(dir, scratch, name) {
  const key = path.join(dir, name + '_ed25519');
  const pub = key + '.pub';
  if (!(await stat(key))) {
    if (await stat(pub)) throw Error('owner-keys');
    const generated = path.join(scratch, name);
    keygen(['-q', '-t', 'ed25519', '-N', '', '-C', 'foliome-' + name, '-f', generated]);
    const handle = await fs.open(generated, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!fileMode(await handle.stat(), uid, 0o600)) throw Error('owner-keys');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(generated, key);
    await syncDirectory(dir);
  }
  if (!fileMode(await fs.lstat(key), uid, 0o600)) throw Error('owner-keys');
  await requireAcl(key, []);
  const line = keygen(['-y', '-P', '', '-f', key]);
  const expected = publicKey(keyLine.exec(line)?.[1]);
  if (!(await stat(pub))) {
    const newPublic = path.join(scratch, name + '.new.pub');
    await writePrivate(newPublic, expected + '\n');
    await fs.rename(newPublic, pub);
    await syncDirectory(dir);
  }
  const stored = keyLine.exec((await readPrivate(pub, 256)).toString('utf8'))?.[1];
  if (stored !== expected) throw Error('owner-keys');
  return expected;
}

async function readInputs(file, home) {
  if (path.dirname(file) !== home || path.normalize(file) !== file) throw Error('owner-input');
  await requireAcl(file, []);
  const value = JSON.parse(await readPrivate(file, 65536));
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'developerPublicKey')
  )
    throw Error('owner-input');
  return { source: parseInstalledSource(value.source), dev: publicKey(value.developerPublicKey) };
}

async function verifyStage(dir, expected, sync, prefix = '') {
  await privateDirectory(dir);
  for (const name of await fs.readdir(dir)) {
    const relative = prefix + name;
    const target = path.join(dir, name);
    const entry = expected.get(relative);
    if (entry) {
      if (sync) {
        const handle = await fs.open(
          target,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const s = await handle.stat();
          if (!fileMode(s, uid, entry.mode) || s.size > entry.limit) throw Error('owner-stage');
          await handle.sync();
        } finally {
          await handle.close();
        }
      } else {
        const bytes = await readPrivate(target, entry.limit, entry.mode);
        if (!bytes.equals(await readPrivate(entry.path, entry.limit, entry.mode)))
          throw Error('owner-stage');
      }
      expected.delete(relative);
    } else {
      const child = relative + '/';
      if (![...expected.keys()].some((item) => item.startsWith(child))) throw Error('owner-stage');
      await verifyStage(target, expected, sync, child);
    }
  }
  if (sync) await syncDirectory(dir);
}

async function publishStage(parent, evidence, keys) {
  const { stagingDir: source, sha, tree } = evidence;
  const keyDir = path.join(source, '.install-keys');
  await fs.mkdir(keyDir, { mode: 0o700 });
  const expected = new Map();
  function add(relative, mode, limit) {
    expected.set(relative, { path: path.join(source, relative), mode, limit });
  }
  for (const { path: relative, mode } of tree) {
    if (mode === '100755') {
      const handle = await fs.open(
        path.join(source, relative),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        if (!fileMode(await handle.stat(), uid, 0o700)) throw Error('owner-stage');
        await handle.chmod(0o600);
      } finally {
        await handle.close();
      }
    }
    add(relative, 0o600, 8 * 1024 * 1024);
  }
  for (const name of ['node', 'codex', 'playwrightCore'])
    add('.release-artifacts/' + name, 0o600, archiveLimit);
  for (const kind of ['owner', 'launch', 'dev']) {
    const relative = '.install-keys/' + kind + '.pub';
    await writePrivate(path.join(source, relative), publicKey(keys[kind]) + '\n');
    add(relative, 0o600, 256);
  }
  const target = path.join(parent, sha);
  const exists = await stat(target);
  await verifyStage(exists ? target : source, expected, !exists);
  if (expected.size) throw Error('owner-stage');
  if (!exists) {
    await fs.rename(source, target);
    await syncDirectory(parent);
  }
}

async function stageInstall(data, sha, dev, current) {
  const keyDir = path.join(data, 'ssh');
  const stageParent = path.join(data, 'install-staging');
  await privateDirectory(keyDir, true);
  await requireAcl(keyDir, []);
  await privateDirectory(stageParent, true);
  await exclusive(path.join(stageParent, 'initial'), async () => {
    const scratch = path.join(stageParent, '.initial-work');
    if (await stat(scratch)) {
      await privateDirectory(scratch);
      await fs.rm(scratch, { recursive: true });
    }
    await privateDirectory(scratch, true);
    try {
      const evidence = await stageReleaseFromOrigin(
        { commit: sha },
        {
          mode: current ? 'admin' : 'initial',
          approvedInitialSha: current ? undefined : sha,
          stagingRoot: scratch,
          scratchRoot: scratch,
          policy: releasePolicy('0.0.0', current),
        },
      );
      if (
        !evidence.ok ||
        evidence.sha !== sha ||
        evidence.checks !== 'pinned' ||
        (current &&
          (evidence.version !== current.version ||
            evidence.workflow.runId !== current.initialWorkflow.runId ||
            evidence.workflow.attempt !== current.initialWorkflow.attempt))
      )
        throw Error('release-verification');
      const keys = { dev };
      for (const name of sshKeys) keys[name] = await ensureKeyPair(keyDir, scratch, name);
      if (
        new Set(Object.values(keys)).size !== 3 ||
        (current && keySetSha256(keys) !== current.keySetSha256)
      )
        throw Error('owner-keys');
      await publishStage(stageParent, evidence, keys);
      process.stdout.write(initialProofSha256(sha, keySetSha256(keys), evidence.workflow) + '\n');
    } finally {
      await fs.rm(scratch, { recursive: true });
    }
  });
}

async function initializeConfig(data, source, executorUid) {
  const target = path.join(data, 'config.json');
  const journalDir = path.join(data, 'first-install');
  await privateDirectory(journalDir, true);
  await exclusive(path.join(journalDir, 'config'), async () => {
    const journal = installationJournal(journalDir, async (file) => {
      if (file !== target) throw Error('owner-config');
      await privateDirectory(data);
    });
    await journal.recover();
    if (await stat(target)) {
      await requireAcl(target, []);
      const current = parseInstalledConfig(JSON.parse(await readPrivate(target, 65536)));
      if (current.executorUid !== executorUid) throw Error('owner-config');
      return;
    }
    const config = parseInstalledConfig({ source, executorUid });
    const transfer = await journal.begin();
    try {
      await transfer.replace(
        target,
        (file) => writePrivate(file, JSON.stringify(config) + '\n'),
        (s) => {
          if (s) throw Error('owner-config');
        },
      );
      await transfer.commit();
    } finally {
      await journal.recover();
    }
  });
}

function signIn(data, sha) {
  const executor = '/Users/executor/Library/Application Support/Foliome';
  const codex = `'${system}/executor/share/${sha}/codex'`;
  const settings = `/usr/bin/env -i PATH=/usr/bin:/bin 'HOME=${executor}' 'CODEX_HOME=${executor}/codex' 'TMPDIR=${executor}/tmp'`;
  const identity = path.join(data, 'ssh/owner_ed25519');
  const knownHosts = path.join(data, 'known_hosts');
  return (
    spawnSync(
      '/usr/bin/ssh',
      [
        '-F',
        '/dev/null',
        '-T',
        '-i',
        identity,
        '-o',
        'IdentityAgent=none',
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        'UpdateHostKeys=no',
        '-o',
        'GlobalKnownHostsFile=/dev/null',
        '-o',
        `UserKnownHostsFile="${knownHosts}"`,
        '-o',
        'HostKeyAlgorithms=ssh-ed25519',
        '-o',
        'ClearAllForwardings=yes',
        '-o',
        'ConnectTimeout=5',
        'executor@127.0.0.1',
        `${settings} ${codex} login status >/dev/null 2>&1 || exec ${settings} ${codex} login --device-auth`,
      ],
      { cwd: '/', env: {}, stdio: 'inherit' },
    ).status === 0
  );
}

async function main() {
  const [mode, sha, input] = process.argv.slice(2);
  const owner = os.userInfo();
  if (
    process.platform !== 'darwin' ||
    process.arch !== 'arm64' ||
    !['stage', 'finish'].includes(mode) ||
    !shaPattern.test(sha) ||
    process.argv.length !== 5 ||
    process.execPath !== path.join(__dirname, 'node') ||
    process.execArgv.join(' ') !== '--disable-sigusr1' ||
    process.cwd() !== '/' ||
    Object.keys(process.env).length ||
    uid < 501 ||
    process.geteuid() !== uid ||
    owner.uid !== uid ||
    ['dev', 'executor'].includes(owner.username) ||
    (await fs.lstat('/dev/console')).uid !== uid
  )
    throw Error('owner-boundary');
  process.umask(0o077);
  await privateDirectory(owner.homedir);
  const { source, dev } = await readInputs(input, owner.homedir);
  const library = path.join(owner.homedir, 'Library');
  const support = path.join(library, 'Application Support');
  for (const dir of [library, support]) {
    const s = await fs.lstat(dir);
    if (!s.isDirectory() || s.uid !== uid || ![0o700, 0o755].includes(s.mode & 0o7777))
      throw Error('owner-path');
  }
  const application = path.join(support, 'Foliome');
  const data = path.join(application, 'data');
  for (const dir of [application, data]) {
    await privateDirectory(dir, mode === 'stage');
    await requireAcl(dir, []);
  }
  await rootParents('/Library/Application Support');
  let current = null;
  if (await stat(system)) {
    await rootParents(system);
    await requireAcl(system, []);
    if (await stat(path.join(system, 'installation-release.json')))
      current = await readInstallationRelease();
  }
  if (current && (current.ownerUid !== uid || current.initialSha !== sha || current.sha !== sha))
    throw Error('owner-approval');
  if (mode === 'stage') return stageInstall(data, sha, dev, current);
  if (!current) throw Error('owner-approval');
  await initializeConfig(data, source, current.executorUid);
  if (!signIn(data, sha)) throw Error('owner-sign-in');
  await rootParents(path.join(system, 'base'));
  const launch = path.join(system, 'base/launch');
  if (!fileMode(await fs.lstat(launch), 0, 0o755, 0)) throw Error('owner-boundary');
  await requireAcl(launch, []);
  if (spawnSync(launch, [], { cwd: '/', env: {}, stdio: 'inherit' }).status !== 0)
    throw Error('owner-launch');
}

module.exports = { ensureKeyPair, initializeConfig, publishStage };

if (require.main === module) {
  main().catch((error) => {
    const code =
      /^(owner-(boundary|input|keys|path|stage|approval|config|sign-in|launch)|release-verification|busy)$/.test(
        error.message,
      )
        ? error.message
        : 'first-install';
    process.stderr.write(code + '\n');
    process.exitCode = 1;
  });
}
