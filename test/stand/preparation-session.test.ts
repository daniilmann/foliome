const assert = require('node:assert/strict');
const test = require('node:test');
const { stand, scope, instruction, owner } = require('./support/preparation.ts');

function errorCode(response: any) {
  assert.equal(response.result?.isError, true);
  return response.result.content[0].text;
}

function snapshotFrom(response: any) {
  assert.equal(response.result?.isError, undefined);
  return response.result.content
    .filter((part: any) => part.type === 'text')
    .map((part: any) => {
      try {
        return JSON.parse(part.text);
      } catch {
        return null;
      }
    })
    .find((value: any) => value && Number.isSafeInteger(value.snapshot));
}

test(
  'отказывает до открытия и после ручного входа проверяет первое задание по каналу первый нумерованный фильтрованный снимок и переход к readText без доступа к секретам',
  { timeout: 60_000 },
  async () => {
    await stand(async ({ runtime, connect, login, db, secret }: any) => {
      const client = await connect();
      assert.equal(errorCode(await client.call('current_task')), 'session-unavailable');
      assert.equal(errorCode(await client.call('snapshot')), 'session-unavailable');
      await runtime.open();
      assert.equal(errorCode(await client.call('current_task')), 'session-unavailable');
      await login();
      const task = await client.call('current_task');
      assert.deepEqual(JSON.parse(task.result.content[0].text), {
        type: 'preparation',
        sourceId: scope.sourceId,
        instruction,
      });
      const result = await client.call('snapshot');
      const snapshot = snapshotFrom(result);
      assert.equal(snapshot.snapshot, 1);
      assert.ok(!JSON.stringify(result).includes(secret));
      const image = result.result.content.find((part: any) => part.type === 'image');
      assert.equal(image?.mimeType, 'image/png');
      assert.deepEqual(
        Buffer.from(image.data, 'base64').subarray(0, 8),
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      const target = snapshot.elements.find((element: any) =>
        element.text.includes('Synthetic visible text'),
      );
      assert.ok(target?.n > 0);
      const read = await client.call('readText', {
        snapshotNumber: snapshot.snapshot,
        nodeNumber: target.n,
      });
      assert.ok(read.result.content.some((part: any) => part.text === 'Synthetic visible text'));
      assert.equal(snapshotFrom(read).snapshot, 2);
      assert.ok(!JSON.stringify(read).includes(secret));
      const verdict = db
        .prepare(
          'SELECT snapshot_number, node_number, decision, reason FROM action_verdicts ORDER BY id DESC LIMIT 1',
        )
        .get();
      assert.deepEqual(
        { ...verdict },
        { snapshot_number: 1, node_number: target.n, decision: 'allowed', reason: 'allowed' },
      );
      assert.equal(
        db.prepare('SELECT status FROM action_outcomes ORDER BY verdict_id DESC LIMIT 1').get()
          .status,
        'ok',
      );
      assert.ok(!JSON.stringify(db.prepare('SELECT * FROM text_snapshots').all()).includes(secret));
    });
  },
);

test(
  'закрывает окно и отказывает старому и новому соединениям пока исполнитель работает',
  { timeout: 60_000 },
  async () => {
    await stand(
      async ({
        runtime,
        connect,
        login,
        sourcePage,
        ownerPage,
        closing,
        delayClose,
        releaseClose,
        executorRunning,
      }: any) => {
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
      },
    );
  },
);

test(
  'замена идентичного узла после защищённого снимка не привязывает старый номер к новому объекту',
  { timeout: 60_000 },
  async () => {
    await stand(
      async ({
        runtime,
        connect,
        login,
        sourcePage,
        collector,
        armReplacement,
        disarmReplacement,
        snapshotObserveCalls,
        successfulReads,
      }: any) => {
        await runtime.open();
        await login();
        const client = await connect();
        const before = await collector().observeTargets(1);
        const target = before.candidates.find(
          (item: any) => item.text === 'Synthetic visible text',
        );
        assert.ok(target);
        armReplacement();
        const response = await client.call('snapshot');
        const snapshot = snapshotFrom(response);
        assert.equal(snapshot.snapshot, 1);
        assert.equal(
          snapshot.elements.find((item: any) => item.text === target.text)?.n,
          target.nodeNumber,
        );
        assert.equal(
          response.result.content.find((part: any) => part.type === 'image')?.mimeType,
          'image/png',
        );
        disarmReplacement();
        if (snapshotObserveCalls() === 0)
          await sourcePage().getByRole('button', { name: 'Replace synthetic node' }).click();
        const after = await collector().observeTargets(1);
        const replacement = after.candidates.find(
          (item: any) => item.nodeNumber === target.nodeNumber,
        );
        assert.equal(replacement.text, target.text);
        assert.equal(replacement.descriptor, target.descriptor);
        assert.notEqual(replacement.identity, target.identity);
        assert.deepEqual(await collector().readObservedTarget(1, target.nodeNumber, target), {
          ok: false,
          code: 'stale',
        });
        assert.equal(successfulReads(), 0);
        const read = await client.call('readText', {
          snapshotNumber: 1,
          nodeNumber: target.nodeNumber,
        });
        assert.deepEqual(
          {
            isError: read.result?.isError,
            code: read.result?.content?.[0]?.text,
            successfulReads: successfulReads(),
            snapshotObserveCalls: snapshotObserveCalls(),
          },
          { isError: true, code: 'stale', successfulReads: 0, snapshotObserveCalls: 0 },
        );
      },
    );
  },
);
