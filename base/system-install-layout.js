'use strict';

const path = require('node:path').posix;

const systemRoot = '/Library/Application Support/Foliome';
const sshRoot = '/private/etc/ssh';
const daemonRoot = '/Library/LaunchDaemons';
const hostKeyName = 'ssh_host_ed25519_key';
const anchor = 'com.apple/foliome';
const daemon = 'com.foliome.pf';
const systemPath = '/usr/bin:/bin:/usr/sbin:/sbin';
const tools = ['current_task', 'snapshot', 'readText'];
const shaPattern = /^[a-f0-9]{40}$/;
const nodeVersion = '26.13.1';
const codexVersion = '0.167.0';
const codexMember = 'codex-aarch64-apple-darwin';

// Pinned Cloudflare destination ranges supplied for this release. Account-specific
// reachability is an installation gate. PF cannot distinguish hosts on shared addresses.
const cloudflare4 = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];
const cloudflare6 = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

const boundaryError = () => ({ ok: false, code: 'boundary-config' });
const lines = (...parts) => `${parts.join('\n')}\n`;
const uid = (value) => Number.isInteger(value) && value > 0 && value <= 0x7fffffff;

// Restrict paths to literal characters common to the shell, ssh_config, TOML and XML.
function absolute(value) {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    value.length < 1024 &&
    value
      .slice(1)
      .split('/')
      .every(
        (part) =>
          part.length > 0 &&
          part.length <= 255 &&
          /^[a-zA-Z0-9_. -]+$/.test(part) &&
          !part.endsWith('.') &&
          part.trim() === part,
      )
  );
}

function overlaps(first, second) {
  const a = first.toLowerCase();
  const b = second.toLowerCase();
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function samePaths(values, expected) {
  return (
    Object.keys(values).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => values[key] === value)
  );
}

const ed25519Header = Buffer.from('0000000b7373682d6564323535313900000020', 'hex');
function publicKey(key) {
  if (typeof key !== 'string' || !/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(key)) return false;
  const bytes = Buffer.from(key.slice('ssh-ed25519 '.length), 'base64');
  return (
    bytes.length === ed25519Header.length + 32 &&
    bytes.subarray(0, ed25519Header.length).equals(ed25519Header)
  );
}

function identities({ owner, agent, keys }, root) {
  const name = agent.name;
  if (
    !uid(owner.uid) ||
    !uid(agent.uid) ||
    agent.uid === owner.uid ||
    typeof name !== 'string' ||
    !/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(name) ||
    ['root', 'dev'].includes(name.toLowerCase()) ||
    !absolute(owner.home) ||
    !absolute(agent.home) ||
    overlaps(owner.home, agent.home) ||
    [root, systemRoot, '/etc', '/private/etc', daemonRoot].some(
      (dir) => overlaps(owner.home, dir) || overlaps(agent.home, dir),
    )
  )
    return false;
  const publicKeys = [keys.owner, keys.launch, keys.host, keys.dev];
  return publicKeys.every(publicKey) && new Set(publicKeys).size === publicKeys.length;
}

const userRoot = (home) => path.join(home, 'Library/Application Support/Foliome');

function targetsFor(root, owner, agent, installed) {
  const data = path.join(userRoot(owner.home), 'data');
  const channel = path.join(root, 'channel');
  const ssh = installed ? sshRoot : path.join(root, 'ssh');
  const keys = path.join(ssh, 'authorized_keys');
  const commands = path.join(root, 'executor/root');
  return {
    app: path.join(userRoot(owner.home), 'app'),
    data,
    channel,
    socket: path.join(channel, 'core.sock'),
    sshConfig: path.join(data, 'ssh_config'),
    knownHosts: path.join(data, 'known_hosts'),
    sshdConfig: path.join(ssh, 'sshd_config.d/000-foliome.conf'),
    agentKeys: path.join(keys, agent.name),
    devKeys: path.join(keys, 'dev'),
    pfAnchor: path.join(installed ? '/private/etc' : root, 'pf.anchors/foliome'),
    pfTask: path.join(
      installed ? daemonRoot : path.join(root, 'LaunchDaemons'),
      'foliome-pf.plist',
    ),
    wrapper: path.join(commands, 'launch'),
    client: path.join(commands, 'channel-client'),
  };
}

function releasePaths(source, sha, installed) {
  return {
    source,
    sha,
    manifest: path.join(source, installed ? 'release/manifest.json' : 'manifest.json'),
    codex: path.join(source, installed ? '.release-artifacts/codex' : 'artifacts/codex'),
  };
}

