'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { stat } = require('./install-transaction.js');

const root = '/Library/Application Support/Foliome';
const base = path.join(root, 'base');
const ssh = '/private/etc/ssh';
const sshMain = path.join(ssh, 'sshd_config');
const sshProfile = path.join(ssh, 'sshd_config.d/000-foliome.conf');
const hostFile = path.join(ssh, 'ssh_host_ed25519_key');
const pfFile = '/private/etc/pf.anchors/foliome';
const plist = '/Library/LaunchDaemons/foliome-pf.plist';
const anchor = 'com.apple/foliome';
const executor = 'executor';
const sshService = 'system/com.openssh.sshd';
const sshJob = '/System/Library/LaunchDaemons/ssh.plist';
const shaPattern = /^[a-f0-9]{40}$/;
const privateKeyMode = 0o600;
const programs = new Set([
  '/bin/chmod',
  '/bin/launchctl',
  '/bin/ls',
  '/sbin/pfctl',
  '/usr/bin/dscl',
  '/usr/bin/id',
  '/usr/bin/perl',
  '/usr/bin/plutil',
  '/usr/bin/ssh-keygen',
  '/usr/bin/ssh-keyscan',
  '/usr/sbin/sshd',
  path.join(base, 'node'),
]);

function run(program, args, { input, limit = 65536, timeout = 10000, uid, gid, absent } = {}) {
  if (!programs.has(program)) throw Error('boundary-program');
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: '/',
      env: {},
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      timeout,
      killSignal: 'SIGKILL',
      uid,
      gid,
    });
    const output = [];
    let total = 0;
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        total += chunk.length;
        if (total > limit) child.kill('SIGKILL');
        else if (stream === child.stdout) output.push(chunk);
      });
    }
    child.once('error', () => reject(Error('boundary-program')));
    child.once('close', (code) => {
      if (code === absent && absent !== undefined && total <= limit) resolve(null);
      else if (code === 0 && total <= limit) resolve(Buffer.concat(output));
      else reject(Error('boundary-program'));
    });
    if (child.stdin) {
      child.stdin.on('error', () => child.kill('SIGKILL'));
      child.stdin.end(input);
    }
  });
}

async function output(program, args) {
  return (await run(program, args)).toString('utf8').trim();
}

async function acl(file) {
  const listing = await output('/bin/ls', ['-lde', file]);
  const entries = listing.split('\n').slice(1);
  if (entries.some((line) => !/^\s*\d+: /.test(line))) throw Error('boundary-permissions');
  return entries.map((line) => line.trim().replace(/^\d+: /, ''));
}

function fileMode(s, uid, mode, gid) {
  return (
    s?.isFile() &&
    s.nlink === 1 &&
    s.uid === uid &&
    (gid === undefined || s.gid === gid) &&
    (s.mode & 0o7777) === mode
  );
}

function dirMode(s, uid, mode, gid) {
  return (
    s?.isDirectory() &&
    s.uid === uid &&
    (gid === undefined || s.gid === gid) &&
    (s.mode & 0o7777) === mode
  );
}

async function rootParents(directory) {
  const parents = directory === '/' ? [] : directory.slice(1).split('/');
  let target = '/';
  for (const part of ['', ...parents]) {
    target = path.join(target, part);
    const s = await fs.lstat(target);
    if (
      !s.isDirectory() ||
      s.uid !== 0 ||
      s.mode & 0o7022 ||
      (await acl(target)).some((entry) => entry !== 'group:everyone deny delete')
    )
      throw Error('boundary-permissions');
  }
}

async function etcAlias() {
  const alias = await fs.lstat('/etc');
  if (
    !alias.isSymbolicLink() ||
    alias.uid !== 0 ||
    !['private/etc', '/private/etc'].includes(await fs.readlink('/etc')) ||
    (await fs.realpath('/etc')) !== '/private/etc'
  )
    throw Error('boundary-permissions');
  await rootParents('/private/etc');
}

