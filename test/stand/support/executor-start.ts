const assert = require('node:assert/strict');
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

// Installed composition under test: createInstalledKernel({ paths, ownerName,
// executorUid, observeMacOS, runProcess, launchChrome, peerUid?, source }) returns
// { ownerPage, sourcePage, close }. Owner actions open the source and start executor.
const owner = 'https://foliome-owner.invalid';
const sourceUrl = 'https://cabinet.invalid/overview';
const secretMarker = 'synthetic-private-error';
const timeout = 10_000;

async function eventually(check: () => Promise<boolean> | boolean, message: string) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

async function stand(overrides: any, run: (fixture: any) => Promise<void>) {
  const { createInstalledKernel } = require('../../../core/main.ts');
  assert.equal(typeof createInstalledKernel, 'function', 'core/main.ts must expose the installed kernel composition createInstalledKernel');
  const { chromium } = require(process.env.FOLIOME_STAND_PLAYWRIGHT_CORE ?? 'playwright-core');
  const dir = await mkdtemp(join(tmpdir(), 'executor-stand-'));
  const calls: any[] = [];
  const chromeLaunches: any[] = [];
  const clients: any[] = [];
  let finishProcess!: (code: number | null) => void;
  const finished = new Promise<number | null>(resolve => { finishProcess = resolve; });
  let stops = 0;
  const processHandle = { started: true, finished, stop: async () => { stops++; finishProcess(null); } };
  const paths = { home: join(dir, 'home'), app: join(dir, 'app'), data: join(dir, 'data'), channel: join(dir, 'channel'), socket: join(dir, 'channel.sock'), database: join(dir, 'core.db'), sshConfig: join(dir, 'data', 'ssh_config') };
  const good = { permissions: { home: true, app: true, data: true, channel: true, socket: true }, adminMembers: ['root', 'synthetic-owner'], canary: 'refused' };
  const observation = { ...good, ...overrides.observation };
  const executorUid = process.platform === 'darwin' && process.getuid ? process.getuid() : 777;
  let kernel: any;
  try {
    kernel = await createInstalledKernel({
      paths, ownerName: 'synthetic-owner', executorUid,
      observeMacOS: async () => observation,
      runProcess: async (...args: any[]) => { calls.push(args); if (overrides.spawnFails) throw new Error(secretMarker); return overrides.processResult ?? processHandle; },
      launchChrome: async () => {
        chromeLaunches.push('launch');
        const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, args: ['--disable-gpu'] });
        const newContext = browser.newContext.bind(browser);
        browser.newContext = async (...args: any[]) => {
          const context = await newContext(...args);
          // Registered first: product owner-window routing retains priority.
          await context.route('**/*', async (route: any) => {
            if (route.request().method() === 'GET' && route.request().url() === sourceUrl) {
              await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic source</title><input type="password" aria-label="Synthetic password"><p>Synthetic visible text</p>' });
            } else await route.abort();
          });
          return context;
        };
        return browser;
      },
      ...(process.platform === 'darwin' && process.getuid ? {} : { peerUid: async () => executorUid }),
      source: { url: sourceUrl, sessionId: 'synthetic-session', sourceId: 'synthetic-source', accessId: 'synthetic-access', instruction: 'Inspect the synthetic overview' },
    });
    async function connect() {
      const socket = net.createConnection(paths.socket);
      clients.push(socket);
      socket.on('error', () => {});
      const timer = setTimeout(() => socket.destroy(new Error('connect timeout')), timeout);
      try { await once(socket, 'connect'); } finally { clearTimeout(timer); }
      let buffer = '';
      let id = 0;
      const pending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void }>();
      socket.on('close', () => { for (const item of pending.values()) item.reject(new Error('channel closed')); pending.clear(); });
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          pending.get(message.id)?.resolve(message);
          pending.delete(message.id);
        }
      });
      const call = (method: string, params: object) => new Promise<any>((resolve, reject) => {
        if (socket.destroyed) { reject(new Error('channel closed')); return; }
        const requestId = ++id;
        const deadline = setTimeout(() => { pending.delete(requestId); reject(new Error('channel timeout')); }, timeout);
        pending.set(requestId, { resolve: value => { clearTimeout(deadline); resolve(value); }, reject: error => { clearTimeout(deadline); reject(error); } });
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
      });
      const initialized = await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } });
      assert.equal(initialized.result?.protocolVersion, '2025-11-25');
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      return { call: (name: string) => call('tools/call', { name, arguments: {} }) };
    }
    const db = new DatabaseSync(paths.database, { readOnly: true });
    try { assert.ok(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().length > 0, 'installed kernel must initialize SQLite'); }
    finally { db.close(); }
    await run({ kernel, paths, calls, chromeLaunches, connect, finishProcess, stopCount: () => stops });
  } finally {
    for (const client of clients) client.destroy();
    await kernel?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

export declare const executorStand: typeof stand;
export declare const ownerOrigin: typeof owner;
export declare const privateMarker: typeof secretMarker;
export declare const waitUntil: typeof eventually;
exports.executorStand = stand;
exports.ownerOrigin = owner;
exports.privateMarker = secretMarker;
exports.waitUntil = eventually;