function sshClient(agent, knownHosts, identity) {
  return lines(
    'Host executor-core',
    '  HostName 127.0.0.1',
    `  User ${agent.name}`,
    '  AddressFamily inet',
    '  Port 22',
    '  IdentityAgent none',
    `  IdentityFile "${identity}"`,
    '  IdentitiesOnly yes',
    '  BatchMode yes',
    '  PreferredAuthentications publickey',
    '  HostKeyAlgorithms ssh-ed25519',
    '  PubkeyAcceptedAlgorithms ssh-ed25519',
    '  StrictHostKeyChecking yes',
    '  NoHostAuthenticationForLocalhost no',
    '  UpdateHostKeys no',
    `  UserKnownHostsFile "${knownHosts}"`,
    '  GlobalKnownHostsFile /dev/null',
    '  ForwardAgent no',
    '  ForwardX11 no',
    '  ClearAllForwardings yes',
    '  RequestTTY no',
    '  PermitLocalCommand no',
    '  ProxyCommand none',
    '  ControlMaster no',
    '  ControlPath none',
    '  ConnectTimeout 5',
  );
}

function sshServer(agent, hostKey) {
  return lines(
    'AddressFamily inet',
    'ListenAddress 127.0.0.1:22',
    `AllowUsers ${agent.name}@127.0.0.1 dev@127.0.0.1`,
    `HostKey "${hostKey}"`,
    'HostKeyAlgorithms ssh-ed25519',
    'PubkeyAcceptedAlgorithms ssh-ed25519',
    'AuthorizedKeysFile /etc/ssh/authorized_keys/%u',
    'AuthorizedKeysCommand none',
    'TrustedUserCAKeys none',
    'StrictModes yes',
    'AuthenticationMethods publickey',
    'PubkeyAuthentication yes',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'PermitRootLogin no',
    'DisableForwarding yes',
    'AllowAgentForwarding no',
    'AllowTcpForwarding no',
    'AllowStreamLocalForwarding no',
    'X11Forwarding no',
    'PermitTunnel no',
    'PermitUserRC no',
    'PermitUserEnvironment no',
    'PermitTTY yes',
  );
}

function pfRules(agent) {
  return lines(
    `table <foliome_cloudflare4> const { ${cloudflare4.join(', ')} }`,
    `table <foliome_cloudflare6> const { ${cloudflare6.join(', ')} }`,
    'block return in quick on ! lo0 proto tcp from any to any port 22',
    'block return in quick on lo0 inet proto tcp from ! 127.0.0.1 to any port 22',
    'block return in quick on lo0 inet proto tcp from any to ! 127.0.0.1 port 22',
    'block return in quick on lo0 inet6 proto tcp from any to any port 22',
    'block return out quick inet proto tcp from any to 192.0.2.1 port 49151',
    `pass out quick inet proto tcp from any to <foliome_cloudflare4> port 443 user ${agent.uid} keep state`,
    `pass out quick inet6 proto tcp from any to <foliome_cloudflare6> port 443 user ${agent.uid} keep state`,
    // Darwin PF can attribute TCP and UDP to a socket UID.
    `block drop out quick proto { tcp, udp } all user ${agent.uid}`,
  );
}

