import type { createInstalledKernel } from './main.ts';
import type { DatabaseSync } from 'node:sqlite';

type KernelOptions = Parameters<typeof createInstalledKernel>[0];
type Paths = KernelOptions['paths'] & { config: string };
type Ports = {
  observe: KernelOptions['observeMacOS'];
  createInstalledKernel: typeof createInstalledKernel;
  launchChrome: KernelOptions['launchChrome'];
  runProcess: KernelOptions['runProcess'];
};
type Result = { ok: true } | { ok: false; code: string };
const fs = require('node:fs/promises') as typeof import('node:fs/promises');
const { constants } = require('node:fs') as typeof import('node:fs');
const path = require('node:path') as typeof import('node:path');
const os = require('node:os') as typeof import('node:os');
const { pathToFileURL } = require('node:url') as typeof import('node:url');
const { parseInstalledConfig } =
  require('./domain/installed-config.ts') as typeof import('./domain/installed-config.ts');
const shaPattern = /^[a-f0-9]{40}$/;
const maxDatabase = 1024 * 1024 * 1024;

function absolute(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    path.isAbsolute(value) &&
    path.normalize(value) === value &&
    !value.includes('\0')
  );
}
function validPaths(p: Paths): boolean {
  if (!p || Object.values(p).some((value) => !absolute(value))) return false;
  const root = path.join(p.home, 'Library/Application Support/Foliome');
  return (
    p.app === path.join(root, 'app') &&
    p.data === path.join(root, 'data') &&
    p.database === path.join(p.data, 'core.db') &&
    p.sshConfig === path.join(p.data, 'ssh_config') &&
    p.config === path.join(p.data, 'config.json') &&
    p.socket === path.join(p.channel, 'core.sock')
  );
}
function cleanEnvironment(env: NodeJS.ProcessEnv): boolean {
  return Object.keys(env).every((key) =>
    ['HOME', 'PATH', 'TMPDIR', '__CF_USER_TEXT_ENCODING'].includes(key),
  );
}
async function readConfig(
  file: string,
): Promise<{ source: KernelOptions['source']; executorUid: number }> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o7777) !== 0o600 ||
      stat.size > 65536
    )
      throw Error();
    const bytes = Buffer.alloc(65537);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 65536) throw Error();
    return parseInstalledConfig(JSON.parse(bytes.subarray(0, length).toString('utf8')));
  } finally {
    await handle.close();
  }
}
async function checkDirectory(dir: string, uid: number, privateMode = true): Promise<void> {
  const stat = await fs.lstat(dir);
  if (
    !stat.isDirectory() ||
    stat.uid !== uid ||
    (privateMode ? (stat.mode & 0o7777) !== 0o700 : (stat.mode & 0o7022) !== 0)
  )
    throw Error();
}
function privateDatabase(stat: import('node:fs').Stats, uid: number): boolean {
  return stat.isFile() && stat.nlink === 1 && stat.uid === uid && (stat.mode & 0o7777) === 0o600;
}

