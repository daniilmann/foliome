const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

// Proposed pure port: planSystemInstall(trusted) returns {ok, plan} or
// {ok:false, code:'boundary-config'}. No OS reads or writes occur in the port.
// Files carry exact destination, owner UID, mode and UTF-8 content; directories
// carry exact destination, owner UID, mode and ACL. Steps are inert argv arrays.
type FilePlan = { path: string; uid: number; mode: number; content: string };
type DirectoryPlan = { path: string; uid: number; mode: number; acl: string[] };
type Step = { kind: string; executable: string; args: string[] };
type Plan = {
  files: FilePlan[];
  directories: DirectoryPlan[];
  steps: Step[];
  runtimeSocket: { path: string; uid: number; mode: number; acl: string[] };
};
const exec = promisify(execFile);
const publicKey = (byte: number) => {
  const algorithm = Buffer.from('ssh-ed25519');
  const length = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  return `ssh-ed25519 ${Buffer.concat([length(algorithm.length), algorithm, length(32), Buffer.alloc(32, byte)]).toString('base64')}`;
};
function input(root: string) {
  const ownerHome = path.join(root, 'owner');
  const agentHome = path.join(root, 'agent');
  const application = path.join(ownerHome, 'Library/Application Support/Foliome');
  const system = path.join(root, 'system root');
  return {
    owner: { uid: 501, home: ownerHome },
    agent: { uid: 778, name: 'synthetic-executor', home: agentHome },
    keys: { owner: publicKey(1), launch: publicKey(2), host: publicKey(3), dev: publicKey(4) },
    targets: {
      app: path.join(application, 'app'),
      data: path.join(application, 'data'),
      channel: path.join(system, 'channel'),
      socket: path.join(system, 'channel/core.sock'),
      sshConfig: path.join(application, 'data/ssh_config'),
      knownHosts: path.join(application, 'data/known_hosts'),
      sshdConfig: path.join(system, 'ssh/sshd_config.d/000-foliome.conf'),
      agentKeys: path.join(system, 'ssh/authorized_keys/synthetic-executor'),
      devKeys: path.join(system, 'ssh/authorized_keys/dev'),
      pfAnchor: path.join(system, 'pf.anchors/foliome'),
      pfTask: path.join(system, 'LaunchDaemons/foliome-pf.plist'),
      wrapper: path.join(system, 'executor/root/launch'),
      client: path.join(system, 'executor/root/channel-client'),
    },
    release: {
      source: path.join(root, 'release'),
      manifest: path.join(root, 'release/manifest.json'),
      codex: path.join(root, 'release', 'artifacts', 'codex'),
      sha: 'a'.repeat(40),
    },
  };
}
function makePlan(value: ReturnType<typeof input>) {
  return (
    require('../../base/system-install-layout.js') as {
      planSystemInstall(value: unknown): { ok: true; plan: Plan } | { ok: false; code: string };
    }
  ).planSystemInstall(value);
}
function good(value: ReturnType<typeof input>): Plan {
  const result = makePlan(value);
  assert.equal(result.ok, true);
  if (!result.ok) throw Error('plan rejected');
  return result.plan;
}
function file(plan: Plan, name: string): FilePlan {
  const matches = plan.files.filter((entry) => entry.path === name);
  assert.equal(matches.length, 1, name);
  return matches[0];
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'install-layout-'));
  await fs.chmod(root, 0o700);
  return { root, trusted: input(root) };
}