function pfPlist(pfAnchor, installed) {
  const argv = installed
    ? ['/sbin/pfctl', '-a', anchor, '-f', pfAnchor, '-e']
    : ['/sbin/pfctl', '-n', '-a', anchor, '-f', pfAnchor];
  return lines(
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${daemon}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...argv.map((arg) => `    <string>${arg}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '</dict>',
    '</plist>',
  );
}

function workerGuard(root, agent) {
  return [
    '#!/bin/sh',
    'set -eu',
    'umask 077',
    '[ "$#" -eq 0 ] || exit 1',
    `[ '${root}' = '${systemRoot}' ] || exit 1`,
    `/usr/bin/id -u | /usr/bin/grep -qx '${agent.uid}' || exit 1`,
    `/usr/bin/id -ru | /usr/bin/grep -qx '${agent.uid}' || exit 1`,
    `LC_ALL=C /usr/bin/stat -f '%HT %u %g %Lp' '${root}' | /usr/bin/grep -Fqx 'Directory 0 0 755' || exit 1`,
  ];
}

function worker(root, agent, { codex, home, codexHome, client, work, tmp }) {
  const server = `mcp_servers={ foliome = { command = "${client}", enabled_tools = ${JSON.stringify(tools)}, required = true } }`;
  return lines(
    ...workerGuard(root, agent),
    `LC_ALL=C /usr/bin/stat -f '%HT %u %g %Lp %l' '${codex}' | /usr/bin/grep -Fqx 'Regular File 0 0 755 1' || exit 1`,
    `cd '${work}'`,
    `exec /usr/bin/env -i PATH=${systemPath} 'HOME=${home}' 'CODEX_HOME=${codexHome}' 'TMPDIR=${tmp}' \\`,
    `  '${codex}' exec --disable apps --disable shell_tool --disable unified_exec --disable skill_search \\`,
    '  --strict-config --ignore-user-config --ignore-rules --sandbox read-only --ephemeral --skip-git-repo-check \\',
    `  -c '${server}' -c 'approval_policy="never"' -c 'web_search="disabled"' \\`,
    `  'Use only current_task, snapshot, and readText. Call current_task first and follow the protected task it returns.' </dev/null >/dev/null 2>&1`,
  );
}

function copyArtifact([source, destination]) {
  return {
    kind: 'copy',
    executable: '/usr/bin/install',
    args: ['-o', 'root', '-g', 'wheel', '-m', '0755', source, destination],
  };
}

// These describe preflight inputs and command argv for a subsequent installer. The
// archive listing and Git tree lookup are preliminary checks. The next stage
// verifies the publisher, the manifest blob and the inventory at the accepted
// commit, then holds the verified bytes in private staging through copying.
function releasePlan({ root, base, launch, node, codex, release: appRelease }, release) {
  const runtime = release.runtime ?? { node: nodeVersion, codex: codexVersion };
  const nodeMember = `node-v${runtime.node}-darwin-arm64/bin/node`;
  const nodeArchive = path.join(path.dirname(release.codex), 'node');
  const verified = path.join(release.source, 'verified');
  const copies = [
    [path.join(verified, 'node'), node],
    [path.join(verified, 'codex'), codex],
    [path.join(verified, 'base/launch'), launch],
  ];
  if (
    ![release.source, release.manifest, release.codex, nodeArchive, ...copies.flat()].every(
      absolute,
    )
  )
    return null;
  return {
    verification: {
      commit: release.sha,
      manifest: release.manifest,
      nodeArchive,
      codexArchive: release.codex,
      releaseObserver: path.join(base, 'release-observation.js'),
      publisherVerifier: path.join(base, 'publisher-verification.js'),
      nodeMember,
      codexMember,
      version: runtime,
      bindToCommit: [root, base, appRelease],
    },
    steps: [
      {
        kind: 'verify-manifest',
        executable: '/usr/bin/git',
        args: [
          '--no-optional-locks',
          '-C',
          release.source,
          'ls-tree',
          '--full-tree',
          release.sha,
          '--',
          release.manifest,
        ],
      },
      {
        kind: 'verify-signature',
        executable: '/usr/bin/tar',
        args: ['-tvzf', release.codex, '--', codexMember],
      },
      {
        kind: 'verify-signature',
        executable: '/usr/bin/tar',
        args: ['-tvzf', nodeArchive, '--', nodeMember],
      },
      ...copies.map(copyArtifact),
    ],
  };
}

function compile(root, { owner, agent, keys }, t, release) {
  const installed = root === systemRoot;
  const base = path.join(root, 'base');
  const releases = path.join(t.app, 'releases');
  const ownerKeys = path.join(t.data, 'ssh');
  const launchKey = path.join(ownerKeys, 'launch_ed25519');
  const terminalKey = path.join(ownerKeys, 'owner_ed25519');
  const ssh = path.dirname(path.dirname(t.agentKeys));
  const hostKey = path.join(ssh, hostKeyName);
  const commands = path.dirname(t.wrapper);
  const codex = installed
    ? path.join(root, 'executor/share', release.sha, 'codex')
    : path.join(commands, 'codex');
  const work = path.join(commands, 'work');
  const agentData = userRoot(agent.home);
  const codexHome = path.join(agentData, 'codex');
  const tmp = path.join(agentData, 'tmp');
  const files = [];
  const directories = [];
  function file(destination, uid, mode, content, acl) {
    files.push({
      path: destination,
      uid,
      mode,
      content,
      ...(uid === 0 && { gid: 0 }),
      ...(acl && { acl }),
    });
  }
  function dir(destination, uid, mode, acl = []) {
    directories.push({ path: destination, uid, mode, acl, ...(uid === 0 && { gid: 0 }) });
  }

  for (const p of [root, base, path.dirname(commands), commands, work]) dir(p, 0, 0o755);
  if (installed)
    for (const p of [path.dirname(path.dirname(codex)), path.dirname(codex)]) dir(p, 0, 0o755);
  dir(path.dirname(t.agentKeys), 0, 0o711);
  for (const p of [
    userRoot(owner.home),
    t.app,
    releases,
    t.data,
    ownerKeys,
    path.join(t.data, 'accepted'),
    path.join(t.data, 'tmp'),
  ])
    dir(p, owner.uid, 0o700);
  for (const p of [agentData, codexHome, tmp]) dir(p, agent.uid, 0o700);
  dir(t.channel, owner.uid, 0o700, [`user:${agent.name} allow search`]);

  file(
    path.join(root, 'installation.json'),
    0,
    0o644,
    lines(JSON.stringify({ executorName: agent.name, executorUid: agent.uid })),
  );
  file(t.sshConfig, owner.uid, 0o600, sshClient(agent, t.knownHosts, launchKey));
  file(t.knownHosts, owner.uid, 0o600, lines(`127.0.0.1 ${keys.host}`));
  file(
    t.sshdConfig,
    0,
    0o644,
    sshServer(agent, installed ? path.join('/etc/ssh', hostKeyName) : hostKey),
  );
  if (installed)
    file(
      path.join(ssh, 'sshd_config'),
      0,
      0o644,
      lines('Include /etc/ssh/sshd_config.d/000-foliome.conf'),
    );
  const keyOptions = 'restrict,from="127.0.0.1"';
  // sshd opens authorized_keys as the login UID. Give each login read access
  // through a single ACL while retaining root ownership and mode 0600.
  file(
    t.agentKeys,
    0,
    0o600,
    lines(
      `${keyOptions},pty ${keys.owner}`,
      `${keyOptions},command="exec '${t.wrapper}'" ${keys.launch}`,
    ),
    [`user:${agent.name} allow read`],
  );
  file(t.devKeys, 0, 0o600, lines(`${keyOptions} ${keys.dev}`), ['user:dev allow read']);
  file(t.pfAnchor, 0, 0o644, pfRules(agent));
  file(t.pfTask, 0, 0o644, pfPlist(t.pfAnchor, installed));
  file(
    t.wrapper,
    0,
    0o755,
    worker(root, agent, { codex, home: agentData, codexHome, client: t.client, work, tmp }),
  );
  file(t.client, 0, 0o755, lines(...workerGuard(root, agent), `exec /usr/bin/nc -U '${t.socket}'`));

  const paths = {
    root,
    base,
    launch: path.join(base, 'launch'),
    node: path.join(base, 'node'),
    database: path.join(t.data, 'core.db'),
    releases,
    release: path.join(releases, release.sha),
    codex,
    codexHome,
    launchKey,
    terminalKey,
    hostKey,
  };
  const staging = releasePlan(paths, release);
  if (
    !staging ||
    t.socket.length > 103 ||
    ![
      ...files.map((item) => item.path),
      ...directories.map((item) => item.path),
      ...Object.values(paths),
    ].every(absolute)
  )
    return boundaryError();

  return {
    ok: true,
    plan: {
      execution: 'description-only',
      paths,
      files,
      directories,
      ...staging,
      platformVerification: {
        status: 'pending',
        agentLoginShell: '/bin/sh',
        parentAnchor: 'com.apple/*',
        ordinaryLaunch: { uid: owner.uid, executable: paths.launch, args: [] },
      },
      runtimeSocket: {
        path: t.socket,
        uid: owner.uid,
        mode: 0o600,
        acl: [`user:${agent.name} allow write`],
      },
    },
  };
}

// Synthetic planner for parser fixtures. Its scripts refuse to run outside the
// installed layout, and the planner has no OS, process, filesystem or network port.
function planSystemInstall(input) {
  try {
    const { owner, agent, targets, release } = input;
    const root = path.dirname(targets.channel);
    if (
      !absolute(root) ||
      overlaps(root, systemRoot) ||
      [sshRoot, '/etc/ssh', '/private/etc/pf.anchors', '/etc/pf.anchors', daemonRoot].some((p) =>
        overlaps(root, p),
      ) ||
      !identities(input, root) ||
      typeof release.sha !== 'string' ||
      !shaPattern.test(release.sha) ||
      !absolute(release.source) ||
      [root, owner.home, agent.home].some((p) => overlaps(release.source, p)) ||
      !samePaths(release, releasePaths(release.source, release.sha, false))
    )
      return boundaryError();
    const expected = targetsFor(root, owner, agent, false);
    return samePaths(targets, expected) ? compile(root, input, expected, release) : boundaryError();
  } catch {
    return boundaryError();
  }
}

// The installation stage must supply identity records corroborated by macOS,
// public keys only, and an independently accepted commit. All targets are fixed.
function planInstalledSystemInstall(input) {
  try {
    const { owner, agent, sha, runtime } = input;
    if (
      agent.name !== 'executor' ||
      !identities(input, systemRoot) ||
      typeof sha !== 'string' ||
      !shaPattern.test(sha) ||
      (runtime !== undefined &&
        (typeof runtime.node !== 'string' ||
          !/^26\.13\.(0|[1-9][0-9]*)$/.test(runtime.node) ||
          typeof runtime.codex !== 'string' ||
          !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(runtime.codex)))
    )
      return boundaryError();
    const source = path.join(userRoot(owner.home), 'data/install-staging', sha);
    const targets = targetsFor(systemRoot, owner, agent, true);
    return compile(systemRoot, input, targets, { ...releasePaths(source, sha, true), runtime });
  } catch {
    return boundaryError();
  }
}

module.exports = { planSystemInstall, planInstalledSystemInstall };
