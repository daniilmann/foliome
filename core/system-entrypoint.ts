import type { createInstalledKernel } from './main.ts';

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

function absolute(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value && !value.includes('\0');
}
function validPaths(p: Paths): boolean {
  if (!p || Object.values(p).some(value => !absolute(value))) return false;
  const root = path.join(p.home, 'Library/Application Support/Foliome');
  return p.app === path.join(root, 'app') && p.data === path.join(root, 'data') &&
    p.database === path.join(p.data, 'core.db') && p.sshConfig === path.join(p.data, 'ssh_config') &&
    p.config === path.join(p.data, 'config.json') && p.socket === path.join(p.channel, 'core.sock');
}
function cleanEnvironment(env: NodeJS.ProcessEnv): boolean {
  return Object.keys(env).every(key => ['HOME', 'PATH', 'TMPDIR', '__CF_USER_TEXT_ENCODING'].includes(key));
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
async function readConfig(file: string): Promise<{ source: KernelOptions['source']; executorUid: number }> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600 || stat.size > 65536) throw Error();
    const bytes = Buffer.alloc(65537);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 65536) throw Error();
    const value: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    if (!exact(value, ['source', 'executorUid']) || !Number.isSafeInteger(value.executorUid) || (value.executorUid as number) <= 0 || !exact(value.source, ['url', 'sessionId', 'sourceId', 'accessId', 'instruction'])) throw Error();
    const source = value.source;
    if (Object.values(source).some(v => typeof v !== 'string' || v.length === 0 || v.length > 4096 || /[\u0000-\u001f\u007f]/.test(v))) throw Error();
    const url = new URL(source.url as string);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) throw Error();
    return { source: source as KernelOptions['source'], executorUid: value.executorUid as number };
  } finally { await handle.close(); }
}
async function selfCheck(file: string, live?: string): Promise<void> {
  if (!absolute(file) || file === live) throw Error();
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()) throw Error();
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const current = await fs.lstat(file);
      if (current.ino !== stat.ino || current.dev !== stat.dev || !current.isFile()) throw Error();
      const result = db.prepare('PRAGMA integrity_check').all();
      if (result.length !== 1 || result[0].integrity_check !== 'ok') throw Error();
    } finally { db.close(); }
  } finally { await handle.close(); }
}
async function runProgramImpl(options: { argv: string[]; env: NodeJS.ProcessEnv; paths?: Paths; ports?: Ports }): Promise<Result> {
  if (!cleanEnvironment(options.env)) return { ok: false, code: 'boundary-env' };
  if (options.argv.length === 3 && options.argv[0] === '--self-check' && options.argv[1] === '--database') {
    try { await selfCheck(options.argv[2], options.paths?.database); return { ok: true }; }
    catch { return { ok: false, code: 'self-check' }; }
  }
  if (options.argv.length || !options.paths || !options.ports || !validPaths(options.paths)) return { ok: false, code: 'boundary-config' };
  try {
    const config = await readConfig(options.paths.config);
    const p = options.paths;
    const ports = options.ports;
    await ports.createInstalledKernel({ paths: p, ownerName: os.userInfo().username, executorUid: config.executorUid, source: config.source,
      observeMacOS: ports.observe, launchChrome: ports.launchChrome, runProcess: ports.runProcess });
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error instanceof Error && error.message === 'boundary-permissions' ? 'boundary-permissions' : 'boundary-config' };
  }
}
async function launchProgramImpl(options: { node: string; entry: string; home: string; tmpdir: string; run: (command: string, args: string[], options: { env: Record<string, never>; stdio: 'ignore' }) => Promise<number | null> }) {
  if (![options.node, options.entry, options.home, options.tmpdir].every(absolute)) throw Error('boundary-config');
  return options.run('/usr/bin/env', ['-i', `HOME=${options.home}`, 'PATH=/usr/bin:/bin:/usr/sbin:/sbin', `TMPDIR=${options.tmpdir}`, options.node, '--disable-sigusr1', options.entry], { env: {}, stdio: 'ignore' });
}
export declare const runProgram: typeof runProgramImpl;
export declare const launchProgram: typeof launchProgramImpl;
declare const exports: { runProgram: typeof runProgramImpl; launchProgram: typeof launchProgramImpl };
exports.runProgram = runProgramImpl;
exports.launchProgram = launchProgramImpl;

if (require.main === module) {
  void (async () => {
    let result: Result;
    if (!cleanEnvironment(process.env)) result = { ok: false, code: 'boundary-env' };
    else if (process.argv.slice(2).length) {
      const home = os.userInfo().homedir;
      const data = path.join(home, 'Library/Application Support/Foliome/data');
      result = await runProgramImpl({ argv: process.argv.slice(2), env: process.env, paths: { home, app: path.join(path.dirname(data), 'app'), data, channel: '/Library/Application Support/Foliome/channel', socket: '/Library/Application Support/Foliome/channel/core.sock', database: path.join(data, 'core.db'), sshConfig: path.join(data, 'ssh_config'), config: path.join(data, 'config.json') } });
    } else {
      const { runInstalled } = require('./adapters/system/darwin.ts') as typeof import('./adapters/system/darwin.ts');
      result = await runInstalled(runProgramImpl);
    }
    if (result.ok) { if (process.argv.length > 2) process.stdout.write('ok\n'); }
    else { process.stderr.write(`${result.code}\n`); process.exitCode = 1; }
  })().catch(() => { process.stderr.write('boundary-config\n'); process.exitCode = 1; });
}
