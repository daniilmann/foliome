'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { serialize } = require('node:v8');
const { exclusive } = require('./activation-state.js');
const { installationJournal, syncDirectory } = require('./install-transaction.js');
const { planInstalledSystemInstall } = require('./system-install-layout.js');
const { stageReleaseFromOrigin } = require('./release-pipeline.js');
const {
  encodeInstallationRelease,
  initialProofSha256,
  keySetSha256,
  readInstallationRelease,
  releasePolicy,
} = require('./installation-release.js');
const { verifiedRuntime } = require('./publisher-verification.js');
const { materializeForInstaller } = require('./release-materialization.js');
const {
  authorize,
  base,
  checkLiveBoundary,
  dirMode,
  etcAlias,
  executorInstaller,
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
} = require('./install-platform.js');

const authority = path.join(root, 'installation-release.json');
const admin = path.join(root, '.install');
const node = path.join(base, 'node');
const sshDirectory = path.dirname(sshProfile);
const packages = ['node', 'codex', 'playwrightCore'];
const directoryFor = (home) => path.join(home, 'Library/Application Support/Foliome');
const maxArtifact = 256 * 1024 * 1024;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const trustedNames = [
  'activation-state.js',
  'first-install.js',
  'installation-release.js',
  'install-owner.js',
  'install-platform.js',
  'install-production.js',
  'install-root.js',
  'install-transaction.js',
  'launch',
  'launcher.js',
  'publisher-verification.js',
  'read-release-file.pl',
  'release-materialization.js',
  'release-observation.js',
  'release-origin.js',
  'release-pipeline.js',
  'system-install-layout.js',
];
const trustedSource = new Map(trustedNames.map((file) => ['base/' + file, path.join(base, file)]));
trustedSource.set('base/bootstrap-root.pl', path.join(root, 'bootstrap-root.pl'));
trustedSource.set('core/domain/release.ts', path.join(base, 'release-policy.ts'));
trustedSource.set('core/domain/installed-config.ts', path.join(base, 'installed-config.ts'));

async function trustedFile(file, mode) {
  if (!fileMode(await fs.lstat(file), 0, mode, 0)) throw Error('boundary-base');
  await requireAcl(file, []);
}

