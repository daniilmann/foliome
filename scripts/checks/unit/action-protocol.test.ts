const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

test('дозаписывает вердикт перед вызовом и итог после вызова по схеме STRICT', async () => {
  const { createActionProtocol } = await import('../../../core/adapters/store/action-protocol.ts');
  const { createPreparationSession } = await import('../../../core/use-cases/preparation.ts');
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    let now = 1700000000000;
    const protocol = createActionProtocol(database, () => now++);
    const verdict = {
      sessionId: 'session-1',
      sourceId: 'source-1',
      accessId: 'access-1',
      snapshotNumber: 2,
      nodeNumber: 3,
      method: 'readText',
      actionClass: 'read',
      decision: 'allowed',
      reason: 'allowed',
      rawText: 'synthetic-raw-text-marker',
      url: 'synthetic-raw-url-marker',
    };
    let verdictId: number;
    const events: string[] = [];
    const session = createPreparationSession({
      openSource: async () => {},
      closeSource: async () => {},
      saveVerdict: async () => {
        verdictId = protocol.appendVerdict(verdict);
        events.push('verdict');
      },
      read: async () => {
        assert.equal(database.prepare('SELECT count(*) AS n FROM action_verdicts WHERE id = ?').get(verdictId).n, 1);
        assert.equal(database.prepare('SELECT count(*) AS n FROM action_outcomes').get().n, 0);
        events.push('read');
        return 'ok';
      },
      saveOutcome: async (status: string) => {
        protocol.appendOutcome({ verdictId, status, rawText: 'synthetic-outcome-marker' });
        events.push('outcome');
      },
    });
    await session.open();
    session.bindSnapshot('snapshot-2');
    assert.equal(await session.readForVerdict('snapshot-2'), 'ok');
    assert.deepEqual(events, ['verdict', 'read', 'outcome']);

    const row = database.prepare('SELECT * FROM action_verdicts WHERE id = ?').get(verdictId!);
    assert.deepEqual({ ...row }, {
      id: verdictId!, at_ms: 1700000000000, session_id: 'session-1', source_id: 'source-1',
      access_id: 'access-1', snapshot_number: 2, node_number: 3, method: 'readText',
      action_class: 'read', actor: 'agent', decision: 'allowed', reason: 'allowed',
    });
    const outcome = database.prepare('SELECT * FROM action_outcomes WHERE verdict_id = ?').get(verdictId!);
    assert.deepEqual({ ...outcome }, { verdict_id: verdictId!, at_ms: 1700000000001, status: 'ok' });
    for (const table of ['action_verdicts', 'action_outcomes']) {
      const schema = database.prepare('PRAGMA table_list').all().find((entry: { name: string }) => entry.name === table);
      assert.equal(schema.strict, 1);
      const columns = database.prepare(`PRAGMA table_info(${table})`).all();
      assert.ok(columns.every((column: { type: string }) => !['REAL', 'ANY'].includes(column.type)));
      assert.ok(!JSON.stringify(database.prepare(`SELECT * FROM ${table}`).all()).includes('synthetic-raw-'));
      assert.throws(() => database.exec(`UPDATE ${table} SET at_ms = 1`));
      assert.throws(() => database.exec(`DELETE FROM ${table}`));
    }
    const foreignKeys = database.prepare('PRAGMA foreign_key_list(action_outcomes)').all();
    assert.ok(foreignKeys.some((key: { table: string; from: string; to: string }) =>
      key.table === 'action_verdicts' && key.from === 'verdict_id' && key.to === 'id'));
    assert.throws(() => protocol.appendOutcome({ verdictId: 999999, status: 'internal' }));
    assert.throws(() => protocol.appendOutcome({ verdictId: verdictId!, status: 'stale' }));

    const blockedId = protocol.appendVerdict({ ...verdict, method: 'other', actionClass: 'unknown', decision: 'blocked', reason: 'unsupported' });
    const blocked = database.prepare('SELECT method, action_class, actor, decision, reason FROM action_verdicts WHERE id = ?').get(blockedId);
    assert.deepEqual({ ...blocked }, { method: 'other', action_class: 'unknown', actor: 'agent', decision: 'blocked', reason: 'unsupported' });
    await session.close();
  } finally {
    database.close();
  }
});
