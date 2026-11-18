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

const allowedVerdict = {
  sessionId: 'session-1', sourceId: 'source-1', accessId: 'access-1',
  snapshotNumber: 2, nodeNumber: 3, method: 'readText', actionClass: 'read',
  decision: 'allowed', reason: 'allowed',
} as const;

for (const [method, actionClass] of [
  ['other', 'read'], ['readText', 'unknown'], ['other', 'unknown'],
] as const) {
  test(`отклоняет allowed с ${method}/${actionClass} через API`, async () => {
    const { createActionProtocol } = await import('../../../core/adapters/store/action-protocol.ts');
    const database = new DatabaseSync(':memory:');
    try {
      const protocol = createActionProtocol(database, () => 1);
      assert.throws(() => protocol.appendVerdict({ ...allowedVerdict, method, actionClass }));
      assert.equal(database.prepare('SELECT count(*) AS n FROM action_verdicts').get().n, 0);
    } finally {
      database.close();
    }
  });

  test(`отклоняет allowed с ${method}/${actionClass} напрямую в SQL`, async () => {
    const { createActionProtocol } = await import('../../../core/adapters/store/action-protocol.ts');
    const database = new DatabaseSync(':memory:');
    try {
      createActionProtocol(database, () => 1);
      const insert = database.prepare(`INSERT INTO action_verdicts
        (at_ms, session_id, source_id, access_id, snapshot_number, node_number, method, action_class, actor, decision, reason)
        VALUES (1, 'session-1', 'source-1', 'access-1', 2, 3, ?, ?, 'agent', 'allowed', 'allowed')`);
      assert.throws(() => insert.run(method, actionClass));
      assert.equal(database.prepare('SELECT count(*) AS n FROM action_verdicts').get().n, 0);
    } finally {
      database.close();
    }
  });
}

test('отклоняет запись вердикта во внешней транзакции и работает после отката', async () => {
  const { createActionProtocol } = await import('../../../core/adapters/store/action-protocol.ts');
  const database = new DatabaseSync(':memory:');
  try {
    const protocol = createActionProtocol(database, () => 1);
    database.exec('BEGIN');
    let error: unknown;
    try {
      protocol.appendVerdict(allowedVerdict);
    } catch (caught) {
      error = caught;
    }
    database.exec('ROLLBACK');
    assert.equal(database.prepare('SELECT count(*) AS n FROM action_verdicts').get().n, 0);
    const id = protocol.appendVerdict(allowedVerdict);
    assert.equal(database.prepare('SELECT count(*) AS n FROM action_verdicts WHERE id = ?').get(id).n, 1);
    assert.ok(error instanceof Error, 'запись во внешней транзакции должна завершиться ошибкой');
  } finally {
    database.close();
  }
});

test('отклоняет запись итога во внешней транзакции и работает после отката', async () => {
  const { createActionProtocol } = await import('../../../core/adapters/store/action-protocol.ts');
  const database = new DatabaseSync(':memory:');
  try {
    const protocol = createActionProtocol(database, () => 1);
    const verdictId = protocol.appendVerdict(allowedVerdict);
    database.exec('BEGIN');
    let error: unknown;
    try {
      protocol.appendOutcome({ verdictId, status: 'ok' });
    } catch (caught) {
      error = caught;
    }
    database.exec('ROLLBACK');
    assert.equal(database.prepare('SELECT count(*) AS n FROM action_outcomes').get().n, 0);
    protocol.appendOutcome({ verdictId, status: 'ok' });
    assert.deepEqual({ ...database.prepare('SELECT verdict_id, status FROM action_outcomes').get() },
      { verdict_id: verdictId, status: 'ok' });
    assert.ok(error instanceof Error, 'запись во внешней транзакции должна завершиться ошибкой');
  } finally {
    database.close();
  }
});

