const assert = require('node:assert/strict');
const test = require('node:test');

test('подавляет PNG при вводе и ошибочном сигнале разрешает после допустимого перехода и закрывает отказ при непрошедшей маске', async () => {
  const { decidePngGate } = await import('../../../core/domain/png-gate.ts');
  const base = {
    sessionId: 'current',
    sessionActive: true,
    loginStep: true,
    manualInputSeen: false,
    hasKnownSecret: false,
    hasNonEmptyFields: false,
    completion: null,
    stable: true,
    maskApplied: true,
    withinLimits: true,
  };
  const decide = (changes: object) => decidePngGate({ ...base, ...changes });
  const denied = (changes: object, code: string) =>
    assert.deepEqual(decide(changes), { ok: false, code });
  assert.deepEqual(decide({}), { ok: true });
  for (const fact of ['manualInputSeen', 'hasKnownSecret', 'hasNonEmptyFields']) {
    denied({ [fact]: true }, 'login-step');
  }
  const entered = { manualInputSeen: true };
  const signal = { sessionId: 'current', source: 'trusted-adapter', confirmed: true };
  denied({ ...entered, completion: signal }, 'login-step');
  const completed = { manualInputSeen: true, loginStep: false };
  assert.deepEqual(decide({ ...completed, completion: signal }), { ok: true });
  for (const completion of [
    { ...signal, sessionId: 'other' },
    { ...signal, confirmed: false },
    { ...signal, source: 'page' },
    { ...signal, source: 'agent' },
  ])
    denied({ ...completed, completion }, 'login-step');
  denied({ ...completed, completion: signal, sessionActive: false }, 'login-step');
  denied({ ...completed, completion: signal, maskApplied: false }, 'error');
  denied({ stable: false }, 'unstable');
  denied({ withinLimits: false }, 'limit');
});
