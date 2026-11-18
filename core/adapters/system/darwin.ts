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
type SocketOptions = { path: string; handler(socket: import('node:net').Socket): void; configure(file: string): Promise<void>; recoverStale?: boolean };
type Stat = Awaited<ReturnType<typeof fs.lstat>>;
const sameSocket = (a: Stat, b: Stat) => a.isSocket() && b.isSocket() && a.dev === b.dev && a.ino === b.ino;
async function socketLease(file: string, lost: () => void): Promise<() => Promise<void>> {
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  const name = createHash('sha256').update(path.basename(file)).digest('hex').slice(0, 24);
  const lock = path.join(path.dirname(file), `.lock-${name}`);
  const handle = await fs.open(lock, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const stat = await handle.stat();
    const current = await fs.lstat(lock);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || stat.dev !== current.dev || stat.ino !== current.ino) throw Error();
    child = spawn('/usr/bin/perl', ['-e', 'open(my $f, "+<&=3") or exit 1; flock($f, 6) or exit 1; $|=1; print "locked\n"; while (sysread(STDIN, my $b, 256)) {}'], { env: {}, stdio: ['pipe', 'pipe', 'ignore', handle.fd] });
    const processChild = child;
    processChild.stdin!.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => finish(false), 1000);
      const finish = (ok: boolean) => { clearTimeout(timer); processChild.stdout!.off('data', data); processChild.off('exit', fail); processChild.off('error', fail); ok ? resolve() : reject(Error()); };
      const fail = () => finish(false);
      const data = (chunk: Buffer) => { output += chunk.toString(); if (output === 'locked\n') finish(true); else if (!'locked\n'.startsWith(output)) finish(false); };
      processChild.stdout!.on('data', data);
      processChild.once('exit', fail);
      processChild.once('error', fail);
    });
    const after = await fs.lstat(lock);
    if (after.dev !== stat.dev || after.ino !== stat.ino || !after.isFile() || after.uid !== stat.uid || after.nlink !== 1 || (after.mode & 0o7777) !== 0o600) throw Error();
    let releasing = false;
    processChild.once('exit', () => { if (!releasing) lost(); });
    if (processChild.exitCode !== null || processChild.signalCode !== null) throw Error();
    await handle.close();
    return async () => {
      releasing = true;
      if (processChild.exitCode !== null || processChild.signalCode !== null) return;
      await new Promise<void>(resolve => { processChild.once('exit', () => resolve()); processChild.stdin!.end(); });
    };
  } catch (error) {
    child?.kill();
    await handle.close();
    throw error;
  }
}
async function refused(file: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection(file);
    let done = false;
    const finish = (value: boolean) => { if (done) return; done = true; socket.destroy(); resolve(value); };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(false));
    socket.once('error', error => finish((error as NodeJS.ErrnoException).code === 'ECONNREFUSED'));
  });
}
async function openSocket(options: SocketOptions): Promise<{ ok: true; close(): Promise<void> } | { ok: false; code: 'unavailable' }> {
  let release: (() => Promise<void>) | undefined;
  let stageDir: string | undefined;
  let stage: string | undefined;
  let bound: Stat | undefined;
  let ready = false;
  let leaseLost = false;
  let closePromise: Promise<void> | undefined;
  const clients = new Set<import('node:net').Socket>();
  const server = net.createServer({ pauseOnConnect: true }, socket => {
    clients.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => clients.delete(socket));
    if (!ready) socket.destroy();
    else options.handler(socket);
  });
  server.on('error', () => {});
  const close = () => closePromise ??= (async () => {
    ready = false;
    for (const client of clients) client.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    if (bound) {
      try { if (sameSocket(bound, await fs.lstat(options.path))) await fs.unlink(options.path); } catch { /* Preserve anything we cannot identify. */ }
    }
    if (stageDir) { try { await fs.rmdir(stageDir); } catch { /* Leave unexpected entries untouched. */ } }
    await release?.();
  })();
  try {
    release = await socketLease(options.path, () => { leaseLost = true; if (ready) void close(); });
    let existing: Stat | undefined;
    try { existing = await fs.lstat(options.path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (existing) {
      if (!options.recoverStale || !existing.isSocket() || existing.uid !== process.getuid?.() || existing.nlink !== 1 || !await refused(options.path)) throw Error();
      const current = await fs.lstat(options.path);
      if (leaseLost || !sameSocket(existing, current) || current.uid !== existing.uid || current.nlink !== 1) throw Error();
      await fs.unlink(options.path);
    }
    stageDir = await fs.mkdtemp(path.join(path.dirname(options.path), '.s'));
    await fs.chmod(stageDir, 0o700);
    stage = path.join(stageDir, 's');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(stage!, () => { server.off('error', reject); resolve(); });
    });
    bound = await fs.lstat(stage);
    if (!bound.isSocket() || bound.uid !== process.getuid?.() || bound.nlink !== 1) throw Error();
    await options.configure(stage);
    const configured = await fs.lstat(stage);
    if (!sameSocket(bound, configured) || configured.uid !== bound.uid || configured.nlink !== 1) throw Error();
    if (leaseLost) throw Error();
    await fs.link(stage, options.path);
    const published = await fs.lstat(options.path);
    const staged = await fs.lstat(stage);
    if (!sameSocket(bound, published) || !sameSocket(bound, staged) || published.nlink !== 2 || staged.nlink !== 2 || published.uid !== bound.uid) throw Error();
    await fs.unlink(stage);
    const final = await fs.lstat(options.path);
    if (!sameSocket(bound, final) || final.uid !== bound.uid || final.nlink !== 1) throw Error();
    await new Promise<void>(resolve => setImmediate(resolve));
    if (leaseLost) throw Error();
    ready = true;
    return { ok: true, close };
  } catch {
    await close();
    return { ok: false, code: 'unavailable' };
  }
}
function socketConfiguration(ownerUid: number, executorName: string) {
  if (!Number.isSafeInteger(ownerUid) || ownerUid < 0 || !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(executorName)) throw Error('boundary-config');
  return async (file: string) => {
    const original = await fs.lstat(file);
    const same = (s: typeof original) => s.isSocket() && s.uid === ownerUid && s.nlink === 1 && s.dev === original.dev && s.ino === original.ino;
    if (!same(original)) throw Error('boundary-permissions');
    await command('/bin/chmod', ['-N', file]);
    if (!same(await fs.lstat(file))) throw Error('boundary-permissions');
    await command('/bin/chmod', ['600', file]);
    if (!same(await fs.lstat(file))) throw Error('boundary-permissions');
    await command('/bin/chmod', ['+a', `${executorName} allow write`, file]);
    const observed = await entry(file);
    const final = await fs.lstat(file);
    if (!same(final) || observed.type !== 'socket' || observed.uid !== ownerUid || observed.links !== 1 || observed.mode !== 0o600 || observed.acl.length !== 1 || observed.acl[0] !== `0: user:${executorName} allow write` || (final.mode & 0o7777) !== 0o600) throw Error('boundary-permissions');
  };
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
    if (parent.type !== 'directory' || parent.uid !== 0 || parent.mode !== 0o755 || parent.acl.length) return { ok: false as const, code: 'boundary-permissions' };
    const installed = await metadata();
    if (installed.executorUid === owner.uid || installed.executorName === owner.username) throw Error();
    const uid = (await command('/usr/bin/dscl', ['.', '-read', `/Users/${installed.executorName}`, 'UniqueID'])).trim();
    if (uid !== `UniqueID: ${installed.executorUid}`) throw Error();
    const channelEntry = await entry(channel);
    if (channelEntry.type !== 'directory' || channelEntry.uid !== owner.uid || channelEntry.mode !== 0o700 || channelEntry.acl.length !== 1 || channelEntry.acl[0] !== `0: user:${installed.executorName} allow search`) return { ok: false as const, code: 'boundary-permissions' };
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
      return createInstalledKernel({ ...options, configureSocket: socketConfiguration(owner.uid, installed.executorName) });
    } } });
  } catch { return { ok: false as const, code: 'boundary-config' }; }
}
export declare const runInstalled: typeof runInstalledImpl;
export declare const openSystemSocket: typeof openSocket;
export declare const createSocketConfiguration: typeof socketConfiguration;
declare const exports: { runInstalled: typeof runInstalledImpl; openSystemSocket: typeof openSocket; createSocketConfiguration: typeof socketConfiguration };
exports.runInstalled = runInstalledImpl;
exports.openSystemSocket = openSocket;
exports.createSocketConfiguration = socketConfiguration;