function checkInstalledSchema(db: DatabaseSync): void {
  const tables = {
    activation_state: ['id:INTEGER:0:1', 'current_sha:TEXT:1:0', 'previous_sha:TEXT:0:0'],
    action_verdicts: [
      'id:INTEGER:0:1',
      'at_ms:INTEGER:1:0',
      'session_id:TEXT:1:0',
      'source_id:TEXT:1:0',
      'access_id:TEXT:1:0',
      'snapshot_number:INTEGER:1:0',
      'node_number:INTEGER:0:0',
      'method:TEXT:1:0',
      'action_class:TEXT:1:0',
      'actor:TEXT:1:0',
      'decision:TEXT:1:0',
      'reason:TEXT:1:0',
    ],
    action_outcomes: ['verdict_id:INTEGER:0:1', 'at_ms:INTEGER:1:0', 'status:TEXT:1:0'],
    text_snapshots: [
      'id:INTEGER:0:1',
      'at_ms:INTEGER:1:0',
      'session_id:TEXT:1:0',
      'source_id:TEXT:1:0',
      'access_id:TEXT:1:0',
      'snapshot_number:INTEGER:1:0',
      'host:TEXT:1:0',
      'path:TEXT:1:0',
      'snapshot_json:TEXT:1:0',
    ],
  };
  const table = db.prepare(
    "SELECT strict, wr FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name = ?",
  );
  const columns = db.prepare(
    'SELECT name, type, "notnull" AS required, pk, hidden FROM pragma_table_xinfo(?, \'main\') ORDER BY cid',
  );
  for (const [name, expected] of Object.entries(tables)) {
    const schema = table.get(name);
    const actual = columns
      .all(name)
      .map((column) =>
        column.hidden === 0
          ? `${column.name}:${column.type}:${column.required}:${column.pk}`
          : null,
      );
    if (
      schema?.strict !== 1 ||
      schema.wr !== 0 ||
      actual.length !== expected.length ||
      actual.some((column, index) => column !== expected[index])
    )
      throw Error();
  }
  const foreignKeys = db.prepare('PRAGMA main.foreign_key_list(action_outcomes)').all();
  if (
    foreignKeys.length !== 1 ||
    foreignKeys[0].table !== 'action_verdicts' ||
    foreignKeys[0].from !== 'verdict_id' ||
    foreignKeys[0].to !== 'id' ||
    foreignKeys[0].on_delete !== 'NO ACTION' ||
    foreignKeys[0].on_update !== 'NO ACTION'
  )
    throw Error();
  const markers = db
    .prepare('SELECT id, current_sha, previous_sha FROM activation_state LIMIT 2')
    .all();
  const active = markers[0];
  if (
    markers.length !== 1 ||
    active.id !== 1 ||
    typeof active.current_sha !== 'string' ||
    !shaPattern.test(active.current_sha) ||
    (active.previous_sha !== null &&
      (typeof active.previous_sha !== 'string' ||
        !shaPattern.test(active.previous_sha) ||
        active.previous_sha === active.current_sha))
  )
    throw Error();
}

