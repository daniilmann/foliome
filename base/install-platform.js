// @ts-check
'use strict';

const fs = require('node:fs/promises');
const { constants: fsConstants } = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { stat, syncDirectory } = require('./install-transaction.js');

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
const executorHome = '/Users/executor';
const executorShell = '/bin/sh';
const staff = 20;
const guidPattern = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/;
const uidRange = { first: 503, last: 59999 };
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
  '/usr/bin/osascript',
  '/usr/bin/perl',
  '/usr/bin/plutil',
  '/usr/bin/ssh-keygen',
  '/usr/bin/ssh-keyscan',
  '/usr/bin/sudo',
  '/usr/sbin/sshd',
  path.join(base, 'node'),
]);

/** @typedef {{input?: Buffer | string, limit?: number, timeout?: number, uid?: number,
 *             gid?: number, absent?: number, denied?: RegExp, quiet?: boolean}} RunOptions */
/** @param {string} program @param {string[]} args @param {RunOptions} [options]
 *  @returns {Promise<Buffer | null>} */
function run(
  program,
  args,
  { input, limit = 65536, timeout = 10000, uid, gid, absent, denied, quiet = false } = {},
) {
  if (!programs.has(program)) throw Error('boundary-program');
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: '/',
      env: denied ? { LC_ALL: 'C' } : {},
      stdio: [
        input === undefined ? 'ignore' : 'pipe',
        quiet ? 'ignore' : 'pipe',
        quiet ? 'ignore' : 'pipe',
      ],
      timeout,
      killSignal: 'SIGKILL',
      uid,
      gid,
    });
    /** @type {Buffer[]} */
    const output = [];
    /** @type {Buffer[]} */
    const errors = [];
    let total = 0;
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', (chunk) => {
        total += chunk.length;
        if (total > limit) child.kill('SIGKILL');
        else if (stream === child.stdout) output.push(chunk);
        else if (denied) errors.push(chunk);
      });
    }
    child.once('error', () => reject(Error('boundary-program')));
    child.once('close', (code) => {
      if (code === absent && absent !== undefined && total <= limit) resolve(null);
      else if (
        code === 1 &&
        total <= limit &&
        denied?.test(Buffer.concat([...output, ...errors]).toString('utf8'))
      )
        resolve(null);
      else if (code === 0 && total <= limit) resolve(Buffer.concat(output));
      else reject(Error('boundary-program'));
    });
    if (child.stdin) {
      child.stdin.on('error', () => child.kill('SIGKILL'));
      child.stdin.end(input);
    }
  });
}

/** @param {string} program @param {string[]} args */
async function output(program, args) {
  const bytes = await run(program, args);
  if (!bytes) throw Error('boundary-program');
  return bytes.toString('utf8').trim();
}

/** @param {string} file */
async function acl(file) {
  const listing = await output('/bin/ls', ['-lde', file]);
  const entries = listing.split('\n').slice(1);
  if (entries.some((line) => !/^\s*\d+: /.test(line))) throw Error('boundary-permissions');
  return entries.map((line) => line.trim().replace(/^\d+: /, ''));
}

/** @param {import('node:fs').Stats | null} s @param {number} uid @param {number} mode
 *  @param {number} [gid] */
function fileMode(s, uid, mode, gid) {
  return (
    s?.isFile() &&
    s.nlink === 1 &&
    s.uid === uid &&
    (gid === undefined || s.gid === gid) &&
    (s.mode & 0o7777) === mode
  );
}

/** @param {import('node:fs').Stats | null} s @param {number} uid @param {number} mode
 *  @param {number} [gid] */
function dirMode(s, uid, mode, gid) {
  return (
    s?.isDirectory() &&
    s.uid === uid &&
    (gid === undefined || s.gid === gid) &&
    (s.mode & 0o7777) === mode
  );
}

/** @param {string} directory */
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

/** @param {string} target */
function isApprovedSystemPath(target) {
  if (fixed.has(target)) return true;
  const parts = target.slice(root.length + 1).split('/');
  return (
    target.startsWith(root + '/executor/share/') &&
    shaPattern.test(parts[2]) &&
    (parts.length === 3 || (parts.length === 4 && parts[3] === 'codex'))
  );
}

/** @param {string} target */
async function authorize(target) {
  if (!isApprovedSystemPath(target)) throw Error('install-files');
  await rootParents(path.dirname(target));
}

