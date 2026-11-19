const net = require('node:net');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const origin = 'https://cabinet.invalid';
const ownerOrigin = 'https://foliome-owner.invalid';
const fixtureScope = {
  sessionId: 'synthetic-session',
  sourceId: 'synthetic-source',
  accessId: 'synthetic-access',
};
const fixtureInstruction = 'Inspect the synthetic overview';

type Collector = Awaited<
  ReturnType<typeof import('../../../core/adapters/browser/collect-dom.ts').prepareDomCollector>
>;
type BrowserPort = {
  openSource(): Promise<void>;
  closeSource(): Promise<void>;
  collectFrame: Collector['collectFrame'];
  observeTargets: Collector['observeTargets'];
  readObservedTarget: Collector['readObservedTarget'];
  loginObservations: Collector['loginObservations'];
  finishLoginObservation: Collector['finishLoginObservation'];
  capturePng(
    viewport?: import('../../../core/adapters/browser/capture-snapshot.ts').Viewport,
  ): Promise<Buffer>;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

async function runStand(run: (f: any) => Promise<void>) {
  // Runtime is the missing composition under test, not a fixture implementation.
  const { createPreparationRuntime } = require('../../../core/main.ts');
  const { chromium } = require(process.env.FOLIOME_STAND_PLAYWRIGHT_CORE ?? 'playwright-core');
  const { prepareDomCollector } = require('../../../core/adapters/browser/collect-dom.ts');
  const { captureViewportPng } = require('../../../core/adapters/browser/capture-snapshot.ts');
  const { attachOwnerWindow } = require('../../../core/adapters/ui/owner-window.ts');
  const { createAdmittedChannel } = require('../../../core/adapters/channel/admission.ts');
  const { createActionProtocol } = require('../../../core/adapters/store/action-protocol.ts');
  const {
    createTextSnapshotStore,
  } = require('../../../core/adapters/store/text-snapshot-store.ts');
  const sourceBrowser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    chromiumSandbox: true,
    args: ['--disable-gpu'],
  });
  let ownerBrowser: any;
  let server: any;
  let runtime: any;
  let directory: string | undefined;
  const clients: any[] = [];
  const db = new DatabaseSync(':memory:');
  const closeGate = deferred();
  const closing = deferred();
  let delayClose = false;
  let failCapture = false;
  let failCollect = false;
  let failClose = false;
  let collector: Collector | undefined;
  let sourcePage: any;
  let replaceOnObserve = false;
  let snapshotObserveCalls = 0;
  let successfulReads = 0;
  const secret = randomBytes(16).toString('hex');
  try {
    ownerBrowser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      chromiumSandbox: true,
      args: ['--disable-gpu'],
    });
    const sourceContext = await sourceBrowser.newContext({
      viewport: { width: 640, height: 360 },
      serviceWorkers: 'block',
    });
    const ownerContext = await ownerBrowser.newContext({ serviceWorkers: 'block' });
    await sourceContext.route('**/*', async (route: import('playwright-core').Route) => {
      if (route.request().method() === 'GET' && route.request().url() === `${origin}/overview`) {
        await route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><title>Synthetic overview</title><input type="password" aria-label="Synthetic password"><p id="target">Synthetic visible text</p><button type="button" id="replace">Replace synthetic node</button><script>
          document.getElementById('replace').addEventListener('click', () => {
            const target = document.getElementById('target'); target.replaceWith(target.cloneNode(true));
          });
        </script>`,
        });
      } else await route.abort();
    });
    await ownerContext.route('**/*', (route: import('playwright-core').Route) => route.abort());
    const ownerPage = await ownerContext.newPage();
    let cdp: any;
    const sends: { method: string; params: unknown }[] = [];
    const browser: BrowserPort = {
      async openSource() {
        sourcePage = await sourceContext.newPage();
        cdp = await sourceContext.newCDPSession(sourcePage);
        collector = await prepareDomCollector(
          {
            send: (method: string, params?: Record<string, unknown>) => {
              sends.push({ method, params });
              return cdp.send(method, params);
            },
            on: cdp.on.bind(cdp),
            off: cdp.off.bind(cdp),
            detach: cdp.detach.bind(cdp),
          },
          { sourceHost: 'cabinet.invalid', approvedHosts: [] },
        );
        await sourcePage.goto(`${origin}/overview`);
      },
      async closeSource() {
        closing.resolve();
        if (delayClose) await closeGate.promise;
        if (failClose) throw new Error('synthetic close failure');
        await collector?.close();
        await sourcePage?.close();
      },
      collectFrame: (n) => {
        if (failCollect) throw new Error('synthetic collection failure');
        return collector!.collectFrame(n);
      },
      async observeTargets(n) {
        if (replaceOnObserve) {
          replaceOnObserve = false;
          snapshotObserveCalls++;
          await sourcePage.getByRole('button', { name: 'Replace synthetic node' }).click();
        }
        return collector!.observeTargets(n);
      },
      async readObservedTarget(n, node, proof, deep) {
        const result = await collector!.readObservedTarget(n, node, proof, deep);
        if (result.ok) successfulReads++;
        return result;
      },
      loginObservations: () => collector!.loginObservations(),
      finishLoginObservation: () => collector!.finishLoginObservation(),
      capturePng: (viewport) => {
        if (failCapture) throw new Error('synthetic capture unavailable');
        return captureViewportPng(cdp, viewport);
      },
    };
    const protocol = createActionProtocol(db, () => 1234);
    const store = createTextSnapshotStore(db, () => 1234);
    let executorRunning = true; // Fixed lifecycle only; no executor is started.
    runtime = createPreparationRuntime(
      {
        browser,
        protocol,
        store,
        now: () => Date.now(),
        sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
        executorRunning: () => executorRunning,
      },
      { ...fixtureScope, instruction: fixtureInstruction },
    );
    const controller = await attachOwnerWindow({
      context: ownerContext,
      page: ownerPage,
      rows: () => runtime.rows(),
      onLoginComplete: (id: string) => runtime.confirmLogin(id),
    });
    server = createAdmittedChannel({
      expectedUid: process.getuid!(),
      maxLineBytes: 65536,
      createHandler: () => runtime.createHandler(),
      onDenied: () => {},
    });
    directory = await mkdtemp(join(tmpdir(), 'preparation-stand-'));
    const path = join(directory, 'channel.sock');
    server.listen(path);
    await once(server, 'listening');
    async function connect() {
      const socket = net.createConnection(path);
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
      const call = (method: string, params: object) =>
        new Promise<any>((resolve) => {
          const requestId = ++id;
          pending.set(requestId, resolve);
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
        });
      await call('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'synthetic', version: '1' },
      });
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      return {
        call: (name: string, args: object = {}) => call('tools/call', { name, arguments: args }),
      };
    }
    async function login() {
      await sourcePage.getByLabel('Synthetic password').fill(secret);
      await runtime.observeSnapshot();
      controller.begin({ sessionId: fixtureScope.sessionId, nonce: 'synthetic-nonce' });
      await ownerPage.goto(`${ownerOrigin}/`);
      await ownerPage.getByRole('button', { name: 'Вход завершён, продолжить' }).click();
    }
    await run({
      runtime,
      connect,
      login,
      db,
      ownerPage,
      sourcePage: () => sourcePage,
      collector: () => collector!,
      armReplacement: () => {
        replaceOnObserve = true;
      },
      disarmReplacement: () => {
        replaceOnObserve = false;
      },
      snapshotObserveCalls: () => snapshotObserveCalls,
      successfulReads: () => successfulReads,
      secret,
      closing,
      delayClose: () => {
        delayClose = true;
      },
      releaseClose: closeGate.resolve,
      setCaptureFailure: (value: boolean) => {
        failCapture = value;
      },
      setCollectFailure: (value: boolean) => {
        failCollect = value;
      },
      setCloseFailure: (value: boolean) => {
        failClose = value;
      },
      executorRunning: () => executorRunning,
      sends,
      clearSends: () => {
        sends.length = 0;
      },
    });
    executorRunning = false;
  } finally {
    closeGate.resolve();
    for (const client of clients) client.destroy();
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime?.shutdown().catch(() => {});
    db.close();
    await ownerBrowser?.close();
    await sourceBrowser.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

export declare const stand: typeof runStand;
export declare const scope: typeof fixtureScope;
export declare const instruction: typeof fixtureInstruction;
export declare const owner: typeof ownerOrigin;

exports.stand = runStand;
exports.scope = fixtureScope;
exports.instruction = fixtureInstruction;
exports.owner = ownerOrigin;
