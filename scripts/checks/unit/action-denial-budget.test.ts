const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

// Proposed private domain API: classifyProhibitedFacts(facts) returns
// { prohibited: 'blocked-payment' | 'blocked-change' | null, budget: 'hard' | 'label' | null }.
// Facts are retained primitive DOM observations, never filtered MCP output or command fields.
// Candidate.facts is optional so previously recorded candidates with prohibited remain valid.
// Proposed use-case ports: denialBudget.record(sessionId, class) => boolean (limit reached),
// and revokeSession(sessionId). The use case appends the denial and a compact limit verdict
// before revocation; neither the class nor these primitive facts enter the MCP response.
const domain =
  require('../../../core/domain/action-verdict.ts') as typeof import('../../../core/domain/action-verdict.ts') & {
    classifyProhibitedFacts(facts: unknown): {
      prohibited: string | null;
      budget: 'hard' | 'label' | null;
    };
  };
const { createControlledRead } = require('../../../core/use-cases/controlled-read.ts');
const { createActionProtocol } =
  require('../../../core/adapters/store/action-protocol.ts') as typeof import('../../../core/adapters/store/action-protocol.ts');
const blank = {
  label: '',
  inputKind: '',
  autocomplete: '',
  currentPath: '/overview',
  href: '',
  formAction: '',
  loginStep: false,
  confirmationForm: false,
  formFieldKinds: [] as string[],
};
const classify = (facts: Partial<typeof blank>) =>
  domain.classifyProhibitedFacts({ ...blank, ...facts });
const hard = (prohibited: string) => ({ prohibited, budget: 'hard' });
const label = (prohibited: string) => ({ prohibited, budget: 'label' });
const safe = { prohibited: null, budget: null };

test('классифицирует платёжные признаки из наблюдения и только известные пути', () => {
  for (const facts of [
    { inputKind: 'amount' },
    { inputKind: 'recipient' },
    { inputKind: 'transfer details' },
    { autocomplete: ' CC-NUMBER ' },
    { currentPath: '/PAYMENT?view=1' },
    { href: 'https://example.invalid/payment#part' },
    { formAction: '/payment?x=1' },
    { inputKind: 'password' },
    { autocomplete: 'one-time-code' },
    { autocomplete: 'one-time-code', loginStep: true, confirmationForm: true },
  ])
    assert.deepEqual(classify(facts), hard('blocked-payment'), JSON.stringify(facts));
  for (const facts of [
    { currentPath: '/payment-history' },
    { href: 'https://example.invalid/not-payment' },
    { formAction: '/unrelated' },
    { inputKind: 'password', loginStep: true },
    { autocomplete: 'one-time-code', loginStep: true },
  ])
    assert.deepEqual(classify(facts), safe, JSON.stringify(facts));
});

test('отличает безусловные основы от условных подписей и точных безопасных исключений', () => {
  for (const value of ['  DELETE  ', 'Settings', 'УДАЛИТЬ', 'Настройки'])
    assert.deepEqual(classify({ label: value }), label('blocked-change'), value);
  for (const value of ['save', 'change', 'apply', 'сохранить', 'изменить', 'применить']) {
    const result = classify({ label: value });
    assert.equal(result.budget, null, value);
    assert.notEqual(result.prohibited, null, value);
  }
  for (const value of ['Save as PDF', 'Change period', 'Сохранить как PDF', 'Изменить период']) {
    assert.deepEqual(classify({ label: value, formFieldKinds: ['date', 'choice'] }), safe, value);
    const unsafe = classify({ label: value, formFieldKinds: ['date', 'unknown'] });
    assert.notEqual(unsafe.prohibited, null, value);
    assert.equal(unsafe.budget, null, value);
    assert.notEqual(classify({ label: `${value} now`, formFieldKinds: ['date'] }).prohibited, null);
  }
  assert.deepEqual(classify({ label: 'Delete', inputKind: 'amount' }), hard('blocked-payment'));
});

test('старые записанные маркеры по-прежнему распознаются вердиктом', () => {
  const candidate = {
    nodeNumber: 1,
    sameNode: true,
    visible: true,
    enabled: true,
    sourceFrame: true,
    secretField: false,
    prohibited: 'blocked-change' as const,
  };
  assert.deepEqual(
    domain.decideActionVerdict(
      { method: 'readText', snapshotNumber: 1, nodeNumber: 1, actionClass: 'read' },
      { sessionActive: true, loginStep: false, snapshotNumber: 1, candidates: [candidate] },
    ),
    { ok: false, code: 'blocked-change' },
  );
});

