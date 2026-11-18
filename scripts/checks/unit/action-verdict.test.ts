const assert = require('node:assert/strict');
const test = require('node:test');

test('разрешает только чтение допустимого узла актуального снимка и возвращает коды остальных решений', async () => {
  const { decideActionVerdict } = await import('../../../core/domain/action-verdict.ts');
  const command = { method: 'readText', snapshotNumber: 4, nodeNumber: 2, actionClass: 'read' };
  const candidate = {
    nodeNumber: 2,
    sameNode: true,
    visible: true,
    enabled: true,
    sourceFrame: true,
    secretField: false,
    prohibited: null,
  };
  const context = {
    sessionActive: true,
    loginStep: false,
    snapshotNumber: 4,
    candidates: [candidate],
  };
  const allowed = { ok: true, snapshotNumber: 4, nodeNumber: 2, deep: false };
  const denied = (input: unknown, facts: typeof context, code: string) =>
    assert.deepEqual(decideActionVerdict(input, facts), { ok: false, code });

  assert.deepEqual(decideActionVerdict(command, context), allowed);
  assert.deepEqual(decideActionVerdict({ ...command, options: { deep: false } }, context), allowed);
  assert.deepEqual(decideActionVerdict({ ...command, options: { deep: true } }, context), {
    ...allowed,
    deep: true,
  });
  // ADR-002 п. 5 разрешает чтение на шаге входа.
  assert.deepEqual(decideActionVerdict(command, { ...context, loginStep: true }), allowed);

  for (const input of [
    null,
    undefined,
    '',
    [],
    1,
    { ...command, method: 'click' },
    { ...command, options: null },
    { ...command, options: { deep: 'true' } },
    { ...command, options: { deep: true, extra: true } },
    { ...command, options: { Deep: true } },
    { ...command, sessionActive: true },
    { ...command, candidates: [candidate] },
    { ...command, snapshotNumber: '4' },
    { ...command, snapshotNumber: null },
    { ...command, nodeNumber: '2' },
    { ...command, nodeNumber: null },
  ])
    denied(input, context, 'unsupported');
  denied({ ...command, actionClass: 'change' }, context, 'unclassified');
  denied(command, { ...context, sessionActive: false }, 'session-unavailable');
  denied({ ...command, snapshotNumber: 3 }, context, 'stale');
  denied(command, { ...context, candidates: [] }, 'not-found');
  denied(command, { ...context, candidates: [{ ...candidate, nodeNumber: 3 }] }, 'not-found');
  denied(command, { ...context, candidates: [candidate, { ...candidate }] }, 'ambiguous');
  assert.deepEqual(
    decideActionVerdict(command, {
      ...context,
      candidates: [{ ...candidate, nodeNumber: 3 }, candidate],
    }),
    allowed,
  );

  for (const [change, code] of [
    [{ sameNode: false }, 'stale'],
    [{ sourceFrame: false }, 'foreign-frame'],
    [{ visible: false }, 'hidden'],
    [{ enabled: false }, 'disabled'],
    [{ secretField: true }, 'secret-field'],
    [{ prohibited: 'blocked-payment' }, 'blocked-payment'],
    [{ prohibited: 'blocked-change' }, 'blocked-change'],
  ] as const) {
    denied(
      command,
      { ...context, candidates: [{ ...candidate, ...change }] } as typeof context,
      code,
    );
  }
});