/** @param {string} file @param {string[]} entries */
async function setAcl(file, entries) {
  await run('/bin/chmod', ['-N', file]);
  for (const entry of entries) await run('/bin/chmod', ['+a', entry, file]);
  await requireAcl(file, entries);
}

/** @param {string} file @param {string[]} entries */
async function requireAcl(file, entries) {
  if (JSON.stringify(await acl(file)) !== JSON.stringify(entries))
    throw Error('boundary-permissions');
}

/** @param {string} value */
function numeric(value) {
  if (!/^[1-9][0-9]{0,9}$/.test(value) || Number(value) > 0x7fffffff)
    throw Error('boundary-account');
  return Number(value);
}

/** @param {string} record @param {string[]} required @param {string[]} [optional] */
function accountAttributes(record, required, optional = []) {
  const properties = /** @type {Record<string, string>} */ (Object.create(null));
  for (const line of record.split('\n')) {
    const [, label, value] = /^(dsAttrTypeNative:IsHidden|[A-Za-z]+): (.+)$/.exec(line) ?? [];
    const key = label === 'dsAttrTypeNative:IsHidden' ? 'IsHidden' : label;
    if ((!required.includes(key) && !optional.includes(key)) || Object.hasOwn(properties, key))
      throw Error('boundary-account');
    properties[key] = value;
  }
  if (required.some((key) => !Object.hasOwn(properties, key))) throw Error('boundary-account');
  return properties;
}

/** @param {string} name @param {boolean} [agent] */
async function account(name, agent = false) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(name)) throw Error('boundary-account');
  const attributes = ['UniqueID', 'PrimaryGroupID', 'NFSHomeDirectory', 'UserShell'];
  if (agent) attributes.push('RecordName', 'GeneratedUID', 'IsHidden');
  const record = await output('/usr/bin/dscl', ['.', '-read', '/Users/' + name, ...attributes]);
  const properties = accountAttributes(record, attributes);
  if (
    agent &&
    (properties.RecordName !== executor ||
      properties.IsHidden !== '1' ||
      !guidPattern.test(properties.GeneratedUID))
  )
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
  return { uid, gid, home, shell: properties.UserShell, name, guid: properties.GeneratedUID };
}

/** @param {{home: string, uid: number, gid: number}} person */
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

/** @param {number} uid */
function localUid(uid) {
  return output('/usr/bin/dscl', ['.', '-search', '/Users', 'UniqueID', String(uid)]);
}

/** @param {string} name */
async function userExists(name) {
  return (await run('/usr/bin/id', ['-u', name], { absent: 1 })) !== null;
}

async function executorExists() {
  return (
    (await output('/usr/bin/dscl', ['.', '-search', '/Users', 'RecordName', executor])) !== '' ||
    (await userExists(executor))
  );
}

/** @param {string} name @param {number} gid @param {typeof output} read */
async function requireUniqueGroup(name, gid, read) {
  const expected = name + '\t\tPrimaryGroupID = (\n    ' + gid + '\n)';
  for (const node of ['.', '/Search']) {
    if (
      (await read('/usr/bin/dscl', [node, '-search', '/Groups', 'PrimaryGroupID', String(gid)])) !==
      expected
    )
      throw Error('boundary-account');
  }
}

/**
 * macOS reports these groups even for a non-admin local account.
 * Verify the directory records rather than treating their GIDs as sufficient.
 * @param {string} effective @param {string} guid @param {typeof output} [read]
 */
