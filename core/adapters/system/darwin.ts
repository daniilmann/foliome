import type { createInstalledKernel } from '../../main.ts';
import type { runProgram } from '../../system-entrypoint.ts';

const fs = require('node:fs/promises') as typeof import('node:fs/promises');
const { constants } = require('node:fs') as typeof import('node:fs');
const path = require('node:path') as typeof import('node:path');
const os = require('node:os') as typeof import('node:os');
const net = require('node:net') as typeof import('node:net');
const { execFile, spawn } = require('node:child_process') as typeof import('node:child_process');
const { classifySystemObservation } = require('../system-observation.ts') as typeof import('../system-observation.ts');
const { startVerifiedChrome } = require('../browser/chrome-start.ts') as typeof import('../browser/chrome-start.ts');
type Options = Parameters<typeof createInstalledKernel>[0];
const system = '/Library/Application Support/Foliome';
const environment = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
function command(file: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => execFile(file, args, { env: environment, timeout: 3000, maxBuffer: 16384, signal }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
async function metadata(): Promise<{ executorName: string; executorUid: number }> {
  const file = path.join(system, 'installation.json');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await handle.stat();
    if (!s.isFile() || s.uid !== 0 || s.nlink !== 1 || (s.mode & 0o7777) !== 0o644 || s.size > 4096) throw Error();
    const content = await handle.readFile('utf8');
    if (Buffer.byteLength(content) > 4096) throw Error();
    const value: unknown = JSON.parse(content);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'executorName,executorUid') throw Error();
    const m = value as { executorName: unknown; executorUid: unknown };
    if (typeof m.executorName !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(m.executorName) || !Number.isSafeInteger(m.executorUid) || (m.executorUid as number) <= 0) throw Error();
    return m as { executorName: string; executorUid: number };
  } finally { await handle.close(); }
}
async function entry(file: string) {
  const stat = await fs.lstat(file);
  const output = await command('/bin/ls', ['-lde', file]);
  const lines = output.trimEnd().split('\n');
  if (lines.length > 8 || lines.some(line => line.length > 1024)) throw Error();
  const acl = lines.slice(1).map(line => line.trim());
  if (acl.some(line => !/^\d+: /.test(line))) throw Error();
  return { type: stat.isDirectory() ? 'directory' : stat.isSocket() ? 'socket' : stat.isSymbolicLink() ? 'symlink' : 'file', uid: stat.uid, mode: stat.mode & 0o7777, links: stat.nlink, acl };
}
async function canary(): Promise<string> {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '192.0.2.1', port: 49151 });
    let done = false;
    const finish = (result: string) => { if (done) return; done = true; socket.destroy(); resolve(result); };
    socket.setTimeout(1000, () => finish('timeout'));
    socket.once('connect', () => finish('connected'));
    socket.once('error', error => finish((error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'refused' : 'unavailable'));
  });
}
async function runInstalledImpl(run: typeof runProgram) {
  if (process.platform !== 'darwin') return { ok: false as const, code: 'boundary-config' };
  const owner = os.userInfo();
  const root = path.join(owner.homedir, 'Library/Application Support/Foliome');
  const data = path.join(root, 'data');
  const channel = path.join(system, 'channel');
  const paths = { home: owner.homedir, app: path.join(root, 'app'), data, channel, socket: path.join(channel, 'core.sock'), database: path.join(data, 'core.db'), sshConfig: path.join(data, 'ssh_config'), config: path.join(data, 'config.json') };
  try {
    const parent = await entry(system);
    if (parent.type !== 'directory' || parent.uid !== 0 || parent.mode !== 0o755 || parent.acl.length) throw Error();
    const installed = await metadata();
    const uid = (await command('/usr/bin/dscl', ['.', '-read', `/Users/${installed.executorName}`, 'UniqueID'])).trim();
    if (uid !== `UniqueID: ${installed.executorUid}`) throw Error();
    const observe: Options['observeMacOS'] = async p => {
      const [home, app, dataEntry, channelEntry, socket, admin, rootEntry] = await Promise.all([
        entry(p.home), entry(p.app), entry(p.data), entry(p.channel), entry(p.socket), command('/usr/bin/dscl', ['.', '-read', '/Groups/admin', 'GroupMembership']), entry(system),
      ]);
      if (rootEntry.type !== 'directory' || rootEntry.uid !== 0 || rootEntry.mode !== 0o755 || rootEntry.acl.length) throw Error();
      const match = /^GroupMembership: ([a-zA-Z0-9_ -]+)\s*$/.exec(admin);
      if (!match) throw Error();
      return classifySystemObservation({ ownerUid: owner.uid, ownerName: owner.username, executorName: installed.executorName, home, app, data: dataEntry, channel: channelEntry, socket, adminMembers: match[1].trim().split(/\s+/), canary: await canary() });
    };
    const launchChrome: Options['launchChrome'] = async () => {
      const result = await startVerifiedChrome({
        verify: async (file, args, signal) => { try { await command(file, args, signal); return true; } catch { return false; } },
        launch: async (options) => {
          const playwright = require('playwright-core') as { chromium: { launch(options: object): Promise<Awaited<ReturnType<Options['launchChrome']>>> } };
          return playwright.chromium.launch(options);
        },
      }, 15000);
      if (!result.ok) throw Error(result.code);
      return result.browser;
    };
    const runProcess: Options['runProcess'] = async (file, args, options) => {
      if (file !== '/usr/bin/ssh' || args.length !== 3 || args[0] !== '-F' || args[1] !== paths.sshConfig || args[2] !== 'executor-core') throw Error();
      return new Promise((resolve, reject) => {
        const child = spawn(file, args, options);
        let settled = false;
        let finish: (code: number | null) => void;
        const finished = new Promise<number | null>(r => { finish = r; });
        child.once('error', () => { if (!settled) { settled = true; reject(Error()); } else finish(null); });
        child.once('exit', code => finish(code));
        child.once('spawn', () => { settled = true; let stopped = false; resolve({ started: true, finished, stop() { if (!stopped) { stopped = true; child.kill(); } } }); });
      });
    };
    const { createInstalledKernel } = require('../../main.ts') as typeof import('../../main.ts');
    return await run({ argv: [], env: process.env, paths, ports: { observe, launchChrome, runProcess, createInstalledKernel: async options => {
      if (options.executorUid !== installed.executorUid) throw Error();
      return createInstalledKernel(options);
    } } });
  } catch { return { ok: false as const, code: 'boundary-config' }; }
}
export declare const runInstalled: typeof runInstalledImpl;
declare const exports: { runInstalled: typeof runInstalledImpl };
exports.runInstalled = runInstalledImpl;
