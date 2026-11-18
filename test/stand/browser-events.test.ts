const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { executorStand, ownerOrigin, waitUntil } = require('./support/executor-start.ts');

const marker = 'synthetic-private-error';

async function openAndConfirm(kernel: any, calls: any[]) {
  const owner = kernel.ownerPage();
  const count = calls.length;
  await owner.goto(`${ownerOrigin}/`);
  await owner.getByRole('button', { name: 'Открыть подготовку', exact: true }).click();
  await kernel.sourcePage().getByLabel('Synthetic password').fill('synthetic-password');
  const confirmation = owner.getByRole('button', { name: 'Вход завершён, продолжить' });
  await confirmation.click();
  await waitUntil(() => calls.length === count + 1, 'worker did not start');
}

function code(response: any) {
  assert.equal(response.result?.isError, true);
  return response.result.content[0].text;
}

function snapshot(response: any) {
  assert.equal(response.result?.isError, undefined);
  return response.result.content.filter((part: any) => part.type === 'text').map((part: any) => {
    try { return JSON.parse(part.text); } catch { return null; }
  }).find((value: any) => Number.isSafeInteger(value?.snapshot));
}

async function active(client: any) {
  await waitUntil(async () => !(await client.call('current_task')).result?.isError, 'session did not become active');
}

test('записывает переход главного кадра и не GET запрос до чтения агента с безопасным адресом', { timeout: 60_000 }, async () => {
  await executorStand({}, async ({ kernel, paths, calls, connect }: any) => {
    await openAndConfirm(kernel, calls);
    const db = new DatabaseSync(paths.database, { readOnly: true });
    try {
      const page = kernel.sourcePage();
      await page.getByRole('link', { name: 'Next' }).click();
      await page.getByRole('button', { name: 'Submit synthetic' }).click();
      await waitUntil(() => db.prepare('SELECT count(*) AS n FROM action_browser_events').get().n >= 2, 'browser events were not recorded');
      const rows = db.prepare('SELECT session_id, source_id, access_id, step_number, kind, method, host, path FROM action_browser_events ORDER BY id').all();
      const navigation = rows.find((row: any) => row.kind === 'main-frame-navigation' && row.path.startsWith('/next'));
      const post = rows.find((row: any) => row.kind === 'non-get-request' && row.path.startsWith('/submit'));
      assert.ok(navigation);
      assert.ok(post);
      for (const [row, method] of [[navigation, 'GET'], [post, 'POST']] as const) {
        assert.deepEqual([row.session_id, row.source_id, row.access_id, row.method, row.host], ['synthetic-session', 'synthetic-source', 'synthetic-access', method, 'cabinet.invalid']);
        assert.ok(Number.isSafeInteger(row.step_number) && row.step_number > 0);
        assert.ok(!row.path.includes('synthetic-query-marker'));
      }
      assert.ok(!JSON.stringify(rows).includes('synthetic-body-marker'));
      assert.equal(db.prepare('SELECT count(*) AS n FROM action_verdicts').get().n, 0);
      const client = await connect();
      await active(client);
    } finally { db.close(); }
  });
});

test('отказывает активному агенту и показывает причину при ошибке добавления события браузера', { timeout: 60_000 }, async () => {
  await executorStand({}, async ({ kernel, paths, calls, connect }: any) => {
    await openAndConfirm(kernel, calls);
    const client = await connect();
    await active(client);
    const db = new DatabaseSync(paths.database);
    try {
      db.exec(`CREATE TRIGGER synthetic_fail_browser_event BEFORE INSERT ON action_browser_events BEGIN SELECT RAISE(ABORT, '${marker}'); END`);
      assert.ok(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = 'synthetic_fail_browser_event'").get());
      assert.throws(() => db.prepare("INSERT INTO action_browser_events (at_ms, session_id, source_id, access_id, step_number, kind, method, host, path) VALUES (1, 'synthetic-session', 'synthetic-source', 'synthetic-access', 1, 'main-frame-navigation', 'GET', 'cabinet.invalid', '/next')").run(), new RegExp(marker));
      const page = kernel.sourcePage();
      const request = page.waitForRequest((item: any) => item.isNavigationRequest() && item.url().includes('/next?'));
      await page.getByRole('link', { name: 'Next' }).click().catch(() => {});
      await request;
      assert.equal(code(await client.call('current_task')), 'session-unavailable');
      for (const name of ['current_task', 'snapshot', 'current_task']) {
        const response = await client.call(name);
        assert.equal(code(response), 'session-unavailable');
        assert.ok(!JSON.stringify(response).includes(marker));
      }
      const body = kernel.ownerPage().locator('body');
      await waitUntil(async () => (await body.innerText()).includes('protocol-unavailable'), 'owner reason missing');
      assert.ok(!(await body.innerText()).includes(marker));
      assert.ok(!JSON.stringify(db.prepare('SELECT * FROM action_browser_events').all()).includes(marker));
    } finally { db.close(); }
  });
});

test('закрывает источник и повторно открывает отдельную сессию с новым работником и первым снимком', { timeout: 90_000 }, async () => {
  await executorStand({}, async ({ kernel, paths, calls, connect, finishProcess }: any) => {
    await openAndConfirm(kernel, calls);
    const old = await connect();
    await active(old);
    assert.equal(snapshot(await old.call('snapshot')).snapshot, 1);
    await assert.rejects(kernel.openSource(), /session-unavailable/);
    const oldPage = kernel.sourcePage();
    const oldBrowser = oldPage.context().browser();
    await oldPage.close();
    await waitUntil(() => !oldBrowser.isConnected(), 'old browser was not closed');
    await waitUntil(async () => code(await old.call('current_task')) === 'session-unavailable', 'old session not revoked');
    await waitUntil(async () => await kernel.ownerPage().getByRole('button', { name: 'Открыть подготовку', exact: true }).count() === 1, 'owner cannot reopen source');
    await openAndConfirm(kernel, calls);
    assert.notEqual(kernel.sourcePage(), oldPage);
    const fresh = await connect();
    await active(fresh);
    assert.equal(snapshot(await fresh.call('snapshot')).snapshot, 1);
    const db = new DatabaseSync(paths.database, { readOnly: true });
    try {
      const sessions = db.prepare('SELECT session_id, snapshot_number FROM text_snapshots ORDER BY rowid').all();
      assert.deepEqual(sessions.map((row: any) => row.snapshot_number), [1, 1]);
      assert.notEqual(sessions[0].session_id, sessions[1].session_id);
    } finally { db.close(); }
    assert.equal(code(await old.call('current_task')), 'session-unavailable');
    finishProcess(1, 0);
    await active(fresh);
    assert.equal(code(await old.call('snapshot')), 'session-unavailable');
  });
});
