const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const test = require('node:test');
const { stand } = require('./support/preparation.ts') as typeof import('./support/preparation.ts');

test(
  'ядро подтверждает признаки Chrome и закрывает сессию на третьем строгом отказе',
  { timeout: 60_000 },
  async () => {
    await stand(async (fixture) => {
      await fixture.runtime.open();
      await fixture.login();
      const page = fixture.sourcePage() as import('playwright-core').Page;
      await page.setContent(`<!doctype html><title>Inert controls</title>
      <a href="/payment?view=1">Preview link</a>
      <form action="/payment?private=synthetic-marker"><button>Preview form</button></form>
      <form action="/report"><input type="date"><select><option>Quarter</option></select>
      <button>Change <span>period</span></button></form>
      <button type="button">Settings</button><button type="button">Apply</button>
      <input id="protected-control" name="recipient">`);
      const client = await fixture.connect();
      async function target(
        match: (element: { text: string; attrs?: { id?: string } }) => boolean,
      ) {
        const response = await client.call('snapshot');
        assert.equal(response.result.isError, undefined);
        const text = response.result.content[0].text;
        assert.doesNotMatch(text, /synthetic-marker|formFieldKinds/);
        const snapshot = JSON.parse(text);
        const element = snapshot.elements.find(match);
        assert.ok(element);
        return { snapshotNumber: snapshot.snapshot, nodeNumber: element.n };
      }
      const byText = (text: string) => target((element) => element.text.trim() === text);
      async function deny(
        args: { snapshotNumber: number; nodeNumber: number },
        reason: string,
        revoked = false,
      ) {
        const response = await client.call('readText', args);
        assert.equal(response.result.isError, true);
        assert.equal(response.result.content[0].text, reason);
        if (revoked) {
          assert.equal(response.result.content.length, 1);
        } else {
          assert.ok(
            response.result.content[1],
            'ordinary refusal must include the committed snapshot',
          );
          const snapshot = JSON.parse(response.result.content[1].text);
          assert.equal(snapshot.snapshot, args.snapshotNumber + 1);
          const stored = fixture.db
            .prepare('SELECT snapshot_json FROM text_snapshots WHERE snapshot_number = ?')
            .get(snapshot.snapshot);
          assert.deepEqual(JSON.parse(stored.snapshot_json), snapshot);
          assert.ok(
            response.result.content.some(
              (part: any) =>
                part.type === 'image' ||
                ['login-step', 'unstable', 'limit', 'error'].includes(part.text),
            ),
          );
        }
      }

      const safe = await client.call('readText', {
        ...(await byText('Change')),
        options: { deep: true },
      });
      assert.equal(safe.result.content[0].text.replace(/\s+/g, ' '), 'Change period');
      const stale = await byText('Preview form');
      await page
        .locator('form')
        .first()
        .evaluate((form) => form.setAttribute('action', '/report'));
      await deny(stale, 'stale');
      await page
        .locator('form')
        .first()
        .evaluate((form) => form.setAttribute('action', '/payment'));

      for (let i = 0; i < 9; i++) await deny(await byText('Settings'), 'blocked-change');
      await deny(await byText('Apply'), 'blocked-change');
      await deny(await byText('Preview link'), 'blocked-payment');
      await deny(await byText('Preview form'), 'blocked-payment');
      const recipient = await target((element) => element.attrs?.id === 'protected-control');
      fixture.clearSends();
      await deny(recipient, 'blocked-payment', true);
      await fixture.closing.promise;
      assert.equal(
        fixture.sends.some((call: { method: string }) => call.method === 'Page.captureScreenshot'),
        false,
      );

      fixture.clearSends();
      assert.equal((await client.call('snapshot')).result.content[0].text, 'session-unavailable');
      assert.equal(fixture.sends.length, 0);
      assert.equal(fixture.successfulReads(), 1);
      assert.deepEqual(
        fixture.runtime.rows().map((row: { reason: string }) => row.reason),
        [
          'allowed',
          'stale',
          ...Array(10).fill('blocked-change'),
          'blocked-payment',
          'blocked-payment',
          'blocked-payment',
          'limit',
        ],
      );
    });
  },
);

test(
  'ядро закрывает сессию ровно на десятой безусловной подписи',
  { timeout: 60_000 },
  async () => {
    await stand(async (fixture) => {
      await fixture.runtime.open();
      await fixture.login();
      const page = fixture.sourcePage() as import('playwright-core').Page;
      await page.setContent('<button type="button">Settings</button>');
      const client = await fixture.connect();
      for (let count = 1; count <= 10; count++) {
        const before = await client.call('snapshot');
        assert.equal(before.result.isError, undefined, String(count));
        const snapshot = JSON.parse(before.result.content[0].text);
        const target = snapshot.elements.find((item: { text: string }) => item.text === 'Settings');
        assert.ok(target);
        const denied = await client.call('readText', {
          snapshotNumber: snapshot.snapshot,
          nodeNumber: target.n,
        });
        assert.equal(denied.result.content[0].text, 'blocked-change');
      }
      await fixture.closing.promise;
      assert.equal((await client.call('snapshot')).result.content[0].text, 'session-unavailable');
      assert.equal(fixture.successfulReads(), 0);
      assert.deepEqual(
        fixture.runtime.rows().map((row: { reason: string }) => row.reason),
        [...Array(10).fill('blocked-change'), 'limit'],
      );
    });
  },
);

test(
  'обычный отказ обновляет снимок и отменяет ссылку прежнего снимка',
  { timeout: 60_000 },
  async () => {
    await stand(async (fixture) => {
      await fixture.runtime.open();
      await fixture.login();
      await fixture
        .sourcePage()
        .setContent('<button type="button">Settings</button><p>Visible marker</p>');
      const client = await fixture.connect();
      const before = JSON.parse((await client.call('snapshot')).result.content[0].text);
      const target = before.elements.find((item: { text: string }) => item.text === 'Settings');
      const args = { snapshotNumber: before.snapshot, nodeNumber: target.n };
      const denied = await client.call('readText', args);
      assert.equal(denied.result.isError, true);
      assert.equal(denied.result.content[0].text, 'blocked-change');
      assert.ok(denied.result.content[1], 'ordinary refusal must include the committed snapshot');
      const next = JSON.parse(denied.result.content[1].text);
      assert.equal(next.snapshot, before.snapshot + 1);
      const stored = fixture.db
        .prepare('SELECT snapshot_json FROM text_snapshots WHERE snapshot_number = ?')
        .get(next.snapshot);
      assert.deepEqual(JSON.parse(stored.snapshot_json), next);
      assert.ok(
        denied.result.content.some(
          (part: any) =>
            part.type === 'image' ||
            ['login-step', 'unstable', 'limit', 'error'].includes(part.text),
        ),
      );
      assert.equal((await client.call('readText', args)).result.content[0].text, 'stale');
    });
  },
);