for (const table of ['action_verdicts', 'action_outcomes'] as const) {
  test(`запрещает INSERT OR REPLACE существующей строки ${table}`, async () => {
    const { createActionProtocol } = await import('../../../core/adapters/store/action-protocol.ts');
    const database = new DatabaseSync(':memory:');
    try {
      const protocol = createActionProtocol(database, () => 1);
      const verdictId = protocol.appendVerdict(allowedVerdict);
      protocol.appendOutcome({ verdictId, status: 'ok' });
      const before = database.prepare(`SELECT * FROM ${table}`).all();
      if (table === 'action_verdicts') {
        assert.throws(() => database.prepare(`INSERT OR REPLACE INTO action_verdicts
          (id, at_ms, session_id, source_id, access_id, snapshot_number, node_number, method, action_class, actor, decision, reason)
          VALUES (?, 2, 'session-2', 'source-1', 'access-1', 2, 3, 'readText', 'read', 'agent', 'allowed', 'allowed')`).run(verdictId));
      } else {
        assert.throws(() => database.prepare(`INSERT OR REPLACE INTO action_outcomes
          (verdict_id, at_ms, status) VALUES (?, 2, 'stale')`).run(verdictId));
      }
      assert.deepEqual(database.prepare(`SELECT * FROM ${table}`).all(), before);
    } finally {
      database.close();
    }
  });
}

type BrowserEvent = {
  sessionId: string; sourceId: string; accessId: string; stepNumber: number;
  kind: 'main-frame-navigation' | 'non-get-request'; method: string; host: string; path: string;
};

const browserEvents: BrowserEvent[] = [
  { sessionId: 'session-1', sourceId: 'source-1', accessId: 'access-1', stepNumber: 1,
    kind: 'main-frame-navigation', method: 'GET', host: 'example.test', path: '/fixture' },
  { sessionId: 'session-1', sourceId: 'source-1', accessId: 'access-1', stepNumber: 2,
    kind: 'non-get-request', method: 'POST', host: 'example.test', path: '/fixture' },
];

test('при отказе записи вердикта итога навигации главного фрейма или не-GET отзывает сессию в том числе без команды агента', async (t: import('node:test').TestContext) => {
  const { createActionProtocol } = await import('../../../core/adapters/store/action-protocol.ts');
  const { createPreparationSession } = await import('../../../core/use-cases/preparation.ts');

  for (const failure of ['verdict', 'outcome', 'main-frame-navigation', 'non-get-request'] as const) {
    await t.test(failure, async () => {
      const database = new DatabaseSync(':memory:');
      try {
        const protocol = createActionProtocol(database, () => 1) as unknown as {
          appendVerdict(value: typeof allowedVerdict): number;
          appendOutcome(value: { verdictId: number; status: 'ok' }): void;
          appendBrowserEvent(value: BrowserEvent): void;
        };
        let verdictId = 0;
        let reads = 0;
        let closes = 0;
        let unavailable = 0;
        let writeError: unknown;
        const write = (operation: () => void) => {
          try {
            operation();
          } catch (error) {
            writeError = error;
            throw error;
          }
        };
        const ports = {
          openSource: async () => {},
          closeSource: async () => { closes++; },
          saveVerdict: async () => { write(() => { verdictId = protocol.appendVerdict(allowedVerdict); }); },
          read: async () => {
            reads++;
            if (failure === 'outcome') database.exec('PRAGMA query_only = ON');
            return 'fixture-result';
          },
          saveOutcome: async () => { write(() => protocol.appendOutcome({ verdictId, status: 'ok' })); },
          saveBrowserEvent: async (event: BrowserEvent) => { write(() => protocol.appendBrowserEvent(event)); },
          protocolUnavailable: async () => { unavailable++; },
        };
        const session = createPreparationSession(ports) as unknown as {
          open(sessionId?: string): Promise<void>; bindSnapshot(snapshot: string): void;
          readForVerdict(snapshot: string): Promise<string>;
          recordBrowserEvent(event: BrowserEvent): Promise<void>;
        };
        const event = browserEvents.find((value) => value.kind === failure);
        if (event) await session.open(event.sessionId);
        else await session.open();
        session.bindSnapshot('snapshot-1');
        if (failure !== 'outcome') database.exec('PRAGMA query_only = ON');
        if (failure === 'verdict' || failure === 'outcome') {
          await assert.rejects(session.readForVerdict('snapshot-1'), { message: 'protocol-unavailable' });
        } else {
          await assert.rejects(session.recordBrowserEvent(event!), { message: 'protocol-unavailable' });
        }
        assert.equal((writeError as { errcode?: number } | undefined)?.errcode, 8);
        assert.equal(closes, 1);
        assert.equal(reads, failure === 'outcome' ? 1 : 0);
        await assert.rejects(session.readForVerdict('snapshot-1'));
        assert.equal(reads, failure === 'outcome' ? 1 : 0);
        assert.equal(database.prepare('SELECT count(*) AS n FROM action_verdicts').get().n, failure === 'outcome' ? 1 : 0);
        assert.equal(database.prepare('SELECT count(*) AS n FROM action_outcomes').get().n, 0);
        assert.equal(unavailable, 1);
      } finally {
        database.close();
      }
    });
  }
});