test('план содержит точные права каталогов и только ACL прохода исполнителя', async () => {
  const f = await fixture();
  try {
    const plan = good(f.trusted);
    for (const target of [f.trusted.targets.app, f.trusted.targets.data]) {
      assert.deepEqual(
        plan.directories.filter((d) => d.path === target),
        [{ path: target, uid: 501, mode: 0o700, acl: [] }],
      );
    }
    assert.deepEqual(
      plan.directories.filter((d) => d.path === f.trusted.targets.channel),
      [
        {
          path: f.trusted.targets.channel,
          uid: 501,
          mode: 0o700,
          acl: ['user:synthetic-executor allow search'],
        },
      ],
    );
    assert.equal(
      plan.files.some((entry) => entry.path === f.trusted.targets.socket),
      false,
    );
    assert.equal(
      plan.directories.some((entry) => entry.path === f.trusted.targets.socket),
      false,
    );
    assert.equal(
      plan.steps.some((step) => step.args.includes(f.trusted.targets.socket)),
      false,
    );
    assert.deepEqual(plan.runtimeSocket, {
      path: f.trusted.targets.socket,
      uid: 501,
      mode: 0o600,
      acl: ['user:synthetic-executor allow write'],
    });
    assert.deepEqual(await fs.readdir(f.root), []);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('SSH использует локальный фиксированный alias, закреплённый host key и ограниченные root-ключи', async () => {
  const f = await fixture();
  try {
    const plan = good(f.trusted);
    const config = file(plan, f.trusted.targets.sshConfig);
    const known = file(plan, f.trusted.targets.knownHosts);
    assert.equal(config.uid, 501);
    assert.equal(config.mode, 0o600);
    assert.equal(known.uid, 501);
    assert.equal(known.mode, 0o600);
    assert.equal(known.content, `127.0.0.1 ${f.trusted.keys.host}\n`);
    for (const [target, expected] of [
      [f.trusted.targets.agentKeys, [f.trusted.keys.owner, f.trusted.keys.launch]],
      [f.trusted.targets.devKeys, [f.trusted.keys.dev]],
    ] as [string, string[]][]) {
      const entry = file(plan, target);
      assert.equal(entry.uid, 0);
      assert.equal(entry.mode, 0o600);
      const lines = entry.content.trim().split('\n');
      assert.equal(lines.length, expected.length);
      for (const key of expected) {
        const line = lines.find((item: string) => item.includes(key));
        assert.ok(line);
        assert.match(line, /(?:^|,)restrict(?:,|\s)/);
        assert.match(line, /from="127\.0\.0\.1(?:,::1)?"/);
      }
    }
    const launchLine = file(plan, f.trusted.targets.agentKeys)
      .content.split('\n')
      .find((line: string) => line.includes(f.trusted.keys.launch));
    assert.ok(launchLine);
    if (!launchLine) throw Error('launch key absent');
    assert.ok(launchLine.includes(`command="exec '${f.trusted.targets.wrapper}'"`));
    assert.ok(!launchLine.includes(f.trusted.keys.dev));
    const sshd = file(plan, f.trusted.targets.sshdConfig);
    assert.equal(sshd.uid, 0);
    assert.match(sshd.content, /^AuthorizedKeysFile\s+\/etc\/ssh\/authorized_keys\/%u\s*$/im);
    assert.match(sshd.content, /^PasswordAuthentication\s+no\s*$/im);
    assert.match(sshd.content, /^PermitUserRC\s+no\s*$/im);
    assert.match(sshd.content, /^PermitUserEnvironment\s+no\s*$/im);
    const cfg = path.join(f.root, 'ssh_config');
    await fs.writeFile(cfg, config.content, { mode: 0o600 });
    const { stdout } = await exec('/usr/bin/ssh', ['-G', '-F', cfg, 'executor-core'], {
      env: { PATH: '/usr/bin:/bin', HOME: f.root },
    });
    for (const expected of [
      'hostname 127.0.0.1',
      'user synthetic-executor',
      'forwardagent no',
      'clearallforwardings yes',
      'requesttty false',
      'stricthostkeychecking true',
      'identityagent none',
      'controlmaster false',
      `userknownhostsfile ${f.trusted.targets.knownHosts.toLowerCase()}`,
    ])
      assert.ok(stdout.toLowerCase().split('\n').includes(expected), expected);
    assert.match(stdout, /^connecttimeout [1-9]\d*$/m);
    for (const key of Object.values(f.trusted.keys)) {
      const pub = path.join(f.root, 'key.pub');
      await fs.writeFile(pub, `${key}\n`, { mode: 0o600 });
      await exec('/usr/bin/ssh-keygen', ['-l', '-f', pub]);
    }
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('план задаёт один якорь PF, разовую задачу без слушателя и фиксированную команду агента', async () => {
  const f = await fixture();
  try {
    const plan = good(f.trusted);
    const pf = file(plan, f.trusted.targets.pfAnchor);
    const task = file(plan, f.trusted.targets.pfTask);
    assert.equal(pf.uid, 0);
    assert.equal(task.uid, 0);
    assert.match(pf.content, /block\s+(?:drop|return).*\buser\s+778\b/i);
    assert.match(pf.content, /(?:127\.0\.0\.1|lo0)/);
    assert.match(pf.content, /(?:port\s+(?:=\s*)?22|port\s+ssh)/i);
    assert.match(pf.content, /block\s+return/i);
    assert.doesNotMatch(pf.content, /^\s*pass\s+(?:quick\s+)?(?:all|out\s+all)\s*$/im);
    const plist = path.join(f.root, 'task.plist');
    await fs.writeFile(plist, task.content, { mode: 0o600 });
    await exec('/usr/bin/plutil', ['-lint', plist]);
    const { stdout } = await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.RunAtLoad, true);
    assert.equal(parsed.KeepAlive ?? false, false);
    assert.equal(parsed.Sockets, undefined);
    assert.equal(parsed.MachServices, undefined);
    assert.ok(Array.isArray(parsed.ProgramArguments));
    assert.equal(parsed.ProgramArguments[0], '/sbin/pfctl');
    assert.equal(parsed.ProgramArguments.filter((s: string) => s === '-a').length, 1);
    assert.ok(parsed.ProgramArguments.includes(f.trusted.targets.pfAnchor));
    const wrapper = file(plan, f.trusted.targets.wrapper);
    assert.equal(wrapper.uid, 0);
    assert.equal(wrapper.mode & 0o022, 0);
    assert.doesNotMatch(wrapper.content, /\$[@*]|SSH_ORIGINAL_COMMAND|\beval\b|--enable|--config/);
    assert.match(wrapper.content, /--disable\s+apps\b/);
    assert.doesNotMatch(wrapper.content, /\$[0-9]|\$\{|\$\(|`|\bsource\b|(^|\s)\.\s/m);
    assert.ok(wrapper.content.includes(f.trusted.targets.client));
    const client = file(plan, f.trusted.targets.client);
    assert.equal(client.uid, 0);
    assert.ok(client.content.includes(f.trusted.targets.socket));
    assert.match(client.content, /\/usr\/bin\/nc\s+-U\b/);
    const script = path.join(f.root, 'wrapper');
    await fs.writeFile(script, wrapper.content, { mode: 0o600 });
    await exec('/bin/sh', ['-n', script]);
    for (const name of ['current_task', 'snapshot', 'readText'])
      assert.ok(wrapper.content.includes(name));
    assert.equal(plan.files.filter((entry) => entry.path.includes('pf.anchors/')).length, 1);
    assert.equal(plan.files.filter((entry) => entry.path.includes('LaunchDaemons/')).length, 1);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('подпись и манифест проверяются до копирования; план не выполняет шаги', async () => {
  const f = await fixture();
  try {
    const plan = good(f.trusted);
    const signature = plan.steps.findIndex((step) => step.kind === 'verify-signature');
    const manifest = plan.steps.findIndex((step) => step.kind === 'verify-manifest');
    const copy = plan.steps.findIndex((step) => step.kind === 'copy');
    assert.ok(signature >= 0 && manifest >= 0 && copy > signature && copy > manifest);
    assert.ok(plan.steps[signature].args.includes(f.trusted.release.codex));
    assert.ok(plan.steps[manifest].args.includes(f.trusted.release.manifest));
    assert.ok(plan.steps[manifest].args.includes(f.trusted.release.sha));
    for (const step of plan.steps) {
      assert.ok(!['sudo', 'su', 'launchctl', 'ssh'].includes(path.basename(step.executable)));
      assert.ok(!step.args.includes(f.trusted.agent.home));
    }
    assert.deepEqual(await fs.readdir(f.root), []);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('ошибочный доверенный ввод отклоняется без файлов и без раскрытия значения', async () => {
  const f = await fixture();
  try {
    const t = f.trusted;
    const marker = 'sensitive-synthetic-marker';
    const invalid = [
      { ...t, owner: { ...t.owner, uid: -1 } },
      { ...t, agent: { ...t.agent, uid: t.owner.uid } },
      { ...t, agent: { ...t.agent, name: `bad\n${marker}` } },
      { ...t, owner: { ...t.owner, home: 'relative' } },
      { ...t, agent: { ...t.agent, home: t.owner.home } },
      { ...t, keys: { ...t.keys, launch: `ssh-ed25519 ${marker}` } },
      { ...t, keys: { ...t.keys, host: t.keys.launch } },
      { ...t, keys: { ...t.keys, dev: `${t.keys.dev}\n${marker}` } },
      { ...t, targets: { ...t.targets, sshConfig: path.join(f.root, marker) } },
      { ...t, targets: { ...t.targets, socket: `${t.targets.channel}/../${marker}` } },
      { ...t, targets: { ...t.targets, agentKeys: t.targets.devKeys } },
      { ...t, release: { ...t.release, sha: marker } },
    ];
    for (const bad of invalid) {
      const result = makePlan(bad);
      assert.deepEqual(result, { ok: false, code: 'boundary-config' });
      assert.ok(!JSON.stringify(result).includes(marker));
      assert.deepEqual(await fs.readdir(f.root), []);
    }
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
