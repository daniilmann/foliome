const assert = require('node:assert/strict');
const test = require('node:test');
const { stand, scope, owner } = require('./support/preparation.ts');

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

function png(response: any) {
  const image = response.result.content.find((part: any) => part.type === 'image');
  assert.equal(image?.mimeType, 'image/png');
  assert.deepEqual(
    Buffer.from(image.data, 'base64').subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
}

test(
  'после завершения ручного входа видит фильтрованный текст протокол и защищённый PNG с одним номером снимка причину отказа и прекращает доступ после закрытия',
  { timeout: 60_000 },
  async () => {
    await stand(
      async ({
        runtime,
        connect,
        login,
        db,
        ownerPage,
        sourcePage,
        secret,
        sends,
        clearSends,
      }: any) => {
        await runtime.open();
        await login();
        clearSends();
        const old = await connect();
        const first = await old.call('snapshot');
        const snapshot = snapshotFrom(first);
        assert.equal(snapshot.snapshot, 1);
        png(first);
        const target = snapshot.elements.find((element: any) =>
          element.text.includes('Synthetic visible text'),
        );
        assert.ok(target?.n > 0);
        const read = await old.call('readText', {
          snapshotNumber: snapshot.snapshot,
          nodeNumber: target.n,
        });
        const next = snapshotFrom(read);
        assert.equal(next.snapshot, snapshot.snapshot + 1);
        assert.ok(read.result.content.some((part: any) => part.text === 'Synthetic visible text'));
        png(read);
        assert.equal(JSON.stringify([first, read]).includes(secret), false);
        const stored = db
          .prepare(
            'SELECT session_id, source_id, access_id, snapshot_number, snapshot_json FROM text_snapshots WHERE snapshot_number = ?',
          )
          .get(next.snapshot);
        assert.deepEqual(
          { sessionId: stored.session_id, sourceId: stored.source_id, accessId: stored.access_id },
          scope,
        );
        assert.deepEqual(JSON.parse(stored.snapshot_json), next);
        assert.equal(JSON.stringify(stored).includes(secret), false);
        const allowed = db
          .prepare(
            'SELECT v.id, v.session_id, v.source_id, v.access_id, v.snapshot_number, v.node_number, v.decision, v.reason, o.status FROM action_verdicts v JOIN action_outcomes o ON o.verdict_id = v.id',
          )
          .get();
        assert.deepEqual(
          {
            sessionId: allowed.session_id,
            sourceId: allowed.source_id,
            accessId: allowed.access_id,
          },
          scope,
        );
        assert.deepEqual(
          [
            allowed.snapshot_number,
            allowed.node_number,
            allowed.decision,
            allowed.reason,
            allowed.status,
          ],
          [snapshot.snapshot, target.n, 'allowed', 'allowed', 'ok'],
        );
        assert.equal(
          sends.some((send: any) =>
            /^(Input\.|DOM\.(set|remove|focus|perform)|Page\.(navigate|reload))/.test(send.method),
          ),
          false,
        );
        assert.equal(JSON.stringify(sends).includes(secret), false);
        const html = await sourcePage().content();
        clearSends();
        const refusal = await old.call('unsupported_command');
        assert.ok(refusal.error || refusal.result?.isError);
        assert.equal(await sourcePage().content(), html);
        assert.equal(
          sends.some((send: any) =>
            /^(Input\.|DOM\.(set|remove|focus|perform)|Page\.(navigate|reload))/.test(send.method),
          ),
          false,
        );
        assert.equal(JSON.stringify(sends).includes(secret), false);
        await ownerPage.goto(`${owner}/`);
        const rows = await ownerPage.locator('tbody tr').allTextContents();
        const blocked = db
          .prepare(
            "SELECT decision, reason FROM action_verdicts WHERE decision = 'blocked' AND reason = 'unsupported'",
          )
          .get();
        await runtime.closeSource();
        assert.equal(sourcePage().isClosed(), true);
        assert.equal(
          (await old.call('snapshot')).result?.content?.[0]?.text,
          'session-unavailable',
        );
        const fresh = await connect();
        assert.equal(
          (await fresh.call('current_task')).result?.content?.[0]?.text,
          'session-unavailable',
        );
        assert.equal(ownerPage.isClosed(), false);
        assert.ok(await ownerPage.getByRole('table').isVisible());
        assert.ok(
          rows.some(
            (row: string) =>
              row.includes('разрешено') &&
              row.includes('readText') &&
              row.includes('ok') &&
              row.includes(scope.sourceId) &&
              row.includes(scope.accessId) &&
              row.includes(String(target.n)),
          ),
        );
        assert.ok(
          rows.some(
            (row: string) =>
              row.includes('заблокировано') &&
              row.includes('Метод не поддерживается') &&
              row.includes('unsupported'),
          ),
          'неподдерживаемая команда должна быть видна в протоколе с причиной',
        );
        assert.ok(blocked, 'неподдерживаемая команда должна быть записана в SQLite');
      },
    );
  },
);
