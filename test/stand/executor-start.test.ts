const assert = require('node:assert/strict');
const test = require('node:test');
const { executorStand, ownerOrigin, privateMarker } = require('./support/executor-start.ts');

function unavailable(response: any) {
  assert.equal(response.result?.isError, true);
  assert.equal(response.result?.content?.[0]?.text, 'session-unavailable');
}

async function confirmOwner(kernel: any, client: any) {
  await kernel.sourcePage().getByLabel('Synthetic password').fill('synthetic-password');
  unavailable(await client.call('current_task'));
  const ownerPage = kernel.ownerPage();
  await ownerPage.goto(`${ownerOrigin}/`);
  const form = ownerPage.locator('form');
  assert.equal(await form.count(), 1);
  const post = ownerPage.waitForRequest((request: any) => request.method() === 'POST' && request.url() === `${ownerOrigin}/preparation/login-complete`);
  await form.getByRole('button', { name: 'Вход завершён, продолжить' }).click();
  const request = await post;
  assert.equal((await request.allHeaders()).origin, ownerOrigin);
  assert.equal(request.frame(), ownerPage.mainFrame());
  assert.equal((await client.call('current_task')).result?.isError, undefined);
  await ownerPage.goto(`${ownerOrigin}/`);
  assert.equal(await ownerPage.locator('form').count(), 0, 'confirmation is single-use');

}

test('запускает без данных при исправной границе и показывает причину закрытого отказа', { timeout: 120_000 }, async (t: any) => {
  for (const [name, observation, code] of [
    ['permissions', { permissions: { home: true, app: false, data: true, channel: true, socket: true } }, 'boundary-permissions'],
    ['admin exact membership', { adminMembers: ['root', 'synthetic-owner', 'synthetic-extra'] }, 'boundary-admin'],
    ['canary timeout', { canary: 'timeout' }, 'boundary-pf'],
  ] as const) {
    await t.test(name, async () => executorStand({ observation }, async ({ kernel, calls, chromeLaunches }: any) => {
      const before = chromeLaunches.length;
      await kernel.startExecutor();
      assert.equal(calls.length, 0);
      assert.equal(chromeLaunches.length, before, 'blocked launch must not create an agent browser');
      const view = await kernel.ownerPage().locator('body').innerText();
      assert.ok(view.includes(code), `owner view must show ${code}`);
      assert.ok(!view.includes(privateMarker));
    }));
  }
  await t.test('spawn failure leaves the channel unavailable', async () => executorStand({ spawnFails: true }, async ({ kernel, calls, connect }: any) => {
    await kernel.openSource();
    await kernel.startExecutor();
    assert.equal(calls.length, 1);
    assert.ok((await kernel.ownerPage().locator('body').innerText()).includes('executor-launch'));
    assert.ok(!(await kernel.ownerPage().locator('body').innerText()).includes(privateMarker));
    const client = await connect();
    unavailable(await client.call('current_task'));
  }));
  for (const closing of ['source', 'owner'] as const) {
    await t.test(`success and ${closing} close revocation`, async () => executorStand({}, async ({ kernel, paths, calls, connect }: any) => {
      await kernel.openSource();
      await kernel.startExecutor();
      assert.deepEqual(calls, [['/usr/bin/ssh', ['-F', paths.sshConfig, 'executor-core'], { stdio: 'ignore', env: {} }]]);
      const client = await connect();
      unavailable(await client.call('current_task'));
      await confirmOwner(kernel, client);
      if (closing === 'source') await kernel.sourcePage().close();
      else await kernel.ownerPage().close();
      unavailable(await client.call('current_task'));
      const fresh = await connect();
      unavailable(await fresh.call('current_task'));
    }));
  }
});