async function checkExecutorGroups(effective, guid, read = output) {
  const groups = effective.split(' ').map(numeric);
  if (groups.some((gid) => ![12, 20, 61, 100, 399, 701, 702].includes(gid)))
    throw Error('boundary-account');

  const fields = ['RecordName', 'PrimaryGroupID'];
  if (groups.includes(399)) {
    await requireUniqueGroup('com.apple.access_ssh', 399, read);
    const required = [...fields, 'GroupMembership', 'GroupMembers'];
    const sshGroup = accountAttributes(
      await read('/usr/bin/dscl', ['.', '-read', '/Groups/com.apple.access_ssh', ...required]),
      required,
    );
    if (
      sshGroup.RecordName !== 'com.apple.access_ssh' ||
      sshGroup.PrimaryGroupID !== '399' ||
      !sshGroup.GroupMembership.split(' ').includes(executor) ||
      !sshGroup.GroupMembers.split(' ').includes(guid)
    )
      throw Error('boundary-account');
  }

  // OpenDirectory assigns these fixed GUIDs to its well-known built-in groups.
  const builtIn = (/** @type {string} */ suffix) => 'ABCDEFAB-CDEF-ABCD-EFAB-CDEF000000' + suffix;
  for (const { gid, name, parents } of [
    { gid: 100, name: '_lpoperator', parents: [builtIn('3D'), builtIn('62')] },
    { gid: 702, name: 'com.apple.sharepoint.group.2', parents: [builtIn('0C')] },
  ]) {
    if (!groups.includes(gid)) continue;
    await requireUniqueGroup(name, gid, read);
    const required = [...fields, 'NestedGroups'];
    const ownMembers = ['GroupMembership', 'GroupMembers'];
    const inherited = accountAttributes(
      await read('/usr/bin/dscl', ['.', '-read', '/Groups/' + name, ...required, ...ownMembers]),
      required,
      ownMembers,
    );
    if (
      inherited.RecordName !== name ||
      inherited.PrimaryGroupID !== String(gid) ||
      ownMembers.some((key) => Object.hasOwn(inherited, key)) ||
      inherited.NestedGroups.split(' ').sort().join(' ') !== parents.join(' ')
    )
      throw Error('boundary-account');
  }
}

/** @param {{uid: number}} owner */
async function executorIdentity(owner) {
  const agent = await account(executor, true);
  await checkExecutorGroups(await output('/usr/bin/id', ['-G', executor]), agent.guid);
  const shell = await fs.lstat(executorShell);
  if (
    agent.uid === owner.uid ||
    agent.uid < 501 ||
    agent.home !== executorHome ||
    agent.shell !== executorShell ||
    agent.gid !== staff ||
    (await output('/usr/bin/dscl', ['.', '-read', '/Groups/staff', 'PrimaryGroupID'])) !==
      'PrimaryGroupID: 20' ||
    (await localUid(agent.uid)) !== executor + '\t\tUniqueID = (\n    ' + agent.uid + '\n)' ||
    !fileMode(shell, 0, 0o755, 0) ||
    (await acl(executorShell)).length ||
    (await output('/usr/bin/id', ['-u', 'dev'])) === String(agent.uid) ||
    (await run('/usr/bin/sudo', ['-n', '-l', '-U', executor], {
      denied: /^User executor is not allowed to run sudo on [A-Za-z0-9_.-]+\.\n?$/,
    })) !== null
  )
    throw Error('boundary-account');
  return agent;
}

/** @param {{uid: number}} owner */
async function localExecutor(owner) {
  const agent = await executorIdentity(owner);
  await profile(agent);
  return agent;
}

// OpenDirectory creates the entire record with the recorded GUID and refuses a
// duplicate name. A sequence of dscl -create calls can overwrite attributes.
const accountScript = String.raw`
ObjC.import('Foundation');
ObjC.import('OpenDirectory');
function run(args) {
  const fail = () => { throw Error('boundary-account'); };
  const raw = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const data = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(raw, $.NSUTF8StringEncoding)));
  const { uid, guid, password } = data;
  if (!Number.isInteger(uid) || uid < 503 || uid > 59999 ||
      !/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(guid)) fail();
  const error = Ref();
  const node = $.ODNode.nodeWithSessionNameError($.ODSession.defaultSession, '/Local/Default', error);
  if (node.isNil()) fail();
  const users = 'dsRecTypeStandard:Users';
  const fields = {
    'dsAttrTypeStandard:RecordName': ['executor'],
    'dsAttrTypeStandard:GeneratedUID': [guid],
    'dsAttrTypeStandard:UniqueID': [String(uid)],
    'dsAttrTypeStandard:PrimaryGroupID': ['20'],
    'dsAttrTypeStandard:NFSHomeDirectory': ['/Users/executor'],
    'dsAttrTypeStandard:UserShell': ['/bin/sh'],
    'dsAttrTypeNative:IsHidden': ['1'],
  };
  if (args[0] === 'create') {
    // An invalid crypt value keeps the record unusable before password setup.
    fields['dsAttrTypeStandard:Password'] = ['*'];
    if (node.createRecordWithRecordTypeNameAttributesError(users, 'executor', fields, error).isNil())
      fail();
  } else if (args[0] === 'password' && /^Aa0![a-f0-9]{64}$/.test(password)) {
    const record = node.recordWithRecordTypeNameAttributesError(users, 'executor', Object.keys(fields), error);
    if (record.isNil() || Object.entries(fields).some(([key, [value]]) => {
      const values = ObjC.deepUnwrap(record.valuesForAttributeError(key, error));
      return !Array.isArray(values) || values.length !== 1 || values[0] !== value;
    })) fail();
    if (!record.changePasswordToPasswordError(null, password, error) ||
        !record.verifyPasswordError(password, error)) fail();
  } else fail();
}
`;