async function selfCheck(
  paths: Paths,
  sha: string,
  input: { fixtureFile: string } | { installedEntry: string },
): Promise<void> {
  const uid = process.getuid?.();
  if (!uid || process.geteuid?.() !== uid || !shaPattern.test(sha) || !validPaths(paths))
    throw Error();
  const root = path.dirname(paths.app);
  const releases = path.join(paths.app, 'releases');
  const scratch = path.join(releases, `${sha}.check`);
  const data = path.join(scratch, 'data');
  const file = path.join(data, 'core.db');
  if ('fixtureFile' in input && input.fixtureFile !== file) throw Error();
  await checkDirectory(paths.home, uid);
  for (const dir of [path.join(paths.home, 'Library'), path.dirname(root)])
    await checkDirectory(dir, uid, false);
  for (const dir of [root, paths.app, paths.data, releases, scratch, data])
    await checkDirectory(dir, uid);
  if ('installedEntry' in input) {
    const release = path.join(releases, sha);
    const core = path.join(release, 'core');
    await checkDirectory(release, uid);
    await checkDirectory(core, uid);
    const entry = path.join(core, 'system-entrypoint.ts');
    const stat = await fs.lstat(entry);
    if (
      entry !== input.installedEntry ||
      entry !== (await fs.realpath(entry)) ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== uid ||
      (stat.mode & 0o7077) !== 0
    )
      throw Error();
  }
  if ((await fs.realpath(file)) !== file || (await fs.realpath(paths.database)) !== paths.database)
    throw Error();
  // Require a self-contained backup before using SQLite's immutable mode.
  const entries = await fs.opendir(data);
  try {
    if ((await entries.read())?.name !== 'core.db' || (await entries.read()) !== null)
      throw Error();
  } finally {
    await entries.close();
  }
  const live = await fs.lstat(paths.database);
  if (!privateDatabase(live, uid)) throw Error();
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (
      !privateDatabase(stat, uid) ||
      stat.size > maxDatabase ||
      (stat.ino === live.ino && stat.dev === live.dev)
    )
      throw Error();
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const url = pathToFileURL(file);
    url.searchParams.set('immutable', '1');
    const db = new DatabaseSync(url, { readOnly: true, defensive: true });
    try {
      const current = await fs.lstat(file);
      if (current.ino !== stat.ino || current.dev !== stat.dev || !privateDatabase(current, uid))
        throw Error();
      db.exec('PRAGMA trusted_schema = OFF');
      if (
        db.prepare('PRAGMA integrity_check(1)').get()?.integrity_check !== 'ok' ||
        db.prepare('PRAGMA foreign_key_check').get()
      )
        throw Error();
      if ('installedEntry' in input) checkInstalledSchema(db);
    } finally {
      db.close();
    }
  } finally {
    await handle.close();
  }
}
async function runProgramImpl(options: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  paths?: Paths;
  ports?: Ports;
  selfCheckSha?: string;
}): Promise<Result> {
  if (!cleanEnvironment(options.env)) return { ok: false, code: 'boundary-env' };
  if (
    options.argv.length === 3 &&
    options.argv[0] === '--self-check' &&
    options.argv[1] === '--database'
  ) {
    try {
      if (!options.paths || !options.selfCheckSha) throw Error();
      await selfCheck(options.paths, options.selfCheckSha, { fixtureFile: options.argv[2] });
      return { ok: true };
    } catch {
      return { ok: false, code: 'self-check' };
    }
  }
  if (options.argv.length || !options.paths || !options.ports || !validPaths(options.paths))
    return { ok: false, code: 'boundary-config' };
  try {
    const config = await readConfig(options.paths.config);
    const p = options.paths;
    const ports = options.ports;
    await ports.createInstalledKernel({
      paths: p,
      ownerName: os.userInfo().username,
      executorUid: config.executorUid,
      source: config.source,
      observeMacOS: ports.observe,
      launchChrome: ports.launchChrome,
      runProcess: ports.runProcess,
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      code:
        error instanceof Error && error.message === 'boundary-permissions'
          ? 'boundary-permissions'
          : 'boundary-config',
    };
  }
}
async function launchProgramImpl(options: {
  node: string;
  entry: string;
  home: string;
  tmpdir: string;
  run: (
    command: string,
    args: string[],
    options: { env: Record<string, never>; stdio: 'ignore' },
  ) => Promise<number | null>;
}) {
  if (![options.node, options.entry, options.home, options.tmpdir].every(absolute))
    throw Error('boundary-config');
  return options.run(
    '/usr/bin/env',
    [
      '-i',
      `HOME=${options.home}`,
      'PATH=/usr/bin:/bin:/usr/sbin:/sbin',
      `TMPDIR=${options.tmpdir}`,
      options.node,
      '--disable-sigusr1',
      options.entry,
    ],
    { env: {}, stdio: 'ignore' },
  );
}
export declare const runProgram: typeof runProgramImpl;
export declare const launchProgram: typeof launchProgramImpl;
declare const exports: {
  runProgram: typeof runProgramImpl;
  launchProgram: typeof launchProgramImpl;
};
exports.runProgram = runProgramImpl;
exports.launchProgram = launchProgramImpl;

async function checkInstalledEntry(argv: string[]): Promise<Result> {
  if (argv.length !== 1 || argv[0] !== '--self-check') return { ok: false, code: 'self-check' };
  try {
    const owner = os.userInfo();
    if (
      !owner.uid ||
      owner.uid !== process.getuid?.() ||
      __filename !== process.argv[1] ||
      !absolute(owner.homedir)
    )
      throw Error();
    const root = path.join(owner.homedir, 'Library/Application Support/Foliome');
    const app = path.join(root, 'app');
    const data = path.join(root, 'data');
    const channel = '/Library/Application Support/Foliome/channel';
    const [sha] = path.relative(path.join(app, 'releases'), __filename).split(path.sep);
    await selfCheck(
      {
        home: owner.homedir,
        app,
        data,
        channel,
        socket: path.join(channel, 'core.sock'),
        database: path.join(data, 'core.db'),
        sshConfig: path.join(data, 'ssh_config'),
        config: path.join(data, 'config.json'),
      },
      sha,
      { installedEntry: __filename },
    );
    return { ok: true };
  } catch {
    return { ok: false, code: 'self-check' };
  }
}

if (require.main === module) {
  void (async () => {
    let result: Result;
    if (!cleanEnvironment(process.env)) result = { ok: false, code: 'boundary-env' };
    else if (process.argv.length > 2) result = await checkInstalledEntry(process.argv.slice(2));
    else {
      const { runInstalled } =
        require('./adapters/system/darwin.ts') as typeof import('./adapters/system/darwin.ts');
      result = await runInstalled(runProgramImpl);
    }
    if (result.ok) {
      if (process.argv.length > 2) process.stdout.write('ok\n');
    } else {
      process.stderr.write(`${result.code}\n`);
      process.exitCode = 1;
    }
  })().catch(() => {
    process.stderr.write('boundary-config\n');
    process.exitCode = 1;
  });
}