const fixed = new Set([
  base,
  path.join(root, 'installation.json'),
  path.join(root, 'channel'),
  path.join(root, 'executor'),
  path.join(root, 'executor/root'),
  path.join(root, 'executor/root/work'),
  path.join(root, 'executor/root/launch'),
  path.join(root, 'executor/root/channel-client'),
  path.join(root, 'executor/share'),
  path.join(root, 'installation-release.json'),
  path.join(ssh, 'authorized_keys'),
  path.join(ssh, 'authorized_keys/executor'),
  path.join(ssh, 'authorized_keys/dev'),
  path.join(ssh, 'sshd_config.d'),
  sshMain,
  sshProfile,
  hostFile,
  pfFile,
  plist,
]);

function isApprovedSystemPath(target) {
  if (fixed.has(target)) return true;
  const parts = target.slice(root.length + 1).split('/');
  return (
    target.startsWith(root + '/executor/share/') &&
    shaPattern.test(parts[2]) &&
    (parts.length === 3 || (parts.length === 4 && parts[3] === 'codex'))
  );
}

async function authorize(target) {
  if (!isApprovedSystemPath(target)) throw Error('install-files');
  await rootParents(path.dirname(target));
}

async function setAcl(file, entries) {
  await run('/bin/chmod', ['-N', file]);
  for (const entry of entries) await run('/bin/chmod', ['+a', entry, file]);
  await requireAcl(file, entries);
}

async function requireAcl(file, entries) {
  if (JSON.stringify(await acl(file)) !== JSON.stringify(entries))
    throw Error('boundary-permissions');
}

function numeric(value) {
  if (!/^[1-9][0-9]{0,9}$/.test(value) || Number(value) > 0x7fffffff)
    throw Error('boundary-account');
  return Number(value);
}

async function account(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(name)) throw Error('boundary-account');
  const record = await output('/usr/bin/dscl', [
    '.',
    '-read',
    '/Users/' + name,
    'UniqueID',
    'PrimaryGroupID',
    'NFSHomeDirectory',
    'UserShell',
  ]);
  const properties = Object.fromEntries(
    record.split('\n').map((line) => {
      const [, key, value] =
        /^(UniqueID|PrimaryGroupID|NFSHomeDirectory|UserShell): (.+)$/.exec(line) ?? [];
      if (!key) throw Error('boundary-account');
      return [key, value];
    }),
  );
  if (record.split('\n').length !== 4 || Object.keys(properties).length !== 4)
    throw Error('boundary-account');
  const uid = numeric(properties.UniqueID);
  const gid = numeric(properties.PrimaryGroupID);
  const home = properties.NFSHomeDirectory;
  if (
    !/^\/Users\/[A-Za-z0-9_. -]+$/.test(home) ||
    (await output('/usr/bin/id', ['-u', name])) !== String(uid) ||
    (await output('/usr/bin/id', ['-g', name])) !== String(gid)
  )
    throw Error('boundary-account');
  return { uid, gid, home, shell: properties.UserShell, name };
}

async function profile(person) {
  await rootParents(path.dirname(person.home));
  if (
    !dirMode(await fs.lstat(person.home), person.uid, 0o700, person.gid) ||
    (await fs.realpath(person.home)) !== person.home
  )
    throw Error('boundary-account');
  // Allow macOS's stock delete-deny on a profile, never an access grant.
  const entries = await acl(person.home);
  if (entries.length && (entries.length !== 1 || entries[0] !== 'group:everyone deny delete'))
    throw Error('boundary-account');
}

async function localOwner() {
  const console = await fs.lstat('/dev/console');
  if (!console.isCharacterDevice() || console.uid < 501) throw Error('boundary-account');
  const who = await account(await output('/usr/bin/id', ['-nu', String(console.uid)]));
  if (who.uid !== console.uid || ['dev', executor].includes(who.name))
    throw Error('boundary-account');
  await profile(who);
  return who;
}

