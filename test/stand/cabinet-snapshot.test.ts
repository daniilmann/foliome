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
  animationIds: [] as string[], maskAnimationActive: false, viewportStable: true,
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
  assert.ok(Array.isArray(entry.flags));
  assert.deepEqual(entry.flags, ['flow', 'rectangles', 'animations', 'observer', 'visualViewport'].filter(flag => entry.flags.includes(flag)));
  assert.deepEqual(Object.keys(entry).sort(), ['code', 'elapsedMs', 'flags', 'host', 'path', 'retakes', 'snapshotNumber'].sort());
  assert.doesNotMatch(JSON.stringify(entry), /Synthetic marker|data:image|Buffer/);
}

function syntheticPng() {
  const { crc32, deflateSync } = require('node:zlib');
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// The properties let the previous object-based implementation reach the same phases.
// The agreed interface consumes the function and reads the current session each time.
function sessionGetter(get: () => typeof session) {
  return Object.assign(get, session);
}

function syntheticPorts() {
  const timer = clock();
  const deviations: any[] = [];
  const observation = () => frame(11, 1, { x: 0, y: 0, width: 1, height: 1 });
  return {
    timer, deviations, observation,
    ports: { collect: async () => observation(), capturePng: async () => syntheticPng(),
      now: timer.now, sleep: timer.sleep, recordDeviation: async (entry: any) => { deviations.push(entry); } },
  };
}

test('сохраняет историю ручного ввода между документами и скрывает эхо без подтверждения входа', { timeout: 60_000 }, async (t: any) => {
  const { prepareDomCollector } = await import('../../core/adapters/browser/collect-dom.ts') as any;
  const { filterTextSnapshot } = await import('../../core/domain/snapshot-filter.ts');
  const { captureCabinetSnapshot } = await import('../../core/adapters/browser/capture-snapshot.ts') as any;
  const { randomBytes } = require('node:crypto');
  const { chromium } = require(process.env.FOLIOME_STAND_PLAYWRIGHT_CORE ?? 'playwright-core');
  for (const kind of ['login', 'password', 'code']) {
    for (const check of ['observations', 'filtered echo', 'PNG gate', 'closed collector']) await t.test(`${kind}: ${check}`, async () => {
      const value = `synthetic${kind}${randomBytes(16).toString('hex')}`;
      const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, args: ['--disable-gpu'] });
      try {
        const context = await browser.newContext({ serviceWorkers: 'block' });
        try {
          await context.route('**/*', async (route: any) => {
            const request = route.request();
            if (request.method() !== 'GET') return route.abort();
            if (request.url() === `${origin}/login`) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Synthetic login</title><label for="entry">Synthetic ${kind}</label><input id="entry" type="${kind === 'password' ? 'password' : 'text'}" autocomplete="${kind === 'login' ? 'username' : kind === 'password' ? 'current-password' : 'one-time-code'}"><button type="button">Virtual key</button><a href="/next">Continue</a>` });
            if (request.url() === `${origin}/next`) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Synthetic next</title><p>Echo: ${value}</p>` });
            return route.abort();
          });
          const page = await context.newPage();
          const cdp = await context.newCDPSession(page);
          const collector = await prepareDomCollector(cdp, { sourceHost: 'cabinet.invalid', approvedHosts: [] });
          let closed = false;
          try {
            await page.goto(`${origin}/login`, { waitUntil: 'load' });
            if (check === 'observations') {
              assert.deepEqual(await collector.loginObservations(), { manualInputSeen: false, hasKnownSecret: false });
              await page.getByRole('button', { name: 'Virtual key' }).click();
              assert.deepEqual(await collector.loginObservations(), { manualInputSeen: true, hasKnownSecret: false });
            }
            await page.locator('#entry').click();
            await page.locator('#entry').pressSequentially(value);
            await page.getByRole('link', { name: 'Continue' }).click();
            assert.equal(page.url(), `${origin}/next`);
            assert.equal(await page.locator('#entry').count(), 0);
            if (check === 'observations') {
              const expected = { manualInputSeen: true, hasKnownSecret: true };
              assert.deepEqual(await collector.loginObservations(), expected);
              await page.reload({ waitUntil: 'load' });
              assert.deepEqual(await collector.loginObservations(), expected);
              await page.goto(`${origin}/login`, { waitUntil: 'load' });
              assert.deepEqual(await collector.loginObservations(), expected);
            } else if (check === 'filtered echo') {
              const raw = await collector.collectText(42);
              assert.ok(raw.secrets.some((secret: any) => secret.value === value));
              const filtered = filterTextSnapshot(raw);
              assert.equal(filtered.ok, true);
              if (!filtered.ok) return;
              assert.equal(filtered.snapshot.snapshot, 42);
              const echo = filtered.snapshot.elements.find((element: any) => element.text.startsWith('Echo:'));
              assert.equal(echo?.text, 'Echo: [секрет]');
              assert.equal(JSON.stringify(filtered.snapshot).includes(value), false);
            } else if (check === 'PNG gate') {
              const timer = clock();
              let captures = 0;
              const result = await captureCabinetSnapshot({
                collect: () => collector.collectFrame(43),
                capturePng: async () => { captures++; return Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'); },
                now: timer.now, sleep: timer.sleep, recordDeviation: async () => {},
              }, () => ({ sessionId: 'synthetic-session', sessionActive: true, loginStep: true, manualInputSeen: true, hasKnownSecret: true, hasNonEmptyFields: false, completion: null }), 5000);
              assert.equal(result.ok, true);
              assert.deepEqual(result.image, { code: 'login-step' });
              assert.equal(captures, 0);
            } else {
              assert.equal(typeof collector.loginObservations, 'function');
              assert.deepEqual(await collector.loginObservations(), { manualInputSeen: true, hasKnownSecret: true });
              await collector.close();
              closed = true;
              let afterClose: unknown;
              try { afterClose = await collector.loginObservations(); } catch { afterClose = undefined; }
              assert.notDeepEqual(afterClose, { manualInputSeen: true, hasKnownSecret: true });
              let textAfterClose: unknown;
              try { textAfterClose = await collector.collectText(44); } catch { textAfterClose = undefined; }
              assert.equal(filterTextSnapshot(textAfterClose).ok, false);
            }
          } finally { if (!closed) await collector.close(); }
        } finally { await context.close(); }
      } finally { await browser.close(); }
    });
  }
});

