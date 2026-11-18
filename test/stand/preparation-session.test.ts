const assert = require('node:assert/strict');
const test = require('node:test');
const net = require('node:net');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const origin = 'https://cabinet.invalid';
const owner = 'https://foliome-owner.invalid';
const scope = { sessionId: 'synthetic-session', sourceId: 'synthetic-source', accessId: 'synthetic-access' };
const instruction = 'Inspect the synthetic overview';

type Collector = Awaited<ReturnType<typeof import('../../core/adapters/browser/collect-dom.ts').prepareDomCollector>>;
type BrowserPort = {
  openSource(): Promise<void>;
  closeSource(): Promise<void>;
  collectFrame: Collector['collectFrame'];
  observeTargets: Collector['observeTargets'];
  readObservedTarget: Collector['readObservedTarget'];
  loginObservations: Collector['loginObservations'];
  finishLoginObservation: Collector['finishLoginObservation'];
  capturePng(): Promise<Buffer>;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function stand(run: (f: any) => Promise<void>) {
  // Runtime is the missing composition under test, not a fixture implementation.
  const { createPreparationRuntime } = require('../../core/main.ts');
  const { chromium } = require(process.env.FOLIOME_STAND_PLAYWRIGHT_CORE ?? 'playwright-core');
  const { prepareDomCollector } = require('../../core/adapters/browser/collect-dom.ts');
  const { attachOwnerWindow } = require('../../core/adapters/ui/owner-window.ts');
  const { createAdmittedChannel } = require('../../core/adapters/channel/admission.ts');
  const { createActionProtocol } = require('../../core/adapters/store/action-protocol.ts');
  const { createTextSnapshotStore } = require('../../core/adapters/store/text-snapshot-store.ts');
  const sourceBrowser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, args: ['--disable-gpu'] });
  let ownerBrowser: any;
  let server: any;
  let runtime: any;
  let directory: string | undefined;
  const clients: any[] = [];
  const db = new DatabaseSync(':memory:');
  const closeGate = deferred();
  const closing = deferred();
  let delayClose = false;
  let collector: Collector | undefined;
  let sourcePage: any;
  let replaceOnObserve = false;
  let snapshotObserveCalls = 0;
  let successfulReads = 0;
  const secret = randomBytes(16).toString('hex');
  try {
    ownerBrowser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, args: ['--disable-gpu'] });
    const sourceContext = await sourceBrowser.newContext({ viewport: { width: 640, height: 360 }, serviceWorkers: 'block' });
    const ownerContext = await ownerBrowser.newContext({ serviceWorkers: 'block' });
    await sourceContext.route('**/*', async (route: any) => {
      if (route.request().method() === 'GET' && route.request().url() === `${origin}/overview`) {
        await route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Synthetic overview</title><input type="password" aria-label="Synthetic password"><p id="target">Synthetic visible text</p><button type="button" id="replace">Replace synthetic node</button><script>
          document.getElementById('replace').addEventListener('click', () => {
            const target = document.getElementById('target'); target.replaceWith(target.cloneNode(true));
          });
        </script>` });
      } else await route.abort();
    });
    await ownerContext.route('**/*', (route: any) => route.abort());
    const ownerPage = await ownerContext.newPage();
    let cdp: any;
    const browser: BrowserPort = {
      async openSource() {
        sourcePage = await sourceContext.newPage();
        cdp = await sourceContext.newCDPSession(sourcePage);
        collector = await prepareDomCollector(cdp, { sourceHost: 'cabinet.invalid', approvedHosts: [] });
        await sourcePage.goto(`${origin}/overview`);
      },
      async closeSource() {
        closing.resolve();
        if (delayClose) await closeGate.promise;
        await collector?.close();
        await sourcePage?.close();
      },
      collectFrame: n => collector!.collectFrame(n),
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
      capturePng: async () => Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'),
    };
    const protocol = createActionProtocol(db, () => 1234);
    const store = createTextSnapshotStore(db, () => 1234);
    let executorRunning = true; // Fixed lifecycle only; no executor is started.
    runtime = createPreparationRuntime({ browser, protocol, store, now: () => Date.now(), sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)), executorRunning: () => executorRunning }, { ...scope, instruction });
    const controller = await attachOwnerWindow({ context: ownerContext, page: ownerPage, rows: () => runtime.rows(), onLoginComplete: (id: string) => runtime.confirmLogin(id) });
    server = createAdmittedChannel({ expectedUid: process.getuid!(), maxLineBytes: 65536, createHandler: () => runtime.createHandler(), onDenied: () => {} });
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
          const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          pending.get(message.id)?.(message); pending.delete(message.id);
        }
      });
      const call = (method: string, params: object) => new Promise<any>(resolve => {
        const requestId = ++id; pending.set(requestId, resolve);
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
      });
      await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } });
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      return { call: (name: string, args: object = {}) => call('tools/call', { name, arguments: args }) };
    }
    async function login() {
      await sourcePage.getByLabel('Synthetic password').fill(secret);
      await runtime.observeSnapshot();
      controller.begin({ sessionId: scope.sessionId, nonce: 'synthetic-nonce' });
      await ownerPage.goto(`${owner}/`);
      await ownerPage.getByRole('button', { name: 'Вход завершён, продолжить' }).click();
    }
    await run({ runtime, connect, login, db, ownerPage, sourcePage: () => sourcePage, collector: () => collector!, armReplacement: () => { replaceOnObserve = true; }, disarmReplacement: () => { replaceOnObserve = false; }, snapshotObserveCalls: () => snapshotObserveCalls, successfulReads: () => successfulReads, secret, closing, delayClose: () => { delayClose = true; }, releaseClose: closeGate.resolve, executorRunning: () => executorRunning });
    executorRunning = false;
  } finally {
    closeGate.resolve();
    for (const client of clients) client.destroy();
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await runtime?.shutdown();
    db.close();
    await ownerBrowser?.close();
    await sourceBrowser.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

function errorCode(response: any) {
  assert.equal(response.result?.isError, true);
  return response.result.content[0].text;
}

function snapshotFrom(response: any) {
  assert.equal(response.result?.isError, undefined);
  return response.result.content.filter((part: any) => part.type === 'text').map((part: any) => {
    try { return JSON.parse(part.text); } catch { return null; }
  }).find((value: any) => value && Number.isSafeInteger(value.snapshot));
}

test('отказывает до открытия и после ручного входа проверяет первое задание по каналу первый нумерованный фильтрованный снимок и переход к readText без доступа к секретам', { timeout: 60_000 }, async () => {
  await stand(async ({ runtime, connect, login, db, secret }: any) => {
    const client = await connect();
    assert.equal(errorCode(await client.call('current_task')), 'session-unavailable');
    assert.equal(errorCode(await client.call('snapshot')), 'session-unavailable');
    await runtime.open();
    assert.equal(errorCode(await client.call('current_task')), 'session-unavailable');
    await login();
    const task = await client.call('current_task');
    assert.deepEqual(JSON.parse(task.result.content[0].text), { type: 'preparation', sourceId: scope.sourceId, instruction });
    const result = await client.call('snapshot');
    const snapshot = snapshotFrom(result);
    assert.equal(snapshot.snapshot, 1);
    assert.ok(!JSON.stringify(result).includes(secret));
    const image = result.result.content.find((part: any) => part.type === 'image');
    assert.equal(image?.mimeType, 'image/png');
    assert.deepEqual(Buffer.from(image.data, 'base64').subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const target = snapshot.elements.find((element: any) => element.text.includes('Synthetic visible text'));
    assert.ok(target?.n > 0);
    const read = await client.call('readText', { snapshotNumber: snapshot.snapshot, nodeNumber: target.n });
    assert.ok(read.result.content.some((part: any) => part.text === 'Synthetic visible text'));
    assert.equal(snapshotFrom(read).snapshot, 2);
    assert.ok(!JSON.stringify(read).includes(secret));
    const verdict = db.prepare('SELECT snapshot_number, node_number, decision, reason FROM action_verdicts ORDER BY id DESC LIMIT 1').get();
    assert.deepEqual({ ...verdict }, { snapshot_number: 1, node_number: target.n, decision: 'allowed', reason: 'allowed' });
    assert.equal(db.prepare('SELECT status FROM action_outcomes ORDER BY verdict_id DESC LIMIT 1').get().status, 'ok');
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM text_snapshots').all()).includes(secret));
  });
});

test('закрывает окно и отказывает старому и новому соединениям пока исполнитель работает', { timeout: 60_000 }, async () => {
  await stand(async ({ runtime, connect, login, sourcePage, ownerPage, closing, delayClose, releaseClose, executorRunning }: any) => {
    await runtime.open();
    await login();
    const old = await connect();
    assert.ok((await old.call('current_task')).result.content);
    delayClose();
    const closed = runtime.closeSource();
    await closing.promise;
    assert.equal(executorRunning(), true);
    assert.equal(errorCode(await old.call('current_task')), 'session-unavailable');
    const fresh = await connect();
    assert.equal(errorCode(await fresh.call('snapshot')), 'session-unavailable');
    releaseClose();
    await closed;
    assert.equal(sourcePage().isClosed(), true);
    assert.equal(ownerPage.isClosed(), false);
    await ownerPage.goto(`${owner}/`);
    assert.equal(errorCode(await old.call('current_task')), 'session-unavailable');
    assert.equal(errorCode(await fresh.call('current_task')), 'session-unavailable');
  });
});

test('замена идентичного узла после защищённого снимка не привязывает старый номер к новому объекту', { timeout: 60_000 }, async () => {
  await stand(async ({ runtime, connect, login, sourcePage, collector, armReplacement, disarmReplacement, snapshotObserveCalls, successfulReads }: any) => {
    await runtime.open();
    await login();
    const client = await connect();
    const before = await collector().observeTargets(1);
    const target = before.candidates.find((item: any) => item.text === 'Synthetic visible text');
    assert.ok(target);
    armReplacement();
    const response = await client.call('snapshot');
    const snapshot = snapshotFrom(response);
    assert.equal(snapshot.snapshot, 1);
    assert.equal(snapshot.elements.find((item: any) => item.text === target.text)?.n, target.nodeNumber);
    assert.equal(response.result.content.find((part: any) => part.type === 'image')?.mimeType, 'image/png');
    disarmReplacement();
    if (snapshotObserveCalls() === 0) await sourcePage().getByRole('button', { name: 'Replace synthetic node' }).click();
    const after = await collector().observeTargets(1);
    const replacement = after.candidates.find((item: any) => item.nodeNumber === target.nodeNumber);
    assert.equal(replacement.text, target.text);
    assert.equal(replacement.descriptor, target.descriptor);
    assert.notEqual(replacement.identity, target.identity);
    assert.deepEqual(await collector().readObservedTarget(1, target.nodeNumber, target), { ok: false, code: 'stale' });
    assert.equal(successfulReads(), 0);
    const read = await client.call('readText', { snapshotNumber: 1, nodeNumber: target.nodeNumber });
    assert.deepEqual({ isError: read.result?.isError, code: read.result?.content?.[0]?.text, successfulReads: successfulReads(), snapshotObserveCalls: snapshotObserveCalls() },
      { isError: true, code: 'stale', successfulReads: 0, snapshotObserveCalls: 0 });
  });
});
