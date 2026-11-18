const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const origin = 'https://cabinet.invalid';
const session = {
  sessionId: 'synthetic-session', sessionActive: true, loginStep: false,
  manualInputSeen: true, hasKnownSecret: false, hasNonEmptyFields: false,
  completion: { sessionId: 'synthetic-session', source: 'trusted-adapter', confirmed: true },
};
const rect = { x: 20, y: 20, width: 30, height: 20 };
const facts = (snapshot: number) => ({
  snapshot, page: { url: `${origin}/overview`, title: 'Synthetic overview' },
  frames: [{ index: 0, host: 'cabinet.invalid', foreign: false, unavailable: false }],
  nodes: [{ n: 1, frame: 0, visible: true, role: 'text', text: 'Synthetic marker' }], secrets: [],
});
const frame = (snapshot: number, revision = 1, mask = rect) => ({
  facts: facts(snapshot), plan: { masks: [mask], labels: [] }, revision,
  animationIds: [] as string[], viewportStable: true,
});

async function stand(run: (fixture: any) => Promise<void>) {
  const { chromium } = require(process.env.FOLIOME_STAND_PLAYWRIGHT_CORE ?? 'playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, args: ['--disable-gpu'] });
  try {
    const context = await browser.newContext({ viewport: { width: 100, height: 80 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    try {
      await context.route('**/*', async (route: any) => {
        if (route.request().url() === `${origin}/overview` && route.request().method() === 'GET') {
          await route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>html,body{margin:0;background:rgb(30,180,70)} #marker{position:absolute;left:20px;top:20px;width:30px;height:20px;background:rgb(240,30,50)}</style><div id="marker"></div>' });
        } else await route.abort();
      });
      const page = await context.newPage();
      await page.goto(`${origin}/overview`);
      const cdp = await context.newCDPSession(page);
      let captures = 0;
      const capturePng = async () => {
        captures++;
        const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        return Buffer.from(result.data, 'base64');
      };
      const decoder = await context.newPage();
      await decoder.goto('about:blank');
      const pixels = async (bytes: Buffer) => decoder.evaluate(async (encoded: string) => {
        const image = new Image();
        image.src = `data:image/png;base64,${encoded}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(image, 0, 0);
        return { width: image.width, height: image.height, data: Array.from(ctx.getImageData(0, 0, image.width, image.height).data) };
      }, bytes.toString('base64'));
      await run({ capturePng, pixels, captures: () => captures });
    } finally { await context.close(); }
  } finally { await browser.close(); }
}

function clock() {
  let time = 0;
  const sleeps: number[] = [];
  return { now: () => time, sleep: async (ms: number) => { sleeps.push(ms); time += ms; }, sleeps };
}

function checkDeviation(entry: any, code: string, snapshotNumber: number) {
  assert.equal(entry.code, code);
  assert.equal(entry.snapshotNumber, snapshotNumber);
  assert.equal(entry.host, 'cabinet.invalid');
  assert.equal(entry.path, '/overview');
  assert.ok(Number.isSafeInteger(entry.retakes) && entry.retakes >= 0);
  assert.ok(Number.isSafeInteger(entry.elapsedMs) && entry.elapsedMs >= 0);
  assert.deepEqual(Object.keys(entry).sort(), ['code', 'elapsedMs', 'host', 'path', 'retakes', 'snapshotNumber'].sort());
  assert.doesNotMatch(JSON.stringify(entry), /Synthetic marker|data:image|Buffer/);
}

test('подавляет PNG после первого ввода и после допустимого завершения входа выдаёт текст протокол и PNG с одинаковым номером и проверяет закраску по пикселям', { timeout: 60_000 }, async () => {
  const { captureCabinetSnapshot } = await import('../../core/adapters/browser/capture-snapshot.ts');
  const { createActionProtocol } = await import('../../core/adapters/store/action-protocol.ts');
  const { filterTextSnapshot } = await import('../../core/domain/snapshot-filter.ts');
  await stand(async ({ capturePng, pixels, captures }: any) => {
    const timer = clock();
    const deviations: any[] = [];
    const ports = { collect: async () => frame(7), capturePng, now: timer.now, sleep: timer.sleep, recordDeviation: async (entry: any) => { deviations.push(entry); } };
    const suppressed = await captureCabinetSnapshot(ports, { ...session, loginStep: true, completion: null }, 1000);
    assert.equal(suppressed.ok, true);
    assert.deepEqual(suppressed.image, { code: 'login-step' });
    assert.equal(captures(), 0);
    assert.deepEqual(deviations, []);

    const result = await captureCabinetSnapshot(ports, session, 1000);
    assert.equal(result.ok, true);
    const filtered = filterTextSnapshot(facts(7));
    assert.equal(filtered.ok, true);
    assert.deepEqual(result.snapshot, filtered.snapshot);
    assert.equal(result.image.snapshotNumber, result.snapshot.snapshot);
    assert.equal(captures(), 1);
    const image = await pixels(result.image.bytes);
    assert.equal(image.width, 100); assert.equal(image.height, 80);
    const pixel = (x: number, y: number) => image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4);
    for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) assert.deepEqual(pixel(x, y), [0, 0, 0, 255]);
    assert.deepEqual(pixel(5, 5), [30, 180, 70, 255]);
    const db = new DatabaseSync(':memory:');
    try {
      const protocol = createActionProtocol(db, () => 1);
      const id = protocol.appendVerdict({ sessionId: session.sessionId, sourceId: 'synthetic-source', accessId: 'synthetic-access', snapshotNumber: result.snapshot.snapshot, nodeNumber: 1, method: 'readText', actionClass: 'read', decision: 'allowed', reason: 'allowed' });
      protocol.appendOutcome({ verdictId: id, status: 'ok' });
      const row = db.prepare('SELECT v.snapshot_number, v.decision, v.reason, o.status FROM action_verdicts v JOIN action_outcomes o ON o.verdict_id = v.id WHERE v.id = ? AND v.snapshot_number = ?').get(id, result.image.snapshotNumber);
      assert.deepEqual({ ...row }, { snapshot_number: 7, decision: 'allowed', reason: 'allowed', status: 'ok' });
    } finally { db.close(); }
  });
});

test('переснимает нестабильный кадр и протоколирует отклонения без исходного изображения', { timeout: 60_000 }, async () => {
  const { captureCabinetSnapshot } = await import('../../core/adapters/browser/capture-snapshot.ts');
  const { filterTextSnapshot } = await import('../../core/domain/snapshot-filter.ts');
  await stand(async ({ capturePng, captures }: any) => {
    const timer = clock();
    const deviations: any[] = [];
    const changed = frame(8, 2, { ...rect, x: 21 });
    let calls = 0;
    const ports = {
      collect: async () => ++calls === 1 ? { ...frame(8), animationIds: ['synthetic-animation'] } : changed,
      capturePng, now: timer.now, sleep: timer.sleep,
      recordDeviation: async (entry: any) => { deviations.push(entry); },
    };
    const result = await captureCabinetSnapshot(ports, session, 1000);
    assert.equal(result.ok, true);
    assert.deepEqual(result.snapshot, filterTextSnapshot(changed.facts).snapshot);
    assert.equal(result.image.snapshotNumber, 8);
    assert.ok(Buffer.isBuffer(result.image.bytes));
    assert.equal(captures(), 2);
    assert.deepEqual(timer.sleeps, [300]);
    assert.equal(deviations.length, 1);
    checkDeviation(deviations[0], 'retake', 8);
    assert.equal(deviations[0].retakes, 1);

    const timeoutClock = clock();
    const timeoutDeviations: any[] = [];
    let revision = 0;
    const before = captures();
    const unstable = await captureCabinetSnapshot({ ...ports, collect: async () => frame(9, ++revision, { ...rect, x: 20 + revision % 2 }), now: timeoutClock.now, sleep: timeoutClock.sleep, recordDeviation: async (entry: any) => { timeoutDeviations.push(entry); } }, session, 600);
    assert.equal(unstable.ok, true);
    assert.deepEqual(unstable.snapshot, filterTextSnapshot(facts(9)).snapshot);
    assert.deepEqual(unstable.image, { code: 'unstable' });
    assert.ok(captures() - before >= 2);
    assert.ok(timeoutClock.sleeps.length >= 1 && timeoutClock.sleeps.every((ms: number) => ms === 300));
    assert.ok(timeoutDeviations.some((entry) => entry.code === 'retake'));
    assert.equal(timeoutDeviations.at(-1).code, 'unstable');
    for (const entry of timeoutDeviations) checkDeviation(entry, entry.code, 9);

    const denied = await captureCabinetSnapshot({ ...ports, collect: async () => frame(10, ++revision), recordDeviation: async () => { throw new Error('synthetic protocol failure'); } }, session, 1000);
    assert.deepEqual(denied, { ok: false, code: 'protocol-unavailable' });
  });
});
