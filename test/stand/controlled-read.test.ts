const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const origin = 'https://cabinet.invalid';
const scope = { sessionId: 'synthetic-session', sourceId: 'synthetic-source', accessId: 'synthetic-access' };
type Observation = Awaited<ReturnType<Awaited<ReturnType<typeof import('../../core/adapters/browser/collect-dom.ts').prepareDomCollector>>['observeTargets']>>;
type BoundSnapshot = Observation & typeof scope;
type Proof = { identity: string; descriptor: string };

async function stand(run: (fixture: any) => Promise<void>) {
  const { chromium } = require(process.env.FOLIOME_STAND_PLAYWRIGHT_CORE ?? 'playwright-core');
  const { prepareDomCollector } = require('../../core/adapters/browser/collect-dom.ts');
  const { filterTextSnapshot } = require('../../core/domain/snapshot-filter.ts');
  const { createActionProtocol } = require('../../core/adapters/store/action-protocol.ts');
  const { createTextSnapshotStore } = require('../../core/adapters/store/text-snapshot-store.ts');
  const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, args: ['--disable-gpu'] });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      await context.route('**/*', async (route: any) => {
        if (route.request().method() === 'GET' && route.request().url() === `${origin}/overview`) {
          await route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Synthetic overview</title>
            <p id="target">Synthetic visible text</p><button id="replace" type="button">Replace</button>
            <script>document.getElementById('replace').addEventListener('click', () => {
              const old = document.getElementById('target'); old.replaceWith(old.cloneNode(true));
            });</script>` });
        } else await route.abort();
      });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      const collector = await prepareDomCollector(cdp, { sourceHost: 'cabinet.invalid', approvedHosts: [] });
      const db = new DatabaseSync(':memory:');
      try {
        await page.goto(`${origin}/overview`, { waitUntil: 'load' });
        const protocol = createActionProtocol(db, () => 1234);
        const store = createTextSnapshotStore(db, () => 1234);
        let effectCounter = 0;
        let session = { ...scope, sessionActive: true, loginStep: false, snapshotNumber: 7 };
        let replaceBeforeRead = false;
        let failOutcome = false;
        let invalidations = 0;
        let readCalls = 0;
        let readProof: Proof | undefined;
        let readResult: any;
        // Observation is benign; only read represents the controlled effect.
        const collectTarget = Object.assign(
          async (snapshotNumber: number) => collector.observeTargets(snapshotNumber),
          { read: async (snapshotNumber: number, nodeNumber: number, proof: Proof, deep?: boolean) => {
            const verdict = db.prepare('SELECT id, decision, reason FROM action_verdicts ORDER BY id DESC LIMIT 1').get();
            assert.equal(verdict?.decision, 'allowed');
            assert.equal(verdict?.reason, 'allowed');
            assert.equal(db.prepare('SELECT count(*) AS n FROM action_outcomes WHERE verdict_id = ?').get(verdict.id).n, 0);
            readCalls++;
            readProof = proof;
            if (replaceBeforeRead) await page.getByRole('button', { name: 'Replace' }).click();
            if (failOutcome) db.exec('PRAGMA query_only = ON');
            const result = await collector.readObservedTarget(snapshotNumber, nodeNumber, proof, deep);
            readResult = result;
            if (result.ok) effectCounter++;
            return result;
          } },
        );
        const captureSnapshot = async (snapshotNumber: number) => {
          const result = filterTextSnapshot(await collector.collectText(snapshotNumber));
          assert.equal(result.ok, true);
          return { ok: true, snapshot: result.snapshot, image: { code: 'login-step' } };
        };
        const persistSnapshot = async (result: any) => store.append({ ...scope, result: { ok: true, snapshot: result.snapshot } });
        await run({ page, collector, db, store, ports: { getSession: () => session, collectTarget, captureSnapshot, protocol, persistSnapshot,
          onProtocolUnavailable: (sessionId: string) => { assert.equal(sessionId, scope.sessionId); invalidations++; session = { ...session, sessionActive: false }; },
        }, effects: () => effectCounter, replaceBeforeRead: () => { replaceBeforeRead = true; },
        failOutcome: () => { failOutcome = true; }, invalidations: () => invalidations,
        readCalls: () => readCalls, readProof: () => readProof, readResult: () => readResult });
      } finally { db.close(); await collector.close(); }
    } finally { await context.close(); }
  } finally { await browser.close(); }
}

async function before(collector: any) {
  const observed = await collector.observeTargets(7);
  assert.equal(observed.snapshotNumber, 7);
  const target = observed.candidates.find((candidate: any) => candidate.text === 'Synthetic visible text');
  assert.ok(target);
  assert.equal(target.visible, true);
  assert.equal(target.enabled, true);
  assert.equal(target.sourceFrame, true);
  assert.equal(target.secretField, false);
  assert.equal(target.prohibited, null);
  const bound: BoundSnapshot = { ...scope, snapshotNumber: observed.snapshotNumber, candidates: observed.candidates };
  return { observed: bound, target };
}

const command = (nodeNumber: number) => ({ method: 'readText', snapshotNumber: 7, nodeNumber, actionClass: 'read' });

test('читает допустимый узел и возвращает защищённый результат с новым снимком', { timeout: 60_000 }, async () => {
  await stand(async ({ collector, db, store, ports, effects }: any) => {
    const { createControlledRead } = require('../../core/use-cases/controlled-read.ts');
    const { observed, target } = await before(collector);
    const again = await collector.observeTargets(7);
    assert.equal(again.candidates.find((item: any) => item.nodeNumber === target.nodeNumber)?.identity, target.identity);
    const result = await createControlledRead(ports).read(command(target.nodeNumber), observed);
    assert.equal(result.ok, true);
    assert.equal(result.data.text, 'Synthetic visible text');
    assert.equal(result.data.snapshot.snapshot, 8);
    assert.deepEqual(result.data.image, { code: 'login-step' });
    assert.equal(effects(), 1);
    const verdict = db.prepare('SELECT id, decision, reason FROM action_verdicts').get();
    assert.equal(verdict.decision, 'allowed');
    assert.equal(verdict.reason, 'allowed');
    assert.deepEqual({ ...db.prepare('SELECT verdict_id, status FROM action_outcomes').get() }, { verdict_id: verdict.id, status: 'ok' });
    assert.deepEqual(store.latest({ ...scope, host: 'cabinet.invalid', path: '/overview' }), result.data.snapshot);
  });
});

test('отклоняет неподдерживаемый метод опцию старый снимок и изменившийся узел без эффекта', { timeout: 60_000 }, async (t: any) => {
  for (const kind of ['method', 'option', 'old snapshot', 'replacement']) await t.test(kind, async () => {
    await stand(async ({ page, collector, db, ports, effects }: any) => {
      const { createControlledRead } = require('../../core/use-cases/controlled-read.ts');
      const { observed, target } = await before(collector);
      let request: any = command(target.nodeNumber);
      let expected = 'unsupported';
      if (kind === 'method') request = { ...request, method: 'click' };
      if (kind === 'option') request = { ...request, options: { unknown: true } };
      if (kind === 'old snapshot') { request = { ...request, snapshotNumber: 6 }; expected = 'stale'; }
      if (kind === 'replacement') {
        await page.getByRole('button', { name: 'Replace' }).click();
        const current = await collector.observeTargets(7);
        const replacement = current.candidates.find((item: any) => item.nodeNumber === target.nodeNumber);
        assert.ok(replacement);
        assert.equal(replacement.text, target.text);
        assert.equal(replacement.descriptor, target.descriptor);
        assert.notEqual(replacement.identity, target.identity);
        expected = 'stale';
      }
      const html = await page.content();
      const result = await createControlledRead(ports).read(request, observed);
      assert.equal(result.ok, false);
      assert.equal(result.code, expected);
      assert.equal(result.snapshot.snapshot, 8);
      assert.equal(effects(), 0);
      assert.equal(await page.content(), html);
      const verdict = db.prepare('SELECT decision, reason FROM action_verdicts').get();
      assert.equal(verdict?.decision, 'blocked');
      assert.equal(verdict?.reason, expected);
    });
  });
});


test('отказывает в чтении снимка без привязки, другой сессии или устаревшего снимка', { timeout: 60_000 }, async (t: any) => {
  for (const kind of ['unbound', 'session', 'source', 'access', 'older']) await t.test(kind, async () => {
    await stand(async ({ collector, db, ports, effects }: any) => {
      const { createControlledRead } = require('../../core/use-cases/controlled-read.ts');
      const { observed, target } = await before(collector);
      let snapshot: any = observed;
      if (kind === 'unbound') snapshot = { snapshotNumber: 7, candidates: observed.candidates };
      if (kind === 'session') snapshot = { ...observed, sessionId: 'other-session' };
      if (kind === 'source') snapshot = { ...observed, sourceId: 'other-source' };
      if (kind === 'access') snapshot = { ...observed, accessId: 'other-access' };
      if (kind === 'older') snapshot = { ...observed, snapshotNumber: 6 };
      const result = await createControlledRead(ports).read({ ...command(target.nodeNumber), snapshotNumber: snapshot.snapshotNumber }, snapshot);
      assert.equal(result.ok, false);
      assert.equal(effects(), 0);
      assert.equal('data' in result, false);
      if (kind === 'older') assert.equal(result.code, 'stale');
      assert.equal(db.prepare("SELECT count(*) AS n FROM action_verdicts WHERE decision = 'allowed'").get().n, 0);
    });
  });
});

test('отказывает при подмене после последнего наблюдения до чтения', { timeout: 60_000 }, async () => {
  await stand(async ({ collector, db, ports, effects, replaceBeforeRead, readCalls, readProof, readResult }: any) => {
    const { createControlledRead } = require('../../core/use-cases/controlled-read.ts');
    const { observed, target } = await before(collector);
    replaceBeforeRead();
    const result = await createControlledRead(ports).read(command(target.nodeNumber), observed);
    assert.equal(result.ok, false);
    assert.equal(readCalls(), 1);
    assert.deepEqual(readProof(), { identity: target.identity, descriptor: target.descriptor });
    assert.deepEqual(readResult(), { ok: false, code: 'stale' });
    assert.equal(result.code, 'stale');
    assert.equal(effects(), 0);
    assert.equal(db.prepare('SELECT decision FROM action_verdicts').get()?.decision, 'allowed');
    assert.equal(db.prepare('SELECT status FROM action_outcomes').get()?.status, 'stale');
  });
});

test('видит protocol-unavailable и прекращение команд при недоступной записи', { timeout: 60_000 }, async (t: any) => {
  for (const kind of ['verdict', 'outcome']) await t.test(kind, async () => {
    await stand(async ({ collector, db, ports, effects, failOutcome, invalidations }: any) => {
      const { createControlledRead } = require('../../core/use-cases/controlled-read.ts');
      const { observed, target } = await before(collector);
      if (kind === 'verdict') db.exec('PRAGMA query_only = ON');
      else failOutcome();
      const reader = createControlledRead(ports);
      const result = await reader.read(command(target.nodeNumber), observed);
      assert.equal(db.prepare('PRAGMA query_only').get().query_only, 1);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'protocol-unavailable');
      assert.equal(invalidations(), 1);
      assert.equal(ports.getSession().sessionActive, false);
      const effectsAfterFailure = effects();
      if (kind === 'verdict') assert.equal(effectsAfterFailure, 0);
      else assert.equal(effectsAfterFailure, 1);
      const again = await reader.read(command(target.nodeNumber), observed);
      assert.equal(again.ok, false);
      assert.equal(again.code, 'session-unavailable');
      assert.equal(effects(), effectsAfterFailure);
      assert.equal(JSON.stringify([result, again]).includes('Synthetic visible text'), false);
      assert.equal('data' in result, false);
      assert.equal('data' in again, false);
    });
  });
});