// renamex_np(RENAME_EXCL) publishes only into a vacant name, even if an empty
// directory appears between the installer's checks and the rename.
const homeScript = String.raw`
ObjC.import('Foundation');
ObjC.bindFunction('renamex_np', ['int', ['char *', 'char *', 'unsigned int']]);
function run([guid]) {
  if (!/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(guid) ||
      $.renamex_np('/Users/.foliome-executor-' + guid, '/Users/executor', 4) !== 0)
    throw Error('boundary-account');
}
`;

const swapScript = String.raw`
ObjC.import('Foundation');
ObjC.bindFunction('renamex_np', ['int', ['char *', 'char *', 'unsigned int']]);
function run([target, staged]) {
  if ($.renamex_np(target, staged, 2) !== 0) throw Error('install-files');
}
`;

/** @param {string} target @param {string} staged */
async function swapDirectories(target, staged) {
  if (path.dirname(target) !== path.dirname(staged)) throw Error('install-files');
  await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', swapScript, target, staged]);
}

/** @typedef {{uid: number, guid: string}} AccountIdentity */
/** @typedef {Awaited<ReturnType<typeof localExecutor>>} LocalExecutor */
/** @typedef {{sha: string, ownerUid: number, uid: number, guid: string, passwordSet: boolean,
 *           home: {dev: string, ino: string} | null}} ExecutorProgress */
/** @typedef {{
 *   exists: typeof executorExists,
 *   available: (uid: number) => Promise<boolean>,
 *   identity: typeof executorIdentity,
 *   validate: typeof localExecutor,
 *   create: (identity: AccountIdentity) => Promise<unknown>,
 *   password: (identity: AccountIdentity) => Promise<unknown>,
 *   publishHome: (guid: string) => Promise<unknown>,
 *   ownHome: (file: import('node:fs/promises').FileHandle, uid: number, gid: number) => Promise<void>,
 *   checkParents: typeof rootParents,
 *   checkAcl: typeof requireAcl,
 * }} ExecutorEffects */

/** @param {'create' | 'password'} operation @param {AccountIdentity} identity */
async function changeExecutor(operation, { uid, guid }) {
  const data = Buffer.from(
    JSON.stringify({
      uid,
      guid,
      ...(operation === 'password' && { password: 'Aa0!' + randomBytes(32).toString('hex') }),
    }),
  );
  try {
    await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', accountScript, operation], {
      input: data,
      quiet: true,
    });
  } finally {
    data.fill(0);
  }
}

/** @type {ExecutorEffects} */
const executorEffects = {
  exists: executorExists,
  available: async (uid) => (await localUid(uid)) === '' && !(await userExists(String(uid))),
  identity: executorIdentity,
  validate: localExecutor,
  create: (identity) => changeExecutor('create', identity),
  password: (identity) => changeExecutor('password', identity),
  publishHome: (guid) =>
    run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', homeScript, guid], { quiet: true }),
  ownHome: (file, uid, gid) => file.chown(uid, gid),
  checkParents: rootParents,
  checkAcl: requireAcl,
};

/**
 * Called under the installation lease after the administrator-approved SHA
 * is verified. The root file transaction is restored independently; this
 * record allows forward recovery of the same account without resetting an
 * existing user's account or recursively removing anything in their profile.
 * @param {string} directory
 * @param {{effects?: ExecutorEffects, home?: string, uid?: number, gid?: number,
 *          staffGid?: number}} [fixture]
 */
