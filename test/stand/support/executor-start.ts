const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

// Proposed installed entry point in core/main.ts:
// createInstalledKernel({ paths, observeMacOS, runProcess, launchChrome, peerUid,
//   source }) -> Promise<{ openSource, startExecutor, ownerPage, sourcePage, close }>.
// It owns boundary decisions, SQLite, the admitted Unix channel, both Chrome
// contexts, the owner confirmation and the preparation runtime. Only macOS
// observations, fixed process execution, Chrome launch and peer UID are ports.
const owner = 'https://foliome-owner.invalid';
const secretMarker = 'synthetic-private-error';

async function stand(overrides: any, run: (fixture: any) => Promise<void>) {
  const { createInstalledKernel } = require('../../../core/main.ts');
  assert.equal(typeof createInstalledKernel, 'function', 'core/main.ts must expose the installed kernel composition createInstalledKernel');
  const { chromium } = require(process.env.FOLIOME_STAND_PLAYWRIGHT_CORE ?? 'playwright-core');
  const dir = await mkdtemp(join(tmpdir(), 'executor-stand-'));
  const calls: any[] = [];
  const chromeLaunches: any[] = [];
  const clients: any[] = [];
  const paths = { home: join(dir, 'home'), app: join(dir, 'app'), data: join(dir, 'data'), channel: join(dir, 'channel'), socket: join(dir, 'channel.sock'), database: join(dir, 'core.db'), sshConfig: join(dir, 'data', 'ssh_config') };
  const good = { permissions: { home: true, app: true, data: true, channel: true, socket: true }, adminMembers: ['root', 'synthetic-owner'], canary: 'refused' };
  const observation = { ...good, ...overrides.observation };
  let kernel: any;
  const sourceServer = http.createServer((request: any, response: any) => {
    if (request.method !== 'GET' || request.url !== '/overview') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Synthetic source</title><input type="password" aria-label="Synthetic password"><p>Synthetic visible text</p>');
  });
  try {
    sourceServer.listen(0, '127.0.0.1');
    await once(sourceServer, 'listening');
    const sourceUrl = `http://127.0.0.1:${sourceServer.address().port}/overview`;
    kernel = await createInstalledKernel({
      paths,
      ownerName: 'synthetic-owner',
      executorUid: 777,
      observeMacOS: async () => observation,
      runProcess: async (...args: any[]) => { calls.push(args); if (overrides.spawnFails) throw new Error(secretMarker); return 0; },
      launchChrome: async () => { chromeLaunches.push('launch'); return chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, args: ['--disable-gpu'] }); },
      peerUid: async () => 777,
      source: { url: sourceUrl, sessionId: 'synthetic-session', sourceId: 'synthetic-source', accessId: 'synthetic-access', instruction: 'Inspect the synthetic overview' },
    });
    async function connect() {
      const socket = net.createConnection(paths.socket);
      clients.push(socket);
      await once(socket, 'connect');
      let buffer = '';
      let id = 0;
      const pending = new Map<number, (value: any) => void>();
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          pending.get(message.id)?.(message);
          pending.delete(message.id);
        }
      });
      const call = (method: string, params: object) => new Promise<any>(resolve => {
        const requestId = ++id;
        pending.set(requestId, resolve);
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
      });
      await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } });
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      return { call: (name: string) => call('tools/call', { name, arguments: {} }) };
    }
    const db = new DatabaseSync(paths.database, { readOnly: true });
    try {
      assert.ok(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().length > 0, 'installed kernel must initialize SQLite');
    } finally { db.close(); }
    await run({ kernel, paths, calls, chromeLaunches, connect });
  } finally {
    for (const client of clients) client.destroy();
    await kernel?.close();
    if (sourceServer.listening) await new Promise<void>(resolve => sourceServer.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

export declare const executorStand: typeof stand;
export declare const ownerOrigin: typeof owner;
export declare const privateMarker: typeof secretMarker;
exports.executorStand = stand;
exports.ownerOrigin = owner;
exports.privateMarker = secretMarker;