test('собирает видимый DOM в изолированном мире указанного источника', { timeout: 60_000 }, async (t: any) => {
  const { prepareDomCollector } = await import('../../core/adapters/browser/collect-dom.ts') as any;
  const { filterTextSnapshot } = await import('../../core/domain/snapshot-filter.ts');
  const { randomBytes } = require('node:crypto');
  const password = randomBytes(18).toString('hex');
  const textValue = randomBytes(18).toString('hex');
  const tokenId = 'account-abc123def456ghi789';
  const { chromium } = require(process.env.FOLIOME_STAND_PLAYWRIGHT_CORE ?? 'playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, args: ['--disable-gpu'] });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      await context.route('**/*', async (route: any) => {
        const request = route.request();
        if (request.method() === 'GET' && request.url() === `${origin}/overview`) {
          await route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Synthetic title</title>
            <p>Ordinary visible text</p>
            <p id="${tokenId}">Token marker</p><p>Known secret ${password}</p>
            <label for="password">Password label</label><input id="password" type="password" value="${password}">
            <label for="text">Text label</label><input id="text" type="text" value="${textValue}">
            <div style="display:none">Display hidden marker</div><div aria-hidden="true">Aria hidden marker</div>
            <div style="display:contents"><span>Contents visible marker</span></div>
            <div style="display:none"><span>Hidden ancestor marker</span></div>
            <div contenteditable="true" role="textbox" aria-label="Editable field">Editable private marker</div>
            <button disabled>Disabled control</button>
            <div><span>4111 1111</span><span> 1111 1111</span></div>
            <iframe src="https://foreign.invalid/frame"></iframe>
            <script>
              window.collectText = () => ({ snapshot: 999, nodes: [] });
              window.prepareDomCollector = window.collectText;
              window.facts = { page: { title: 'Forged title' } };
              Document.prototype.querySelectorAll = () => [];
              Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0 });
            </script>` });
        } else if (request.method() === 'GET' && request.url() === 'https://foreign.invalid/frame') {
          await route.fulfill({ contentType: 'text/html', body: '<!doctype html><p>Foreign frame marker</p>' });
        } else await route.abort();
      });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      const collector = await prepareDomCollector(cdp, { sourceHost: 'cabinet.invalid', approvedHosts: [] });
      try {
        await page.goto(`${origin}/overview`, { waitUntil: 'load' });
        const result = filterTextSnapshot(await collector.collectText(27));
        assert.equal(result.ok, true);
        if (!result.ok) return;
        const snapshot = result.snapshot;
        assert.equal(snapshot.snapshot, 27);
        assert.equal(snapshot.page.title, 'Synthetic title');
        const output = JSON.stringify(snapshot);
        for (const value of ['Ordinary visible text', 'Password label', 'Text label', 'Disabled control', '1111']) assert.ok(output.includes(value));
        for (const value of [password, textValue, 'Display hidden marker', 'Aria hidden marker', 'Foreign frame marker', '4111', 'Forged title']) assert.equal(output.includes(value), false);
        assert.ok(snapshot.frames.some((item: any) => item.host === 'foreign.invalid' && item.foreign));
        const fields = snapshot.elements.filter((item: any) => item.field !== undefined);
        assert.ok(fields.length >= 2);
        assert.ok(fields.every((item: any) => item.text === '' && ['filled', 'sealed'].includes(item.field)));
        assert.ok(snapshot.elements.some((item: any) => item.text.includes('Disabled control') && item.state?.includes('disabled')));
        const numbers = snapshot.elements.map((item: any) => item.n);
        assert.ok(numbers.length > 0 && numbers.every((n: number) => Number.isSafeInteger(n) && n > 0));
        assert.equal(new Set(numbers).size, numbers.length);
        await t.test('выдаёт и хранит фильтрованный текст и проверяет условия селектора по маскам', async () => {
          const { createTextSnapshotStore } = await import('../../core/adapters/store/text-snapshot-store.ts');
          const db = new DatabaseSync(':memory:');
          try {
            const store = createTextSnapshotStore(db, () => 1234);
            const scope = { sourceId: 'synthetic-source', accessId: 'synthetic-access' };
            store.append({ sessionId: 'synthetic-session', ...scope, result });
            const rows = db.prepare('SELECT * FROM text_snapshots').all();
            assert.equal(rows.length, 1);
            assert.equal(rows[0].at_ms, 1234);
            assert.deepEqual(JSON.parse(rows[0].snapshot_json as string), snapshot);
            const stored = store.latest({ ...scope, host: 'cabinet.invalid', path: '/overview' });
            assert.deepEqual(stored, snapshot);
            const serialized = JSON.stringify(rows);
            for (const value of [password, textValue, tokenId, 'Display hidden marker', 'Aria hidden marker']) {
              assert.equal(serialized.includes(value), false);
            }
            assert.ok(serialized.includes('[секрет]'));

            const { selectFilteredNodes } = await import('../../core/domain/filtered-selector.ts');
            const ordinary = snapshot.elements.find((item: any) => item.text === 'Ordinary visible text');
            const token = snapshot.elements.find((item: any) => item.text === 'Token marker');
            assert.ok(ordinary && token);
            assert.equal(token.attrs?.id, 'account-{id}');
            const select = (conditions: any[]) => selectFilteredNodes(stored, conditions);
            assert.deepEqual(select([{ kind: 'text', operator: 'contains', value: 'Ordinary visible text' }]), [ordinary.n]);
            assert.deepEqual(select([{ kind: 'text', operator: 'equals', value: 'Ordinary visible text' }]), [ordinary.n]);
            for (const value of ['Display hidden marker', 'Aria hidden marker', password]) {
              assert.deepEqual(select([{ kind: 'text', operator: 'contains', value }]), []);
            }
            for (const [operator, value] of [['equals', 'account-{id}'], ['contains', '{id}'], ['prefix', 'account-'], ['suffix', '{id}'], ['token', 'account-{id}'], ['language-prefix', 'account']]) {
              assert.deepEqual(select([{ kind: 'attribute', name: 'id', operator, value }]), [token.n]);
            }
            assert.deepEqual(select([{ kind: 'attribute', name: 'id', operator: 'equals', value: tokenId }]), []);
            assert.deepEqual(select([{ kind: 'attribute', name: 'unknown', operator: 'equals', value: 'account-{id}' }]), []);
            assert.deepEqual(select([{ kind: 'text', operator: 'equals', value: 'Token marker' }, { kind: 'attribute', name: 'id', operator: 'equals', value: 'account-{id}' }]), [token.n]);
            assert.deepEqual(select([{ kind: 'text', operator: 'equals', value: 'Ordinary visible text' }, { kind: 'attribute', name: 'id', operator: 'equals', value: 'account-{id}' }]), []);
          } finally { db.close(); }
        });
        await t.test('показывает видимого потомка display contents', () => {
          assert.ok(output.includes('Contents visible marker'));
        });
        await t.test('скрывает потомка скрытого предка', () => {
          assert.equal(output.includes('Hidden ancestor marker'), false);
        });
        await t.test('contenteditable оставляет состояние поля без содержимого', () => {
          assert.equal(output.includes('Editable private marker'), false);
          assert.equal(output.includes('Editable field'), false);
          const editable = snapshot.elements.find((item: any) => item.role === 'textbox');
          assert.ok(editable);
          assert.ok(['filled', 'sealed'].includes(editable.field));
          assert.equal(editable.text, '');
        });
        await t.test('чужой основной фрейм отклоняется', async () => {
          await page.goto('https://foreign.invalid/frame', { waitUntil: 'load' });
          let foreign: unknown;
          try { foreign = await collector.collectText(28); } catch { foreign = undefined; }
          assert.equal(filterTextSnapshot(foreign).ok, false);
        });
      } finally { await collector.close(); }
      let afterClose: unknown;
      try { afterClose = await collector.collectText(28); } catch { afterClose = undefined; }
      assert.equal(filterTextSnapshot(afterClose).ok, false);
    } finally { await context.close(); }
  } finally { await browser.close(); }
});

test('строит план закраски по защищённым наблюдениям браузера', { timeout: 60_000 }, async (t: any) => {
  const { prepareDomCollector } = await import('../../core/adapters/browser/collect-dom.ts') as any;
  const { captureCabinetSnapshot } = await import('../../core/adapters/browser/capture-snapshot.ts') as any;
  const { randomBytes } = require('node:crypto');
  const { chromium } = require(process.env.FOLIOME_STAND_PLAYWRIGHT_CORE ?? 'playwright-core');
  const password = randomBytes(12).toString('hex');
  for (const uncertain of [false, true]) await t.test(uncertain ? 'не выдаёт PNG при неопределённом содержимом у края' : 'закрашивает защищённые области на настоящем PNG', async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, args: ['--disable-gpu'] });
    try {
      const context = await browser.newContext({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
      try {
        await context.route('**/*', async (route: any) => {
          const request = route.request();
          if (request.method() === 'GET' && request.url() === `${origin}/overview`) {
            await route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Synthetic overview</title>
              <style>
                html,body { margin:0; background:rgb(30,180,70); }
                .mark { position:absolute; color:rgb(240,30,50); font:20px monospace; white-space:pre; }
                #field { position:absolute; left:20px; top:20px; width:210px; height:30px; box-sizing:border-box; background:rgb(240,30,50); }
                #hidden { left:20px; top:70px; } #card { left:20px; top:110px; }
                #echo { left:20px; top:150px; }
                iframe { position:absolute; left:20px; top:200px; width:160px; height:70px; border:0; }
                #ordinary { position:absolute; left:350px; top:40px; color:white; }
                ${uncertain ? '#edge { position:absolute; right:0; top:300px; width:0; } #edge::after { content:open-quote; position:absolute; right:0; color:red; font:30px serif; }' : ''}
              </style>
              <input id="field" type="password" aria-label="Synthetic password">
              <div id="hidden" class="mark" aria-hidden="true">5555 5555 5555 4444</div>
              <div id="card" class="mark"><span>4111 </span><span>1111 </span><span>1111 </span><span>1111</span></div>
              <div id="echo" class="mark">${password}</div>
              <iframe src="https://foreign.invalid/frame"></iframe><div id="ordinary">Ordinary visible text</div>
              ${uncertain ? '<div id="edge"></div>' : ''}` });
          } else if (request.method() === 'GET' && request.url() === 'https://foreign.invalid/frame') {
            await route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>html,body{margin:0;background:rgb(240,30,50)}</style>Foreign synthetic content' });
          } else await route.abort();
        });
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        const collector = await prepareDomCollector(cdp, { sourceHost: 'cabinet.invalid', approvedHosts: [] });
        try {
          await page.goto(`${origin}/overview`, { waitUntil: 'load' });
          await page.locator('#field').fill(password);
          const observed = await collector.collectFrame(31);
          assert.equal(observed.facts.snapshot, 31);
          if (uncertain) assert.equal(observed.plan, null);
          else assert.ok(observed.plan);
          const timer = clock();
          const ports = {
            collect: () => collector.collectFrame(31),
            capturePng: async () => Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'),
            now: timer.now, sleep: timer.sleep, recordDeviation: async () => {},
          };
          const result = await captureCabinetSnapshot(ports, () => session, 5000);
          assert.equal(result.ok, true);
          assert.equal(result.snapshot.snapshot, 31);
          const output = JSON.stringify(result.snapshot);
          assert.ok(output.includes('Ordinary visible text'));
          assert.ok(!output.includes(password) && !output.includes('4111') && !output.includes('5555') && !output.includes('Foreign synthetic content'));
          assert.ok(output.includes('1111'));
          if (uncertain) {
            assert.ok(['error', 'unstable'].includes(result.image.code));
            assert.equal(result.image.bytes, undefined);
            return;
          }
          assert.equal(result.image.snapshotNumber, 31);
          assert.ok(Buffer.isBuffer(result.image.bytes));
          const original = await ports.capturePng();
          const decoder = await context.newPage();
          await decoder.goto('about:blank');
          const pixels = async (bytes: Buffer) => decoder.evaluate(async (encoded: string) => {
            const image = new Image(); image.src = `data:image/png;base64,${encoded}`; await image.decode();
            const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
            const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
            return Array.from(ctx.getImageData(0, 0, image.width, image.height).data);
          }, bytes.toString('base64')) as Promise<number[]>;
          const before = await pixels(original), after = await pixels(result.image.bytes);
          const pixel = (data: number[], x: number, y: number) => data.slice((y * 640 + x) * 4, (y * 640 + x) * 4 + 4);
          // Check actual rendered red glyphs, not a rectangle supplied to the collector.
          for (const [name, x0, x1, y0, y1] of [
            ['aria-hidden card prefix', 20, 200, 78, 95],
            ['split card prefix', 20, 200, 118, 135],
            ['password echo', 20, 308, 158, 175],
          ] as const) {
            let rendered = 0;
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
              const p = pixel(before, x, y);
              if (p[0] > 150 && p[0] > p[1] * 2 && p[0] > p[2] * 2) {
                rendered++;
                assert.deepEqual(pixel(after, x, y), [0, 0, 0, 255], `${name} at ${x},${y}`);
              }
            }
            assert.ok(rendered > 0, `${name} must actually be drawn`);
          }
          for (const [x, y] of [[25, 45], [100, 240]]) {
            assert.deepEqual(pixel(before, x, y), [240, 30, 50, 255]);
            assert.deepEqual(pixel(after, x, y), [0, 0, 0, 255]);
          }
          assert.deepEqual(pixel(after, 600, 20), [30, 180, 70, 255]);
        } finally { await collector.close(); }
      } finally { await context.close(); }
    } finally { await browser.close(); }
  });
});

test('отзывает результат при изменении сессии во время capture или второго collect', async (t: any) => {
  const { captureCabinetSnapshot } = await import('../../core/adapters/browser/capture-snapshot.ts') as any;
  for (const phase of ['capture', 'second collect']) for (const change of ['id', 'inactive']) {
    await t.test(`${phase}: ${change}`, async () => {
      const { ports, observation } = syntheticPorts();
      let current = session;
      const revoke = () => { current = change === 'id'
        ? { ...session, sessionId: 'other-synthetic-session', completion: { ...session.completion, sessionId: 'other-synthetic-session' } }
        : { ...session, sessionActive: false }; };
      let collects = 0;
      ports.collect = async () => { if (++collects === 2 && phase === 'second collect') revoke(); return observation(); };
      ports.capturePng = async () => { if (phase === 'capture') revoke(); return syntheticPng(); };
      const result = await captureCabinetSnapshot(ports, sessionGetter(() => current), 1000);
      assert.deepEqual(result, { ok: false, code: 'session-revoked' });
    });
  }
});

test('анимация маски в одной фазе требует пересъёмки до стабильного кадра', async (t: any) => {
  const { captureCabinetSnapshot } = await import('../../core/adapters/browser/capture-snapshot.ts') as any;
  for (const phase of [1, 2]) await t.test(`фаза ${phase}`, async () => {
    const { ports, timer, deviations, observation } = syntheticPorts();
    let collects = 0; let captures = 0;
    ports.collect = async () => ({ ...observation(), animationIds: ['same-animation'], maskAnimationActive: ++collects === phase });
    ports.capturePng = async () => { captures++; return syntheticPng(); };
    const result = await captureCabinetSnapshot(ports, sessionGetter(() => session), 1000);
    assert.equal(result.ok, true);
    assert.ok(Buffer.isBuffer(result.image.bytes));
    assert.equal(captures, 2);
    assert.deepEqual(timer.sleeps, [300]);
    assert.equal(deviations.length, 1);
    checkDeviation(deviations[0], 'retake', 11);
  });
});

test('продолжающаяся анимация маски после срока даёт unstable без PNG', async (t: any) => {
  const { captureCabinetSnapshot } = await import('../../core/adapters/browser/capture-snapshot.ts') as any;
  for (const phase of [1, 2]) await t.test(`фаза ${phase}`, async () => {
    const { ports, timer, deviations, observation } = syntheticPorts();
    let collects = 0; let captures = 0;
    ports.collect = async () => ({ ...observation(), animationIds: ['same-animation'], maskAnimationActive: (++collects % 2 === (phase === 1 ? 1 : 0)) });
    ports.capturePng = async () => { captures++; return syntheticPng(); };
    const result = await captureCabinetSnapshot(ports, sessionGetter(() => session), 600);
    assert.equal(result.ok, true);
    assert.deepEqual(result.image, { code: 'unstable' });
    assert.ok(captures >= 2);
    assert.ok(timer.sleeps.length >= 1 && timer.sleeps.every((ms: number) => ms === 300));
    assert.equal(deviations.at(-1).code, 'unstable');
    for (const entry of deviations) checkDeviation(entry, entry.code, 11);
  });
});

test('ошибка первого вызова часов возвращает internal без исключения', async () => {
  const { captureCabinetSnapshot } = await import('../../core/adapters/browser/capture-snapshot.ts') as any;
  const { ports } = syntheticPorts();
  ports.now = () => { throw new Error('synthetic clock failure'); };
  assert.deepEqual(await captureCabinetSnapshot(ports, sessionGetter(() => session), 1000), { ok: false, code: 'internal' });
});

test('подавляет PNG после первого ввода и после допустимого завершения входа выдаёт текст протокол и PNG с одинаковым номером и проверяет закраску по пикселям', { timeout: 60_000 }, async () => {
  const { captureCabinetSnapshot } = await import('../../core/adapters/browser/capture-snapshot.ts') as any;
  const { createActionProtocol } = await import('../../core/adapters/store/action-protocol.ts');
  const { filterTextSnapshot } = await import('../../core/domain/snapshot-filter.ts');
  await stand(async ({ capturePng, pixels, captures }: any) => {
    const timer = clock();
    const deviations: any[] = [];
    const ports = { collect: async () => frame(7), capturePng, now: timer.now, sleep: timer.sleep, recordDeviation: async (entry: any) => { deviations.push(entry); } };
    const suppressed = await captureCabinetSnapshot(ports, () => ({ ...session, loginStep: true, completion: null }), 1000);
    assert.equal(suppressed.ok, true);
    assert.deepEqual(suppressed.image, { code: 'login-step' });
    assert.equal(captures(), 0);
    assert.deepEqual(deviations, []);

    const result = await captureCabinetSnapshot(ports, () => session, 1000);
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

test('переснимает нестабильный кадр и протоколирует отклонения без исходного изображения', { timeout: 60_000 }, async (t: any) => {
  const { captureCabinetSnapshot } = await import('../../core/adapters/browser/capture-snapshot.ts') as any;
  const { createActionProtocol } = await import('../../core/adapters/store/action-protocol.ts');
  const { filterTextSnapshot } = await import('../../core/domain/snapshot-filter.ts');
  const flagOrder = ['flow', 'rectangles', 'animations', 'observer', 'visualViewport'];
  const expectedFlags = ['rectangles', 'observer'];
  const changed = frame(8, 2, { ...rect, x: 21 });

  await t.test('передаёт отличившиеся признаки массивом', async () => {
    const timer = clock();
    const entries: any[] = [];
    let calls = 0;
    const result = await captureCabinetSnapshot({
      collect: async () => ++calls === 1 ? frame(8) : changed,
      capturePng: async () => syntheticPng(), now: timer.now, sleep: timer.sleep,
      recordDeviation: async (value: any) => { entries.push(value); },
    }, () => session, 1000);
    assert.equal(result.ok, true);
    assert.deepEqual(entries.map(entry => [entry.code, entry.flags]), [
      ['retake', expectedFlags],
      ['error', []],
    ]);
  });

  await t.test('записывает отклонения и отклоняет недоступный протокол', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const protocol = createActionProtocol(db, () => 1) as any;
      assert.equal(typeof protocol.appendSnapshotDeviation, 'function');
      const recordDeviation = async (entry: any) => {
        assert.ok(Array.isArray(entry.flags));
        protocol.appendSnapshotDeviation({ sessionId: session.sessionId, sourceId: 'synthetic-source', accessId: 'synthetic-access', ...entry });
      };
      const rows = () => db.prepare('SELECT code, snapshot_number, host, path, flags, retakes, elapsed_ms FROM action_snapshot_deviations ORDER BY id').all().map((row: any) => {
        const flags = row.flags.startsWith('[') ? JSON.parse(row.flags) : row.flags.split(',').filter(Boolean);
        assert.ok(Array.isArray(flags));
        assert.deepEqual(flags, flagOrder.filter(flag => flags.includes(flag)));
        return { ...row, flags };
      });
      await stand(async ({ capturePng, captures }: any) => {
        const timer = clock();
        let calls = 0;
        const ports = {
          collect: async () => ++calls === 1 ? frame(8) : changed,
          capturePng, now: timer.now, sleep: timer.sleep, recordDeviation,
        };
        const result = await captureCabinetSnapshot(ports, () => session, 1000);
        assert.equal(result.ok, true);
        assert.deepEqual(result.snapshot, filterTextSnapshot(changed.facts).snapshot);
        assert.equal(result.image.snapshotNumber, 8);
        assert.ok(Buffer.isBuffer(result.image.bytes));
        assert.equal(captures(), 2);
        assert.deepEqual(timer.sleeps, [300]);
        assert.deepEqual(rows(), [{ code: 'retake', snapshot_number: 8, host: 'cabinet.invalid', path: '/overview', flags: expectedFlags, retakes: 1, elapsed_ms: 0 }]);

        const timeoutClock = clock();
        let revision = 0;
        const before = captures();
        const unstable = await captureCabinetSnapshot({ ...ports, collect: async () => frame(9, ++revision, { ...rect, x: 20 + revision % 2 }), now: timeoutClock.now, sleep: timeoutClock.sleep }, () => session, 600);
        assert.equal(unstable.ok, true);
        assert.deepEqual(unstable.snapshot, filterTextSnapshot(facts(9)).snapshot);
        assert.deepEqual(unstable.image, { code: 'unstable' });
        assert.ok(captures() - before >= 2);
        assert.deepEqual(timeoutClock.sleeps, [300]);
        const stored = rows();
        assert.deepEqual(stored.slice(1), [
          { code: 'retake', snapshot_number: 9, host: 'cabinet.invalid', path: '/overview', flags: expectedFlags, retakes: 1, elapsed_ms: 0 },
          { code: 'retake', snapshot_number: 9, host: 'cabinet.invalid', path: '/overview', flags: expectedFlags, retakes: 2, elapsed_ms: 300 },
          { code: 'unstable', snapshot_number: 9, host: 'cabinet.invalid', path: '/overview', flags: expectedFlags, retakes: 2, elapsed_ms: 300 },
        ]);
        const rawRows = db.prepare('SELECT * FROM action_snapshot_deviations ORDER BY id').all();
        assert.doesNotMatch(JSON.stringify(rawRows), /Synthetic marker|data:image|Buffer/);
        assert.ok(rawRows.every((row: any) => !Object.keys(row).some(key => /text|png|image/i.test(key))));

        db.exec('PRAGMA query_only = ON');
        assert.equal(db.prepare('PRAGMA query_only').get().query_only, 1);
        const denied = await captureCabinetSnapshot({ ...ports, collect: async () => frame(10, ++revision) }, () => session, 1000);
        assert.deepEqual(denied, { ok: false, code: 'protocol-unavailable' });
        assert.deepEqual(rows(), stored);
      });
    } finally { db.close(); }
  });
});

test('защищает подписи input и сохраняет обычные элементы на настоящем PNG', { timeout: 60_000 }, async (t: any) => {
  const { randomBytes } = require('node:crypto');
  const secret = `synthetic${randomBytes(12).toString('hex')}`;
  for (const kind of ['ordinary', 'secret']) await t.test(kind, async () => {
    await measuredPage(`
      <input id="password" type="password" style="left:10px;top:10px;width:180px;height:25px">
      <label style="left:10px;top:55px"><input type="checkbox" checked> Checkbox marker</label>
      <label style="left:10px;top:85px"><input type="radio" checked> Radio marker</label>
      <input id="button" type="button" value="Button marker" style="left:10px;top:120px;width:140px;height:30px">
      <input id="submit" type="submit" value="${kind === 'secret' ? secret : 'Submit marker'}" style="left:10px;top:160px;width:220px;height:30px">
      <input id="reset" type="reset" value="Reset marker" style="left:10px;top:200px;width:140px;height:30px">
      <div id="ordinary" style="left:300px;top:30px;color:white">Readable marker</div>`, async ({ page, capture, decode }: any) => {
      await page.locator('#password').fill(secret);
      const target = await page.locator('#submit').boundingBox();
      assert.ok(target && Number.isInteger(target.x) && Number.isInteger(target.y));
      const before = await decode(await capture.raw());
      const result = await capture.result();
      assert.equal(result.ok, true);
      const output = JSON.stringify(result.snapshot);
      assert.ok(output.includes('Readable marker'));
      assert.equal(output.includes(secret), false);
      if (kind === 'ordinary') for (const marker of ['Checkbox marker', 'Radio marker', 'Button marker', 'Submit marker', 'Reset marker']) assert.ok(output.includes(marker), marker);
      assert.ok(Buffer.isBuffer(result.image.bytes), `image status: ${result.image.code}`);
      const after = await decode(result.image.bytes);
      if (kind === 'secret') {
        assertRectBlack(after, target);
      } else {
        for (const selector of ['label', '#button', '#submit', '#reset']) {
          const elements = page.locator(selector);
          for (let i = 0; i < await elements.count(); i++) {
            const box = await elements.nth(i).boundingBox();
            assert.ok(box);
            assertVisibleUnchanged(before, after, box);
          }
        }
      }
    });
  });
});

test('CSS анимация блокирует только маску и её предка', { timeout: 60_000 }, async (t: any) => {
  for (const position of ['none', 'distant', 'mask', 'ancestor']) await t.test(position, async () => {
    const animation = 'animation: pulse 2s linear infinite alternate;';
    await measuredPage(`
      <style>@keyframes pulse { from { opacity:1 } to { opacity:.6 } }</style>
      <div style="left:10px;top:10px;${position === 'ancestor' ? animation : ''}">
        <input id="mask" type="password" value="synthetic-value" style="position:relative;width:180px;height:30px;${position === 'mask' ? animation : ''}">
      </div>
      <div id="ordinary" style="left:300px;top:30px;color:white;${position === 'distant' ? animation : ''}">Readable marker</div>`, async ({ page, capture, decode }: any) => {
      const box = await page.locator('#mask').boundingBox();
      assert.ok(box);
      const result = await capture.result();
      assert.equal(result.ok, true);
      assert.ok(JSON.stringify(result.snapshot).includes('Readable marker'));
      if (position === 'distant' || position === 'none') {
        assert.ok(Buffer.isBuffer(result.image.bytes), `image status: ${result.image.code}`);
        assertRectBlack(await decode(result.image.bytes), box);
      } else {
        assert.deepEqual(result.image, { code: 'unstable' });
      }
    });
  });
});

test('закрытый shadow host и разрешённый фрейм не раскрывают неизвестное содержимое', { timeout: 60_000 }, async (t: any) => {
  for (const kind of ['closed shadow', 'source frame']) await t.test(kind, async () => {
    const content = kind === 'closed shadow'
      ? '<div id="target" style="left:20px;top:20px;width:120px;height:60px;background:rgb(240,30,50)"></div><script>document.querySelector("#target").attachShadow({mode:"closed"}).append(document.createTextNode("Hidden marker"))</script>'
      : '<iframe id="target" src="/frame" style="left:20px;top:20px;width:120px;height:60px;border:0"></iframe>';
    await measuredPage(`${content}<div id="ordinary" style="left:300px;top:30px;color:white">Readable marker</div>`, async ({ page, capture, decode }: any) => {
      const box = kind === 'closed shadow' ? await page.locator('#target').boundingBox() : await page.frameLocator('#target').locator('#frame-field').boundingBox();
      const ordinary = await page.locator('#ordinary').boundingBox();
      assert.ok(box && ordinary);
      assert.deepEqual(box, { x: 20, y: 20, width: 120, height: 60 });
      const before = await decode(await capture.raw());
      assert.deepEqual(pixelAt(before, 25, 25), [240, 30, 50, 255]);
      const result = await capture.result();
      assert.equal(result.ok, true);
      assert.ok(JSON.stringify(result.snapshot).includes('Readable marker'));
      assert.ok(Buffer.isBuffer(result.image.bytes), `image status: ${result.image.code}`);
      const after = await decode(result.image.bytes);
      assertRectBlack(after, box);
      assertVisibleUnchanged(before, after, ordinary);
    });
  });
});

async function measuredPage(body: string, run: (fixture: any) => Promise<void>) {
  const { chromium } = require(process.env.FOLIOME_STAND_PLAYWRIGHT_CORE ?? 'playwright-core');
  const { prepareDomCollector } = await import('../../core/adapters/browser/collect-dom.ts') as any;
  const { captureCabinetSnapshot } = await import('../../core/adapters/browser/capture-snapshot.ts') as any;
  const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, args: ['--disable-gpu'] });
  try {
    const context = await browser.newContext({ viewport: { width: 480, height: 260 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    try {
      await context.route('**/*', async (route: any) => {
        const request = route.request();
        if (request.method() !== 'GET') return route.abort();
        if (request.url() === `${origin}/overview`) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Synthetic overview</title><style>html,body{margin:0;background:rgb(30,180,70)} body>div,body>input,body>label,body>iframe{position:absolute} label input{position:static}</style>${body}` });
        if (request.url() === `${origin}/frame`) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>html,body{margin:0;background:rgb(30,180,70)} input{display:block;box-sizing:border-box;width:120px;height:60px;background:rgb(240,30,50);border:0}</style><input id="frame-field" type="password" value="synthetic-value">' });
        return route.abort();
      });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      const collector = await prepareDomCollector(cdp, { sourceHost: 'cabinet.invalid', approvedHosts: [] });
      try {
        await page.goto(`${origin}/overview`, { waitUntil: 'load' });
        const raw = async () => Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64');
        const timer = clock();
        const result = () => captureCabinetSnapshot({ collect: () => collector.collectFrame(51), capturePng: raw, now: timer.now, sleep: timer.sleep, recordDeviation: async () => {} }, () => session, 600);
        const decoder = await context.newPage();
        const decode = (bytes: Buffer) => decoder.evaluate(async (encoded: string) => {
          const image = new Image(); image.src = `data:image/png;base64,${encoded}`; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
          const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
          return { width: image.width, data: Array.from(ctx.getImageData(0, 0, image.width, image.height).data) };
        }, bytes.toString('base64'));
        await run({ page, capture: { raw, result }, decode });
      } finally { await collector.close(); }
    } finally { await context.close(); }
  } finally { await browser.close(); }
}

function pixelAt(image: any, x: number, y: number) {
  return image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4);
}

function assertRectBlack(image: any, box: any) {
  for (let y = Math.ceil(box.y); y < Math.floor(box.y + box.height); y++) {
    for (let x = Math.ceil(box.x); x < Math.floor(box.x + box.width); x++) {
      assert.deepEqual(pixelAt(image, x, y), [0, 0, 0, 255], `pixel ${x},${y}`);
    }
  }
}

function assertVisibleUnchanged(before: any, after: any, box: any) {
  let visible = 0;
  for (let y = Math.ceil(box.y); y < Math.floor(box.y + box.height); y++) {
    for (let x = Math.ceil(box.x); x < Math.floor(box.x + box.width); x++) {
      const pixel = pixelAt(before, x, y);
      if (pixel[0] !== 30 || pixel[1] !== 180 || pixel[2] !== 70) visible++;
      assert.deepEqual(pixelAt(after, x, y), pixel, `visible pixel ${x},${y}`);
    }
  }
  assert.ok(visible > 0, 'visible pixels must be rendered');
}