async function localExecutor(owner) {
  const agent = await account(executor);
  const groups = (await output('/usr/bin/id', ['-G', executor])).split(' ').map(numeric);
  const shell = await fs.lstat('/bin/sh');
  if (
    agent.uid === owner.uid ||
    agent.uid < 501 ||
    agent.home !== '/Users/executor' ||
    agent.shell !== '/bin/sh' ||
    agent.gid !== 20 ||
    groups.some((gid) => ![12, 20, 61, 701].includes(gid)) ||
    !fileMode(shell, 0, 0o755, 0) ||
    (await acl('/bin/sh')).length
  )
    throw Error('boundary-account');
  await profile(agent);
  if ((await output('/usr/bin/id', ['-u', 'dev'])) === String(agent.uid))
    throw Error('boundary-account');
  return agent;
}

async function readOwnerStage(home, uid, relative, mode, limit) {
  return run(
    '/usr/bin/perl',
    [
      path.join(base, 'read-release-file.pl'),
      home,
      relative,
      String(uid),
      mode.toString(8),
      String(limit),
    ],
    { limit: limit + 65536, timeout: 45000 },
  );
}

const hostPublicKey = async (file) => {
  const raw = await output('/usr/bin/ssh-keygen', ['-y', '-f', file]);
  const match = /^(ssh-ed25519 [A-Za-z0-9+/]{68})(?: [^\r\n]*)?$/.exec(raw);
  if (!match) throw Error('boundary-ssh');
  return match[1];
};

async function verifyHostKey(file) {
  if (!fileMode(await fs.lstat(file), 0, privateKeyMode, 0)) throw Error('boundary-ssh');
  await requireAcl(file, []);
  return hostPublicKey(file);
}

async function lintProfiles(sshConfig = sshMain, pfConfig = pfFile, job = plist) {
  await run('/usr/sbin/sshd', ['-t', '-f', sshConfig]);
  await run('/sbin/pfctl', ['-n', '-a', anchor, '-f', pfConfig]);
  await run('/usr/bin/plutil', ['-lint', '--', job]);
}

async function sshSnapshot() {
  await rootParents(path.dirname(sshJob));
  if (!fileMode(await fs.lstat(sshJob), 0, 0o644, 0)) throw Error('boundary-ssh');
  await requireAcl(sshJob, []);
  const recorded = await output('/bin/launchctl', ['print-disabled', 'system']);
  const entries = recorded.split('\n').filter((line) => line.includes('"com.openssh.sshd"'));
  if (entries.length > 1) throw Error('boundary-ssh');
  const override = /^\s*"com\.openssh\.sshd"\s*=>\s*(disabled|enabled|true|false)\s*$/.exec(
    entries[0],
  );
  if (entries.length && !override) throw Error('boundary-ssh');
  const defaultDisabled =
    !override &&
    (await output('/usr/bin/plutil', [
      '-extract',
      'Disabled',
      'raw',
      '-expect',
      'bool',
      '-o',
      '-',
      '--',
      sshJob,
    ]));
  if (!override && !['true', 'false'].includes(defaultDisabled)) throw Error('boundary-ssh');
  const disabled = override
    ? ['disabled', 'true'].includes(override[1])
    : defaultDisabled === 'true';
  const loaded = (await run('/bin/launchctl', ['print', sshService], { absent: 113 })) !== null;
  if (loaded && disabled) throw Error('boundary-ssh');
  return { loaded, disabled };
}

async function startSsh(previous) {
  if (previous.loaded) return;
  if (previous.disabled) await run('/bin/launchctl', ['enable', sshService]);
  await run('/bin/launchctl', ['bootstrap', 'system', sshJob]);
  if (!(await sshSnapshot()).loaded) throw Error('boundary-ssh');
}

async function restoreSsh(previous) {
  if (typeof previous?.loaded !== 'boolean' || typeof previous.disabled !== 'boolean')
    throw Error('restore-failed');
  let current = await sshSnapshot();
  if (!previous.loaded && current.loaded) await run('/bin/launchctl', ['bootout', sshService]);
  if (previous.disabled && !current.disabled) await run('/bin/launchctl', ['disable', sshService]);
  current = await sshSnapshot();
  if (current.loaded !== previous.loaded || current.disabled !== previous.disabled)
    throw Error('restore-failed');
}

