const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const day = 24 * 60 * 60 * 1000;

function filtered(snapshot: number, path = '/overview') {
  const { filterTextSnapshot } = require('../../../core/domain/snapshot-filter.ts');
  const result = filterTextSnapshot({
    snapshot,
    page: { url: `https://source.example${path}?token=synthetic-raw-marker`, title: 'Обзор' },
    frames: [{ index: 0, host: 'source.example', foreign: false, unavailable: false }],
    nodes: [
      { n: 1, frame: 0, visible: true, role: 'text', text: 'Открытый текст synthetic-secret-marker' },
      { n: 2, frame: 0, visible: true, role: 'textbox', field: 'filled', text: 'synthetic-field-marker', value: 'synthetic-field-value' },
      { n: 3, frame: 0, visible: false, role: 'text', text: 'synthetic-hidden-marker' },
    ],
    secrets: [{ kind: 'password', value: 'synthetic-secret-marker' }],
  });
  assert.equal(result.ok, true);
  return result;
}

test('выдаёт и хранит фильтрованный текст и проверяет условия селектора по маскам', async () => {
  const { createTextSnapshotStore } = await import('../../../core/adapters/store/text-snapshot-store.ts');
  const db = new DatabaseSync(':memory:');
  try {
    let now = 0;
    const store = createTextSnapshotStore(db, () => now);
    const first = filtered(1);
    const scopeA = { sourceId: 'source-a', accessId: 'access-a' };
    const scopeB = { sourceId: 'source-b', accessId: 'access-b' };
    const page = { host: first.snapshot.page.host, path: first.snapshot.page.path };
    await store.append({ sessionId: 'session-a', ...scopeA, result: first });
    await store.append({ sessionId: 'session-b', ...scopeB, result: filtered(2) });

    const schema = db.prepare('PRAGMA table_list').all().find((row: { name: string }) => row.name === 'text_snapshots');
    assert.equal(schema.strict, 1);
    const columns = db.prepare('PRAGMA table_info(text_snapshots)').all();
    assert.ok(columns.some((column: { name: string; type: string }) => column.name === 'snapshot_json' && column.type === 'TEXT'));
    assert.ok(columns.every((column: { name: string; type: string }) =>
      !/png|image|raw|html/i.test(column.name) && !['REAL', 'ANY'].includes(column.type)));
    const rows = db.prepare('SELECT * FROM text_snapshots').all();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      const json = row.snapshot_json as string;
      assert.match(json, /\[секрет\]/);
      assert.doesNotMatch(JSON.stringify(row), /synthetic-(?:field|hidden|secret|raw)-marker|synthetic-field-value/);
      assert.deepEqual(JSON.parse(json), row === rows[0] ? first.snapshot : filtered(2).snapshot);
    }
    assert.deepEqual(await store.latest({ ...scopeA, ...page }), first.snapshot);
    assert.deepEqual(await store.latest({ ...scopeB, ...page }), filtered(2).snapshot);
    assert.equal(await store.latest({ sourceId: scopeA.sourceId, accessId: scopeB.accessId, ...page }), null);
    assert.equal(await store.latest({ ...scopeA, host: 'other.example', path: page.path }), null);
    assert.equal(await store.latest({ ...scopeA, host: page.host, path: '/other' }), null);

    await assert.rejects(async () => store.append({ sessionId: 'session-a', ...scopeA, result: first }));
    assert.equal(db.prepare('SELECT count(*) AS n FROM text_snapshots').get().n, 2);
    assert.deepEqual(await store.latest({ ...scopeA, ...page }), first.snapshot);

    now = 90 * day;
    const second = filtered(3);
    await store.append({ sessionId: 'session-c', ...scopeA, result: second });
    await store.prune();
    assert.equal(db.prepare('SELECT count(*) AS n FROM text_snapshots').get().n, 3);
    now += 1;
    await store.prune();
    const remaining = db.prepare('SELECT snapshot_json FROM text_snapshots').all()
      .map((row: { snapshot_json: string }) => JSON.parse(row.snapshot_json));
    assert.equal(remaining.length, 2);
    assert.ok(remaining.some((snapshot: { snapshot: number }) => snapshot.snapshot === 2));
    assert.ok(remaining.some((snapshot: { snapshot: number }) => snapshot.snapshot === 3));
    assert.deepEqual(await store.latest({ ...scopeA, ...page }), second.snapshot);
    assert.deepEqual(await store.latest({ ...scopeB, ...page }), filtered(2).snapshot);
    now += 91 * day;
    await store.prune();
    assert.equal(db.prepare('SELECT count(*) AS n FROM text_snapshots').get().n, 2);
    assert.deepEqual(await store.latest({ ...scopeA, ...page }), second.snapshot);
    assert.deepEqual(await store.latest({ ...scopeB, ...page }), filtered(2).snapshot);
  } finally {
    db.close();
  }
});