async function observe(sha, current, scratch, owner, initialInstall) {
  const selectedVersion = current?.sha === sha ? '0.0.0' : (current?.version ?? '0.0.0');
  const evidence = await stageReleaseFromOrigin(
    { commit: sha },
    {
      mode: current ? 'admin' : 'initial',
      approvedInitialSha: current ? undefined : sha,
      stagingRoot: scratch,
      scratchRoot: scratch,
      policy: releasePolicy(selectedVersion, current),
    },
  );
  if (!evidence.ok || evidence.sha !== sha) throw Error('release-verification');
  if (
    current?.initialSha === sha &&
    (evidence.checks !== 'pinned' ||
      evidence.workflow.runId !== current.initialWorkflow.runId ||
      evidence.workflow.attempt !== current.initialWorkflow.attempt)
  )
    throw Error('release-verification');

  const prefix = 'Library/Application Support/Foliome/data/install-staging/' + sha + '/';
  const get = (relative, mode, limit) =>
    readOwnerStage(owner.home, owner.uid, prefix + relative, mode, limit);
  const accepted = await fs.mkdtemp(path.join(scratch, 'accepted-'));
  const observed = new Map(evidence.tree.map((entry) => [entry.path, entry]));
  const sourceNames = evidence.tree.filter((entry) => entry.path.toLowerCase().startsWith('base/'));
  if (sourceNames.some((entry) => !trustedSource.has(entry.path))) throw Error('boundary-base');
  let replacesBase = false;
  for (const [name, installed] of trustedSource) {
    const entry = observed.get(name);
    await trustedFile(installed, name === 'base/launch' ? 0o755 : 0o644);
    if (!entry || entry.mode !== '100644') throw Error('boundary-base');
    if (hash(await fs.readFile(installed)) !== entry.sha256) {
      // The dispatcher is a separate trust anchor, installed by the administrator.
      if (name === 'base/bootstrap-root.pl') throw Error('boundary-base');
      replacesBase = true;
    }
  }
  for (const { path: relative, sha256: expected, mode } of evidence.tree) {
    const privateMode = mode === '100755' ? 0o700 : 0o600;
    const bytes = await get(relative, initialInstall ? 0o600 : privateMode, 8 * 1024 * 1024);
    if (hash(bytes) !== expected) throw Error('release-stage');
    const target = path.join(accepted, relative);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, bytes, { flag: 'wx', mode: privateMode });
  }

  await fs.mkdir(path.join(accepted, '.release-artifacts'), { mode: 0o700 });
  for (const name of packages) {
    const relative = '.release-artifacts/' + name;
    const bytes = await get(relative, 0o600, maxArtifact);
    const observedBytes = await fs.readFile(path.join(evidence.stagingDir, relative));
    if (!bytes.equals(observedBytes)) throw Error('release-stage');
    await fs.writeFile(path.join(accepted, relative), bytes, { flag: 'wx', mode: 0o600 });
  }
  const keys = Object.fromEntries(
    await Promise.all(
      ['owner', 'launch', 'dev'].map(async (name) => {
        const key = (await get('.install-keys/' + name + '.pub', 0o600, 256)).toString('utf8');
        if (!/^ssh-ed25519 [A-Za-z0-9+/]{68}\n?$/.test(key)) throw Error('release-stage');
        return [name, key.trimEnd()];
      }),
    ),
  );
  const manifest = JSON.parse(
    await fs.readFile(path.join(accepted, 'release/manifest.json'), 'utf8'),
  );
  if (
    manifest.version !== evidence.version ||
    (current?.sha === sha && manifest.version !== current.version)
  )
    throw Error('release-verification');
  return { stage: { ...evidence, stagingDir: accepted }, keys, manifest, replacesBase };
}

async function approvedState() {
  if (!(await stat(authority))) return null;
  return readInstallationRelease();
}

async function requireInitialApproval(sha) {
  const target = path.join(root, '.initial-approval');
  await trustedFile(target, 0o600);
  if ((await fs.lstat(target)).size !== 106) throw Error('boundary-state');
  const approved = /^([a-f0-9]{40}) ([a-f0-9]{64})\n$/.exec(await fs.readFile(target, 'utf8'));
  if (!approved || approved[1] !== sha) throw Error('boundary-state');
  return approved[2];
}

async function systemDirectory(tx, { path: target, uid, gid, mode, acl }) {
  await authorize(target);
  const existing = await stat(target);
  if (existing) {
    if (!dirMode(existing, uid, mode, gid)) throw Error('boundary-permissions');
    await requireAcl(target, acl);
    return;
  }
  await tx.replace(
    target,
    async (temp) => {
      await fs.mkdir(temp, { mode: 0o700 });
      await fs.chown(temp, uid, gid);
      await fs.chmod(temp, mode);
      await setAcl(temp, acl);
    },
    (s) => {
      if (s) throw Error('boundary-permissions');
    },
    true,
  );
}