test('отклоняет старое событие браузера после открытия новой сессии и сохраняет её работоспособность', async () => {
  const { createPreparationSession } = await import('../../../core/use-cases/preparation.ts');
  const stored: BrowserEvent[] = [];
  let closes = 0;
  const session = createPreparationSession({
    openSource: async () => {},
    closeSource: async () => { closes++; },
    saveVerdict: async () => {},
    read: async () => 'fixture-result',
    saveOutcome: async () => {},
    saveBrowserEvent: async (event: BrowserEvent) => {
      stored.push(event);
      if (event.sessionId === 'session-1') throw new Error('unexpected stale event');
    },
  }) as unknown as {
    open(sessionId?: string): Promise<void>; close(): Promise<void>;
    bindSnapshot(snapshot: string): void; readForVerdict(snapshot: string): Promise<string>;
    recordBrowserEvent(event: BrowserEvent): Promise<void>;
  };
  await session.open('session-1');
  await session.close();
  await session.open('session-2');
  await assert.rejects(session.recordBrowserEvent(browserEvents[0]));
  assert.deepEqual(stored, []);
  assert.equal(closes, 1);
  const freshEvent = { ...browserEvents[0], sessionId: 'session-2' };
  await session.recordBrowserEvent(freshEvent);
  assert.deepEqual(stored, [freshEvent]);
  session.bindSnapshot('fresh-snapshot');
  assert.equal(await session.readForVerdict('fresh-snapshot'), 'fixture-result');
  await session.close();
});

test('отклоняет событие браузера без привязки идентификатора сессии', async () => {
  const { createPreparationSession } = await import('../../../core/use-cases/preparation.ts');
  const stored: BrowserEvent[] = [];
  const session = createPreparationSession({
    openSource: async () => {}, closeSource: async () => {}, saveVerdict: async () => {},
    read: async () => 'fixture-result', saveOutcome: async () => {},
    saveBrowserEvent: async (event: BrowserEvent) => { stored.push(event); },
  });
  await session.open();
  await assert.rejects(session.recordBrowserEvent(browserEvents[0]));
  assert.deepEqual(stored, []);
  session.bindSnapshot('snapshot');
  assert.equal(await session.readForVerdict('snapshot'), 'fixture-result');
  await session.close();
});

test('дозаписывает событие браузера в таблицу STRICT', async () => {
  const { createActionProtocol } = await import('../../../core/adapters/store/action-protocol.ts');
  const database = new DatabaseSync(':memory:');
  try {
    const protocol = createActionProtocol(database, () => 1) as unknown as {
      appendBrowserEvent(value: BrowserEvent): void;
    };
    protocol.appendBrowserEvent(browserEvents[0]);
    const schema = database.prepare('PRAGMA table_list').all().find((entry: { name: string }) => entry.name === 'action_browser_events');
    assert.equal(schema.strict, 1);
    const row = database.prepare('SELECT session_id, source_id, access_id, step_number, kind, method, host, path FROM action_browser_events').get();
    assert.deepEqual({ ...row }, {
      session_id: 'session-1', source_id: 'source-1', access_id: 'access-1', step_number: 1,
      kind: 'main-frame-navigation', method: 'GET', host: 'example.test', path: '/fixture',
    });
    assert.throws(() => database.exec("UPDATE action_browser_events SET path = '/other'"));
    assert.throws(() => database.exec('DELETE FROM action_browser_events'));
  } finally {
    database.close();
  }
});
