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
  const [response] = await Promise.all([
    ownerPage.waitForResponse((response: any) => response.request().method() === 'POST' && response.url() === `${ownerOrigin}/preparation/login-complete`, { timeout: 10_000 }),
    form.getByRole('button', { name: 'Вход завершён, продолжить' }).click(),
  ]);
  assert.equal(response.status(), 200);
  const request = response.request();
  assert.equal((await request.allHeaders()).origin, ownerOrigin);
  assert.equal(request.frame(), ownerPage.mainFrame());
}

async function openBeforeConfirmation(kernel: any, calls: any[], connect: any) {
  const page = kernel.ownerPage();
  const response = await page.goto(`${ownerOrigin}/`);
  assert.equal(response?.status(), 200);
  const csp = response.headers()['content-security-policy'];
  for (const directive of ["default-src 'none'", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'"]) {
    assert.ok(csp?.split(';').some((part: string) => part.trim() === directive), `missing CSP directive: ${directive}`);
  }
  const confirmations: any[] = [];
  page.on('request', (request: any) => {
    if (request.method() === 'POST' && request.url() === `${ownerOrigin}/preparation/login-complete`) confirmations.push(request);
  });
  const openButton = page.getByRole('button', { name: 'Открыть подготовку', exact: true });
  assert.equal(await openButton.count(), 1, 'owner must be able to open preparation');
  const [opening] = await Promise.all([
    page.waitForResponse((response: any) => response.request().method() === 'POST' && response.request().frame() === page.mainFrame(), { timeout: 5_000 }),
    openButton.click({ timeout: 5_000 }),
  ]);
  assert.equal(opening.status(), 200);
  const request = opening.request();
  assert.equal(new URL(request.url()).origin, ownerOrigin);
  assert.equal((await request.allHeaders()).origin, ownerOrigin);
  assert.equal(request.frame(), page.mainFrame());
  assert.equal(confirmations.length, 0, 'opening must not confirm login');
  const client = await connect();
  unavailable(await client.call('current_task'));
  assert.equal(calls.length, 0, 'executor must not start before the owner POST');
  return { client, confirmations };
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
      const { client, confirmations } = await openBeforeConfirmation(kernel, calls, connect);
      const before = chromeLaunches.length;
      await confirmOwner(kernel, calls);
      assert.equal(confirmations.length, 1);
      await shown(kernel, code);
      assert.equal(calls.length, 0);
      assert.equal(chromeLaunches.length, before, 'blocked launch must not create an agent browser');
      unavailable(await client.call('current_task'));
      unavailable(await (await connect()).call('current_task'));
    }));
  }
  await t.test('spawn failure leaves the channel unavailable', async () => executorStand({ spawnFails: true }, async ({ kernel, paths, calls, connect }: any) => {
    const { client, confirmations } = await openBeforeConfirmation(kernel, calls, connect);
    await confirmOwner(kernel, calls);
    assert.equal(confirmations.length, 1);
    await shown(kernel, 'executor-launch');
    assert.deepEqual(calls, [['/usr/bin/ssh', ['-F', paths.sshConfig, 'executor-core'], { stdio: 'ignore', env: {} }]]);
    unavailable(await client.call('current_task'));
    unavailable(await (await connect()).call('current_task'));
  }));
  await t.test('nonzero process result leaves the channel unavailable', async () => executorStand({ processResult: 255 }, async ({ kernel, paths, calls, connect }: any) => {
    const { client, confirmations } = await openBeforeConfirmation(kernel, calls, connect);
    await confirmOwner(kernel, calls);
    await shown(kernel, 'executor-launch');
    assert.equal(confirmations.length, 1);
    assert.deepEqual(calls, [['/usr/bin/ssh', ['-F', paths.sshConfig, 'executor-core'], { stdio: 'ignore', env: {} }]]);
    unavailable(await client.call('current_task'));
    unavailable(await (await connect()).call('current_task'));
  }));
  for (const closing of ['source', 'owner'] as const) {
    await t.test(`success and ${closing} close revocation`, async () => executorStand({}, async ({ kernel, paths, calls, connect, stopCount }: any) => {
      const { client, confirmations } = await openBeforeConfirmation(kernel, calls, connect);
      await confirmOwner(kernel, calls);
      assert.equal(confirmations.length, 1);
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
      assert.equal(confirmations.length, 1);
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
      await kernel.close();
      assert.equal(stopCount(), 1, 'closing a live worker must request stop once');
    }));
  }
  await t.test('finished worker revokes the task and close stops at most once', async () => executorStand({}, async ({ kernel, calls, connect, finishProcess, stopCount }: any) => {
    const { client, confirmations } = await openBeforeConfirmation(kernel, calls, connect);
    await confirmOwner(kernel, calls);
    await waitUntil(async () => {
      const response = await client.call('current_task');
      if (response.result?.isError === true) { unavailable(response); return false; }
      assert.deepEqual(JSON.parse(response.result.content[0].text), { type: 'preparation', sourceId: 'synthetic-source', instruction: 'Inspect the synthetic overview' });
      return true;
    }, 'task must become available before the worker finishes');
    assert.equal(confirmations.length, 1);
    assert.equal(stopCount(), 0);
    finishProcess(0);
    await waitUntil(async () => {
      const response = await client.call('current_task');
      return response.result?.isError === true && response.result?.content?.[0]?.text === 'session-unavailable';
    }, 'finished worker did not revoke the task');
    unavailable(await (await connect()).call('current_task'));
    await kernel.close();
    await kernel.close();
    assert.ok(stopCount() <= 1, 'closing must request stop at most once');
  }));
});