async function systemFile(tx, { path: target, mode, content, acl = [] }) {
  await tx.replace(
    target,
    async (temp) => {
      const handle = await fs.open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(content);
        await handle.chown(0, 0);
        await handle.chmod(mode);
        await setAcl(temp, acl);
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    (s) => {
      if (s && (!s.isFile() || s.nlink !== 1 || s.uid !== 0 || s.gid !== 0 || s.mode & 0o7022))
        throw Error('boundary-permissions');
    },
  );
}

async function planFor(selected, owner, agent, scratch) {
  let newHostKey;
  let privateHost = hostFile;
  await authorize(hostFile);
  if (!(await stat(hostFile))) {
    privateHost = path.join(scratch, 'host');
    await run('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', privateHost]);
    newHostKey = await fs.readFile(privateHost);
  }
  const host = await verifyHostKey(privateHost);
  const result = planInstalledSystemInstall({
    owner,
    agent,
    keys: { ...selected.keys, host },
    sha: selected.stage.sha,
    runtime: { node: selected.manifest.node.version, codex: selected.manifest.codex.version },
  });
  if (!result.ok) throw Error('boundary-config');
  const { plan } = result;
  if (
    plan.paths.base !== base ||
    plan.paths.node !== node ||
    plan.paths.hostKey !== hostFile ||
    plan.paths.codex !== path.join(root, 'executor/share', selected.stage.sha, 'codex') ||
    plan.paths.release !==
      path.join(directoryFor(owner.home), 'app/releases', selected.stage.sha) ||
    plan.verification.version.node !== selected.manifest.node.version ||
    plan.verification.version.codex !== selected.manifest.codex.version
  )
    throw Error('boundary-config');
  const ownerData = path.join(directoryFor(owner.home), 'data');
  const settings = ['ssh_config', 'known_hosts'].map((name) => {
    const file = plan.files.find((candidate) => candidate.path === path.join(ownerData, name));
    if (!file || file.uid !== owner.uid || file.mode !== 0o600 || file.acl)
      throw Error('boundary-config');
    return file.content;
  });
  const sshRule = plan.files.find((file) => file.path === sshProfile);
  const pf = plan.files.find((file) => file.path === pfFile);
  const task = plan.files.find((file) => file.path === plist);
  if (!sshRule || !pf || !task) throw Error('boundary-config');
  return { plan, settings, host, newHostKey, pf, task };
}