async function pfSnapshot() {
  const status = await output('/sbin/pfctl', ['-s', 'info']);
  const match = /^Status: (Enabled|Disabled)\b/.exec(status);
  const main = await output('/sbin/pfctl', ['-s', 'rules']);
  if (!match || !/^anchor "com\.apple\/\*" all$/m.test(main)) throw Error('boundary-pf');
  return {
    enabled: match[1] === 'Enabled',
    rules: await output('/sbin/pfctl', ['-a', anchor, '-s', 'rules']),
  };
}

async function loadPf(file, enabled) {
  await run('/sbin/pfctl', ['-a', anchor, '-f', file]);
  if (!enabled) await run('/sbin/pfctl', ['-e']);
}

async function restorePf(snapshot) {
  if (
    typeof snapshot.enabled !== 'boolean' ||
    typeof snapshot.rules !== 'string' ||
    snapshot.rules.length > 65536
  )
    throw Error('restore-failed');
  if (snapshot.rules) {
    if (!fileMode(await fs.lstat(pfFile), 0, 0o644, 0)) throw Error('restore-failed');
    await run('/sbin/pfctl', ['-a', anchor, '-f', pfFile]);
  } else {
    await run('/sbin/pfctl', ['-a', anchor, '-f', '/dev/null']);
  }
  const current = await pfSnapshot();
  if (current.enabled && !snapshot.enabled) await run('/sbin/pfctl', ['-d']);
  if (current.rules !== snapshot.rules || (!current.enabled && snapshot.enabled))
    throw Error('restore-failed');
}

function canary() {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection({ host: '192.0.2.1', port: 49151 });
    conn.setTimeout(1000, () => {
      conn.destroy();
      reject(Error('boundary-pf'));
    });
    conn.once('connect', () => {
      conn.destroy();
      reject(Error('boundary-pf'));
    });
    conn.once('error', (error) => {
      if (error.code === 'ECONNREFUSED') resolve();
      else reject(Error('boundary-pf'));
    });
  });
}

async function checkLiveBoundary(key, agent) {
  const live = await pfSnapshot();
  if (
    !live.enabled ||
    !/^block return out quick inet proto tcp from any to 192\.0\.2\.1 port = 49151$/m.test(
      live.rules,
    )
  )
    throw Error('boundary-pf');
  await canary();
  const effective = await output('/usr/sbin/sshd', ['-T', '-f', sshMain]);
  const lines = effective.split('\n');
  for (const expected of [
    'listenaddress 127.0.0.1:22',
    'authenticationmethods publickey',
    'authorizedkeysfile /etc/ssh/authorized_keys/%u',
    'authorizedkeyscommand none',
    'permitrootlogin no',
    'passwordauthentication no',
    'kbdinteractiveauthentication no',
    'disableforwarding yes',
    'permituserenvironment no',
    'permituserrc no',
    'hostkey /etc/ssh/ssh_host_ed25519_key',
    'hostkeyalgorithms ssh-ed25519',
  ])
    if (!lines.includes(expected)) throw Error('boundary-ssh');
  const users = lines.filter((line) => line.startsWith('allowusers ')).join(' ');
  if (
    ![
      `allowusers ${agent.name}@127.0.0.1 allowusers dev@127.0.0.1`,
      `allowusers ${agent.name}@127.0.0.1 dev@127.0.0.1`,
    ].includes(users)
  )
    throw Error('boundary-ssh');
  if (
    (await output('/usr/bin/ssh-keyscan', ['-T', '3', '-t', 'ed25519', '127.0.0.1'])) !==
    '127.0.0.1 ' + key
  )
    throw Error('boundary-ssh');
  return live;
}

module.exports = {
  acl,
  authorize,
  base,
  canary,
  checkLiveBoundary,
  dirMode,
  etcAlias,
  fileMode,
  hostFile,
  lintProfiles,
  loadPf,
  localExecutor,
  localOwner,
  pfFile,
  pfSnapshot,
  plist,
  readOwnerStage,
  requireAcl,
  restorePf,
  restoreSsh,
  root,
  rootParents,
  run,
  setAcl,
  shaPattern,
  sshSnapshot,
  startSsh,
  sshProfile,
  stat,
  verifyHostKey,
};