function executorInstaller(
  directory,
  { effects = executorEffects, home = executorHome, uid = 0, gid = 0, staffGid = staff } = {},
) {
  const record = path.join(directory, 'executor-progress.json');
  const next = path.join(directory, 'executor-progress.next');
  const users = path.dirname(home);
  const fail = () => {
    throw Error('boundary-account');
  };

  /** @returns {Promise<ExecutorProgress | null>} */
  async function progress() {
    const s = await stat(record);
    if (!s) return null;
    if (!fileMode(s, uid, 0o600, gid) || s.size > 1024) fail();
    await effects.checkAcl(record, []);
    const value = /** @type {ExecutorProgress | null} */ (
      JSON.parse(await fs.readFile(record, 'utf8'))
    );
    if (
      !value ||
      typeof value.sha !== 'string' ||
      !shaPattern.test(value.sha) ||
      !Number.isInteger(value.ownerUid) ||
      value.ownerUid < 501 ||
      !Number.isInteger(value.uid) ||
      value.uid < uidRange.first ||
      value.uid > uidRange.last ||
      value.uid === value.ownerUid ||
      typeof value.guid !== 'string' ||
      !guidPattern.test(value.guid) ||
      typeof value.passwordSet !== 'boolean' ||
      (value.home !== null &&
        (!value.passwordSet ||
          typeof value.home?.dev !== 'string' ||
          typeof value.home.ino !== 'string' ||
          !/^[0-9]{1,20}$/.test(value.home.dev) ||
          !/^[0-9]{1,20}$/.test(value.home.ino)))
    )
      fail();
    return value;
  }

  /** @param {ExecutorProgress} value */
  async function save(value) {
    await fs.rm(next, { force: true });
    const file = await fs.open(next, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.rename(next, record);
    await syncDirectory(directory);
  }

  /** @param {string} target */
  async function homeEntry(target) {
    try {
      return await fs.lstat(target, { bigint: true });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  /** @param {Awaited<ReturnType<typeof homeEntry>>} s @param {ExecutorProgress} value */
  function sameHome(s, value) {
    return (
      s?.isDirectory() &&
      s.dev.toString() === value.home?.dev &&
      s.ino.toString() === value.home.ino
    );
  }

  /** @param {ExecutorProgress} value @param {LocalExecutor} agent */
  function match(value, agent) {
    if (value.uid !== agent.uid || value.guid !== agent.guid) fail();
  }

  /** @param {ExecutorProgress} value */
  async function prepareHome(value) {
    const stage = path.join(users, '.foliome-executor-' + value.guid);
    let existing = await homeEntry(home);
    if (!existing) {
      if (!value.home) {
        try {
          await fs.mkdir(stage, { mode: 0o700 });
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        }
        const staged = await fs.lstat(stage, { bigint: true });
        if (
          !staged.isDirectory() ||
          staged.uid !== BigInt(uid) ||
          (staged.mode & 0o7777n) !== 0o700n ||
          (await fs.readdir(stage)).length !== 0
        )
          fail();
        await effects.checkAcl(stage, []);
        await syncDirectory(users);
        value.home = { dev: staged.dev.toString(), ino: staged.ino.toString() };
        await save(value);
      }
      if (!sameHome(await homeEntry(stage), value)) fail();
      await effects.publishHome(value.guid);
      await syncDirectory(users);
      existing = await homeEntry(home);
    }
    if (!existing || !sameHome(existing, value)) throw Error('boundary-account');
    if (existing.uid === BigInt(uid)) {
      const handle = await fs.open(
        home,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
      try {
        if (!sameHome(await handle.stat({ bigint: true }), value)) fail();
        await effects.checkAcl(home, []);
        await handle.chmod(0o700);
        await effects.ownHome(handle, value.uid, staffGid);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }

  return {
    /** @param {string} sha @param {{uid: number}} owner */
    async prepare(sha, owner) {
      if (!shaPattern.test(sha) || !Number.isInteger(owner.uid) || owner.uid < 501) fail();
      await effects.checkParents(users);
      let value = await progress();
      const exists = await effects.exists();
      if (!value && exists) return effects.validate(owner);
      if (!value) {
        if (await homeEntry(home)) fail();
        let candidate = uidRange.first;
        while (
          candidate <= uidRange.last &&
          (candidate === owner.uid || !(await effects.available(candidate)))
        )
          candidate++;
        if (candidate > uidRange.last) fail();
        value = {
          sha,
          ownerUid: owner.uid,
          uid: candidate,
          guid: randomUUID().toUpperCase(),
          passwordSet: false,
          home: null,
        };
        await save(value);
      }
      if (value.sha !== sha || value.ownerUid !== owner.uid) fail();
      const existing = await homeEntry(home);
      if (existing && !sameHome(existing, value)) fail();
      if (!exists && !(await effects.exists())) {
        if (value.passwordSet || !(await effects.available(value.uid))) fail();
        await effects.create(value);
      }
      match(value, await effects.identity(owner));
      if (!value.passwordSet) {
        await effects.password(value);
        value.passwordSet = true;
        await save(value);
      }
      await prepareHome(value);
      const agent = await effects.validate(owner);
      match(value, agent);
      if (!sameHome(await homeEntry(home), value)) fail();
      return agent;
    },
    /** @param {{initialSha: string, ownerUid: number}} current @param {LocalExecutor} agent */
    async finish(current, agent) {
      const value = await progress();
      if (!value) return;
      if (
        value.sha !== current.initialSha ||
        value.ownerUid !== current.ownerUid ||
        !value.passwordSet ||
        !sameHome(await homeEntry(home), value)
      )
        fail();
      match(value, agent);
      await fs.unlink(record);
      await syncDirectory(directory);
    },
  };
}

/** @param {string} home @param {number} uid @param {string} relative
 *  @param {number} mode @param {number} limit */
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

/** @param {string} file */
const hostPublicKey = async (file) => {
  const raw = await output('/usr/bin/ssh-keygen', ['-y', '-f', file]);
  const match = /^(ssh-ed25519 [A-Za-z0-9+/]{68})(?: [^\r\n]*)?$/.exec(raw);
  if (!match) throw Error('boundary-ssh');
  return match[1];
};

/** @param {string} file */
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
  const defaultDisabled = override
    ? ''
    : await output('/usr/bin/plutil', [
        '-extract',
        'Disabled',
        'raw',
        '-expect',
        'bool',
        '-o',
        '-',
        '--',
        sshJob,
      ]);
  if (!override && !['true', 'false'].includes(defaultDisabled)) throw Error('boundary-ssh');
  const disabled = override
    ? ['disabled', 'true'].includes(override[1])
    : defaultDisabled === 'true';
  const loaded = (await run('/bin/launchctl', ['print', sshService], { absent: 113 })) !== null;
  if (loaded && disabled) throw Error('boundary-ssh');
  return { loaded, disabled };
}

/** @param {Awaited<ReturnType<typeof sshSnapshot>>} previous */
async function startSsh(previous) {
  if (previous.loaded) return;
  if (previous.disabled) await run('/bin/launchctl', ['enable', sshService]);
  await run('/bin/launchctl', ['bootstrap', 'system', sshJob]);
  if (!(await sshSnapshot()).loaded) throw Error('boundary-ssh');
}

/** @param {Awaited<ReturnType<typeof sshSnapshot>>} previous */
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

/** @param {string} file @param {boolean} enabled */
async function loadPf(file, enabled) {
  await run('/sbin/pfctl', ['-a', anchor, '-f', file]);
  if (!enabled) await run('/sbin/pfctl', ['-e']);
}

/** @param {Awaited<ReturnType<typeof pfSnapshot>>} snapshot */
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

/** @returns {Promise<void>} */
function canary() {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection({ host: '192.0.2.1', port: 49151 });
    conn.setTimeout(1000, () => {
      conn.destroy();
      reject(Error('boundary-pf'));
    });
    conn.once('connect', () => {
      conn.destroy();
      reject(Error('boundary-refused'));
    });
    conn.once('error', (error) => {
      if ('code' in error && error.code === 'ECONNREFUSED') resolve();
      else reject(Error('boundary-pf'));
    });
  });
}

/** @param {string} key @param {{name: string}} agent */
async function checkLiveBoundary(key, agent) {
  const live = await pfSnapshot();
  if (
    !live.enabled ||
    !/^block return out quick inet proto tcp from any to 192\.0\.2\.1 port = 49151$/m.test(
      live.rules,
    )
  )
    throw Error('boundary-refused');
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
    if (!lines.includes(expected)) throw Error('boundary-refused');
  const users = lines.filter((line) => line.startsWith('allowusers ')).join(' ');
  if (
    ![
      `allowusers ${agent.name}@127.0.0.1 allowusers dev@127.0.0.1`,
      `allowusers ${agent.name}@127.0.0.1 dev@127.0.0.1`,
    ].includes(users)
  )
    throw Error('boundary-refused');
  if (
    (await output('/usr/bin/ssh-keyscan', ['-T', '3', '-t', 'ed25519', '127.0.0.1'])) !==
    '127.0.0.1 ' + key
  )
    throw Error('boundary-refused');
  return live;
}

module.exports = {
  accountAttributes,
  checkExecutorGroups,
  swapDirectories,
  acl,
  authorize,
  base,
  canary,
  checkLiveBoundary,
  dirMode,
  etcAlias,
  executorInstaller,
  fileMode,
  guidPattern,
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