function fixture() {
  const db = new DatabaseSync(':memory:');
  const protocol = createActionProtocol(db, () => 1);
  let session = {
    sessionId: 'session_a',
    sourceId: 'source_a',
    accessId: 'access_a',
    sessionActive: true,
    loginStep: false,
    snapshotNumber: 1,
  };
  const events: string[] = [];
  const counters = new Map<string, { hard: number; label: number }>();
  let facts: Partial<typeof blank> = {};
  const candidate = () => ({
    nodeNumber: 1,
    visible: true,
    enabled: true,
    sourceFrame: true,
    secretField: false,
    prohibited: null,
    identity: 'identity',
    descriptor: 'descriptor',
    text: 'ordinary text',
    facts: { ...blank, ...facts },
  });
  const observed = () => ({
    sessionId: session.sessionId,
    sourceId: session.sourceId,
    accessId: session.accessId,
    snapshotNumber: session.snapshotNumber,
    candidates: [candidate()],
  });
  const ports = {
    getSession: () => session,
    collectTarget: Object.assign(
      async () => {
        events.push('observe');
        return observed();
      },
      {
        read: async () => {
          events.push('read');
          return { ok: true, text: 'ordinary text' };
        },
      },
    ),
    captureSnapshot: async (n: number) => {
      events.push('snapshot');
      return {
        ok: true,
        snapshot: {
          snapshot: n,
          page: { host: 'example.invalid', path: '/overview', title: '' },
          truncated: false,
          frames: [],
          elements: [],
        },
        image: { code: 'login-step' },
      };
    },
    persistSnapshot: async (result: { snapshot: { snapshot: number } }) => {
      events.push('persist');
      session = { ...session, snapshotNumber: result.snapshot.snapshot };
    },
    onProtocolUnavailable: () => {
      events.push('protocol-unavailable');
      session = { ...session, sessionActive: false };
    },
    protocol: {
      appendVerdict: (v: Parameters<typeof protocol.appendVerdict>[0]) => {
        events.push(`verdict:${v.reason}`);
        return protocol.appendVerdict(v);
      },
      appendOutcome: (v: Parameters<typeof protocol.appendOutcome>[0]) => {
        events.push(`outcome:${v.status}`);
        return protocol.appendOutcome(v);
      },
    },
    denialBudget: {
      record: (id: string, kind: 'hard' | 'label') => {
        events.push(`budget:${kind}`);
        const count = counters.get(id) ?? { hard: 0, label: 0 };
        count[kind]++;
        counters.set(id, count);
        return count[kind] >= (kind === 'hard' ? 3 : 10);
      },
    },
    revokeSession: (id: string) => {
      assert.equal(id, session.sessionId);
      events.push('revoke');
      session = { ...session, sessionActive: false };
    },
  };
  const reader = createControlledRead(ports);
  const call = async (next: Partial<typeof blank>, extra: Record<string, unknown> = {}) => {
    facts = next;
    return reader.read(
      {
        method: 'readText',
        snapshotNumber: session.snapshotNumber,
        nodeNumber: 1,
        actionClass: 'read',
        ...extra,
      },
      observed(),
    );
  };
  return {
    db,
    protocol,
    events,
    counters,
    call,
    fresh: () => {
      session = { ...session, sessionId: 'session_b', sessionActive: true, snapshotNumber: 1 };
    },
  };
}

test('чтение использует факты ядра, сохраняет старый успешный путь и не выдаёт факты', async () => {
  const f = fixture();
  try {
    const ok = await f.call({ label: 'Change period', formFieldKinds: ['date', 'choice'] });
    assert.equal(ok.ok, true);
    assert.equal(ok.data.text, 'ordinary text');
    assert.ok(f.events.includes('read'));
    const denial = await f.call({ inputKind: 'amount' });
    assert.equal(denial.code, 'blocked-payment');
    assert.equal(JSON.stringify(denial).includes('amount'), false);
    assert.equal(JSON.stringify(denial).includes('hard'), false);
    const calls = f.events.filter((e: string) => e === 'read').length;
    const beforeUnsupported = f.events.length;
    const unsupported = await f.call({ inputKind: 'amount' }, { method: 'unknown' });
    assert.equal(f.events.slice(beforeUnsupported).includes('observe'), false);
    assert.equal(unsupported.code, 'unsupported');
    assert.equal(f.events.filter((e: string) => e === 'read').length, calls);
    assert.equal(f.counters.get('session_a')?.hard, 1);
  } finally {
    f.db.close();
  }
});

for (const closing of ['hard', 'label'] as const)
  test(`независимый лимит ${closing}, протокол и новая сессия`, async () => {
    const f = fixture();
    try {
      const send = async (kind: 'hard' | 'label') =>
        f.call(kind === 'hard' ? { inputKind: 'recipient' } : { label: 'Delete' });
      const other = closing === 'hard' ? 'label' : 'hard';
      const otherCount = closing === 'hard' ? 9 : 2;
      for (let i = 0; i < otherCount; i++) assert.equal((await send(other)).ok, false);
      const maximum = closing === 'hard' ? 3 : 10;
      for (let i = 1; i < maximum; i++) assert.equal((await send(closing)).ok, false);
      await f.call({ label: 'save' });
      await f.call({ label: 'unrecognised' }, { actionClass: 'unknown' });
      await f.call({ inputKind: 'amount' }, { method: 'unknown' });
      const before = f.events.length;
      const result = await send(closing);
      assert.equal(result.ok, false);
      const tail = f.events.slice(before);
      assert.ok(
        tail.indexOf(`verdict:${closing === 'hard' ? 'blocked-payment' : 'blocked-change'}`) >= 0,
      );
      assert.ok(
        tail.indexOf('verdict:limit') >
          tail.indexOf(`verdict:${closing === 'hard' ? 'blocked-payment' : 'blocked-change'}`),
      );
      assert.ok(tail.indexOf('revoke') > tail.indexOf('verdict:limit'));
      assert.equal(tail.includes('snapshot'), false);
      assert.equal(tail.includes('read'), false);
      const limitRow = f.protocol.list().at(-1);
      assert.equal(limitRow?.reason, 'limit');
      assert.equal(JSON.stringify(limitRow).includes(closing), false);
      assert.equal(JSON.stringify(limitRow).includes('recipient'), false);
      assert.equal(f.counters.get('session_a')?.[closing], maximum);
      assert.equal(f.counters.get('session_a')?.[other], otherCount);
      const closedAt = f.events.length;
      assert.equal((await send(closing)).code, 'session-unavailable');
      assert.equal(f.events.length, closedAt);
      f.fresh();
      assert.equal((await send(closing)).ok, false);
      assert.equal(f.counters.get('session_b')?.[closing], 1);
      assert.equal(f.events.slice(closedAt).includes('revoke'), false);
    } finally {
      f.db.close();
    }
  });