async function replaceTrustedBase(tx, selected, executable) {
  async function put(file, bytes, mode) {
    const handle = await fs.open(file, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.chown(0, 0);
      await handle.chmod(mode);
      await setAcl(file, []);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  await tx.replace(
    base,
    async (temp) => {
      await fs.mkdir(temp, { mode: 0o700 });
      for (const [source, destination] of trustedSource) {
        if (path.dirname(destination) !== base) continue;
        await put(
          path.join(temp, path.basename(destination)),
          await fs.readFile(path.join(selected.stage.stagingDir, source)),
          source === 'base/launch' ? 0o755 : 0o644,
        );
      }
      await put(path.join(temp, 'node'), executable, 0o755);
      await put(path.join(temp, 'node.sha256'), hash(executable) + '\n', 0o600);
      await fs.chown(temp, 0, 0);
      await fs.chmod(temp, 0o755);
      await setAcl(temp, []);
      await syncDirectory(temp);
    },
    async (entry) => {
      if (!dirMode(entry, 0, 0o755, 0)) throw Error('boundary-base');
      await requireAcl(base, []);
    },
    true,
    true,
  );
}

async function restoreExternal({ pf, ssh }) {
  await restoreSsh(ssh);
  await restorePf(pf);
}

async function ownerPayload(materialized, settings) {
  const files = [];
  for (const { path: relative, sha256: expected, mode } of materialized.inventory) {
    const bytes = await fs.readFile(path.join(materialized.releaseDir, relative));
    if (hash(bytes) !== expected) throw Error('release-stage');
    files.push({ path: relative, mode: mode === '100755' ? 0o700 : 0o600, hash: expected, bytes });
  }
  return serialize({ files, settings });
}

async function asUser(person, mode, sha, input) {
  await run(node, ['--disable-sigusr1', path.join(base, 'install-owner.js'), mode, sha], {
    uid: person.uid,
    gid: person.gid,
    input,
    timeout: 120000,
  });
}

async function checkInstalled(plan, host, agent) {
  await lintProfiles();
  for (const file of plan.files.filter((item) => item.uid === 0)) {
    await authorize(file.path);
    if (
      !fileMode(await fs.lstat(file.path), 0, file.mode, 0) ||
      !(await fs.readFile(file.path)).equals(Buffer.from(file.content))
    )
      throw Error('boundary-permissions');
    await requireAcl(file.path, file.acl ?? []);
  }
  if ((await verifyHostKey(hostFile)) !== host) throw Error('boundary-ssh');
  return checkLiveBoundary(host, agent);
}

async function apply(sha, initialInstall, scratch, journal, accounts) {
  const owner = await localOwner();
  const current = await approvedState();
  if (!current && (await stat(path.join(root, 'installation.json')))) throw Error('boundary-state');
  if (current && current.ownerUid !== owner.uid) throw Error('boundary-account');
  if (
    (!current && !initialInstall) ||
    (initialInstall && current && (current.sha !== sha || current.initialSha !== sha))
  )
    throw Error('boundary-state');
  const initialProof = initialInstall ? await requireInitialApproval(sha) : null;
  async function verifiedExecutor(expected) {
    const agent = await localExecutor(owner);
    if (agent.uid !== expected.uid || agent.guid !== expected.guid) throw Error('boundary-account');
    return agent;
  }
  const existing =
    current && (await verifiedExecutor({ uid: current.executorUid, guid: current.executorGuid }));
  if (existing) await accounts.finish(current, existing);

  const selected = await observe(sha, current, scratch, owner, initialInstall);
  const keyDigest = keySetSha256(selected.keys);
  if (
    (initialProof &&
      initialProofSha256(sha, keyDigest, selected.stage.workflow) !== initialProof) ||
    (current && keyDigest !== current.keySetSha256)
  )
    throw Error('release-stage');
  const runtime = {};
  for (const name of ['node', 'codex']) {
    const archive = await fs.readFile(
      path.join(selected.stage.stagingDir, '.release-artifacts', name),
    );
    runtime[name] = await verifiedRuntime(archive, name, selected.manifest[name], scratch);
  }
  const replaceBase = selected.replacesBase || !(await fs.readFile(node)).equals(runtime.node);
  if (replaceBase && (!current || selected.manifest.baseChange !== true))
    throw Error('boundary-base');

  const materializedRoot = await fs.mkdtemp(path.join(scratch, 'materialized-'));
  const materialized = await materializeForInstaller({
    stage: selected.stage,
    approval: sha,
    releasesRoot: materializedRoot,
  });
  if (!materialized.ok) throw Error('release-materialization');
  const lastPf = await pfSnapshot();
  const lastSsh = await sshSnapshot();
  if (
    lastPf.rules &&
    (!current ||
      current.pfRules !== lastPf.rules ||
      !fileMode(await fs.lstat(pfFile), 0, 0o644, 0) ||
      hash(await fs.readFile(pfFile)) !== current.pfDigest)
  )
    throw Error('boundary-pf');
  const agent = existing ?? (await accounts.prepare(selected.stage.sha, owner));
  const { plan, settings, host, newHostKey, pf, task } = await planFor(
    selected,
    owner,
    agent,
    scratch,
  );
  const payload = await ownerPayload(materialized, settings);
  await fs.writeFile(path.join(scratch, 'pf'), pf.content, { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(scratch, 'plist'), task.content, { flag: 'wx', mode: 0o600 });
  await run('/sbin/pfctl', ['-n', '-a', 'com.apple/foliome', '-f', path.join(scratch, 'pf')]);
  await run('/usr/bin/plutil', ['-lint', '--', path.join(scratch, 'plist')]);

  const tx = await journal.begin();
  try {
    for (const item of plan.directories) {
      if (
        item.path === root ||
        item.path === base ||
        item.path.startsWith(directoryFor(owner.home) + '/') ||
        item.path === directoryFor(owner.home) ||
        item.path.startsWith(directoryFor(agent.home) + '/') ||
        item.path === directoryFor(agent.home)
      )
        continue;
      const channel = item.path === path.join(root, 'channel');
      if (
        channel
          ? item.uid !== owner.uid ||
            item.mode !== 0o700 ||
            item.acl.join(',') !== 'user:executor allow search'
          : item.uid !== 0 || item.gid !== 0
      )
        throw Error('boundary-config');
      await systemDirectory(tx, { ...item, gid: channel ? owner.gid : 0 });
    }
    await systemDirectory(tx, { path: sshDirectory, uid: 0, gid: 0, mode: 0o755, acl: [] });
    await systemFile(tx, pf);
    await tx.external({ pf: lastPf, ssh: lastSsh });
    await loadPf(pfFile, lastPf.enabled);
    if (newHostKey) await systemFile(tx, { path: hostFile, mode: 0o600, content: newHostKey });
    for (const file of plan.files.filter((item) => item.uid === 0 && item.path !== pfFile)) {
      if (file.gid !== 0 || ![0o600, 0o644, 0o755].includes(file.mode))
        throw Error('boundary-config');
      await systemFile(tx, file);
    }
    await systemFile(tx, { path: plan.paths.codex, mode: 0o755, content: runtime.codex });
    await trustedFile(plan.paths.codex, 0o755);
    if (!(await fs.readFile(plan.paths.codex)).equals(runtime.codex)) throw Error('boundary-base');
    await lintProfiles();
    await startSsh(lastSsh);
    const live = await checkInstalled(plan, host, agent);
    await requireAcl(path.join(root, 'channel'), ['user:executor allow search']);
    await asUser(agent, 'prepare-executor', sha);
    const initial = !current || current.initialSha === sha;
    await asUser(owner, initial ? 'prepare-initial' : 'prepare', sha, payload);
    if ((await localOwner()).uid !== owner.uid) throw Error('boundary-account');
    await verifiedExecutor(agent);
    if (replaceBase) await replaceTrustedBase(tx, selected, runtime.node);
    const accepted = {
      sha,
      initialSha: current?.initialSha ?? sha,
      initialWorkflow: current?.initialWorkflow ?? selected.stage.workflow,
      pinnedCheckBlobs: current?.pinnedCheckBlobs ?? selected.stage.pinnedCheckBlobs,
      keySetSha256: keyDigest,
      version: selected.manifest.version,
      ownerUid: owner.uid,
      executorUid: agent.uid,
      executorGuid: agent.guid,
      pfRules: live.rules,
      pfDigest: hash(pf.content),
    };
    await systemFile(tx, {
      path: authority,
      mode: 0o644,
      content: encodeInstallationRelease(accepted),
    });
    await tx.commit();
  } finally {
    try {
      await journal.recover(restoreExternal);
    } catch {
      throw Error('restore-failed');
    }
  }
  await accounts.finish({ initialSha: current?.initialSha ?? sha, ownerUid: owner.uid }, agent);
  if (!current || current.initialSha === sha) await asUser(owner, 'activate', sha);
}

async function installApprovedSystem(sha, initialInstall) {
  if (
    process.platform !== 'darwin' ||
    process.arch !== 'arm64' ||
    process.getuid() !== 0 ||
    process.geteuid() !== 0 ||
    process.getgid() !== 0 ||
    process.getegid() !== 0 ||
    process.cwd() !== '/' ||
    process.execPath !== node ||
    !shaPattern.test(sha)
  )
    throw Error('boundary-entry');
  await rootParents(base);
  await requireAcl(root, []);
  await etcAlias();
  try {
    await fs.mkdir(admin, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (!dirMode(await fs.lstat(admin), 0, 0o700, 0)) throw Error('boundary-entry');
  await requireAcl(admin, []);
  await exclusive(path.join(admin, 'install'), async () => {
    const journal = installationJournal(admin, authorize);
    try {
      await journal.recover(restoreExternal);
    } catch {
      throw Error('restore-failed');
    }
    for (const entry of await fs.readdir(admin, { withFileTypes: true })) {
      if (entry.isDirectory() && /^work-[A-Za-z0-9]{6}$/.test(entry.name)) {
        const file = path.join(admin, entry.name);
        if (!dirMode(await fs.lstat(file), 0, 0o700, 0)) throw Error('boundary-entry');
        await fs.rm(file, { recursive: true });
      }
    }
    const scratch = await fs.mkdtemp(path.join(admin, 'work-'));
    try {
      await apply(sha, initialInstall, scratch, journal, executorInstaller(admin));
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });
}

module.exports = { installApprovedSystem };
