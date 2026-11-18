const assert = require('node:assert/strict');
const test = require('node:test');
const { executorStand, ownerOrigin, privateMarker, waitUntil } = require('./support/executor-start.ts');

function unavailable(response: any) {
  assert.equal(response.result?.isError, true);
  assert.equal(response.result?.content?.[0]?.text, 'session-unavailable');
}

async function confirmOwner(kernel: any, calls: any[]) {
  await kernel.sourcePage().getByLabel('Synthetic password').fill('synthetic-password');
  const ownerPage = kernel.ownerPage();
  await ownerPage.goto(`${ownerOrigin}/`);
  const form = ownerPage.locator('form');
  await waitUntil(async () => await form.count() === 1, 'owner confirmation form missing');
  assert.equal(calls.length, 0, 'executor must not start before the owner POST');
  const post = ownerPage.waitForRequest((request: any) => request.method() === 'POST' && request.url() === `${ownerOrigin}/preparation/login-complete`, { timeout: 10_000 });
  await form.getByRole('button', { name: 'Вход завершён, продолжить' }).click();
  const request = await post;
  assert.equal((await request.allHeaders()).origin, ownerOrigin);
  assert.equal(request.frame(), ownerPage.mainFrame());
}

async function openBeforeConfirmation(kernel: any, calls: any[], connect: any) {
  await kernel.openSource();
  const client = await connect();
  unavailable(await client.call('current_task'));
  assert.equal(calls.length, 0, 'executor must not start before the owner POST');
  return client;
}

async function shown(kernel: any, code: string) {
  const body = kernel.ownerPage().locator('body');
  await waitUntil(async () => (await body.innerText()).includes(code), `owner view must automatically show ${code}`);
  assert.ok(!(await body.innerText()).includes(privateMarker));
}

test('запускает без данных при исправной границе и показывает причину закрытого отказа', { timeout: 120_000 }, async (t: any) => {
  for (const [name, observation, code] of [
    ...['home', 'app', 'data', 'channel', 'socket'].map(key => [key, { permissions: { home: true, app: true, data: true, channel: true, socket: true, [key]: false } }, 'boundary-permissions'] as const),
    ['admin exact membership', { adminMembers: ['root', 'synthetic-owner', 'synthetic-extra'] }, 'boundary-admin'],
    ['canary timeout', { canary: 'timeout' }, 'boundary-pf'],
  ] as const) {
    await t.test(name, async () => executorStand({ observation }, async ({ kernel, calls, chromeLaunches, connect }: any) => {
      const client = await openBeforeConfirmation(kernel, calls, connect);
      const before = chromeLaunches.length;
      await confirmOwner(kernel, calls);
      await shown(kernel, code);
      assert.equal(calls.length, 0);
      assert.equal(chromeLaunches.length, before, 'blocked launch must not create an agent browser');
      unavailable(await client.call('current_task'));
      unavailable(await (await connect()).call('current_task'));
    }));
  }
  await t.test('spawn failure leaves the channel unavailable', async () => executorStand({ spawnFails: true }, async ({ kernel, paths, calls, connect }: any) => {
    const client = await openBeforeConfirmation(kernel, calls, connect);
    await confirmOwner(kernel, calls);
    await shown(kernel, 'executor-launch');
    assert.deepEqual(calls, [['/usr/bin/ssh', ['-F', paths.sshConfig, 'executor-core'], { stdio: 'ignore', env: {} }]]);
    unavailable(await client.call('current_task'));
    unavailable(await (await connect()).call('current_task'));
  }));
  for (const closing of ['source', 'owner'] as const) {
    await t.test(`success and ${closing} close revocation`, async () => executorStand({}, async ({ kernel, paths, calls, connect }: any) => {
      const client = await openBeforeConfirmation(kernel, calls, connect);
      await confirmOwner(kernel, calls);
      await waitUntil(() => calls.length > 0, 'executor launch missing after owner POST');
      assert.deepEqual(calls, [['/usr/bin/ssh', ['-F', paths.sshConfig, 'executor-core'], { stdio: 'ignore', env: {} }]]);
      await waitUntil(async () => {
        const response = await client.call('current_task');
        if (response.result?.isError === true) { unavailable(response); return false; }
        assert.equal(response.result?.content?.[0]?.type, 'text');
        assert.deepEqual(JSON.parse(response.result.content[0].text), { type: 'preparation', sourceId: 'synthetic-source', instruction: 'Inspect the synthetic overview' });
        return true;
      }, 'session did not become available');
      await kernel.ownerPage().goto(`${ownerOrigin}/`);
      assert.equal(await kernel.ownerPage().locator('form').count(), 0, 'confirmation is single-use');
      assert.equal(calls.length, 1);
      if (closing === 'source') {
        await kernel.sourcePage().close();
        await waitUntil(async () => {
          const response = await client.call('current_task');
          return response.result?.isError === true && response.result?.content?.[0]?.text === 'session-unavailable';
        }, 'old connection was not revoked');
        unavailable(await (await connect()).call('current_task'));
      } else {
        await kernel.ownerPage().close();
        for (const getClient of [async () => client, connect]) {
          await waitUntil(async () => {
            try {
              const response = await (await getClient()).call('current_task');
              if (response.result?.isError !== true) return false;
              unavailable(response);
              return true;
            } catch (error: any) {
              if (['channel closed', 'ECONNREFUSED', 'ENOENT', 'ECONNRESET', 'EPIPE'].some(value => error.message.includes(value) || error.code === value)) return true;
              throw error;
            }
          }, 'connection remained available after owner window closed');
        }
      }
    }));
  }
});
