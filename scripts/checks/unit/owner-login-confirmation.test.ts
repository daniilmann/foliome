const assert = require('node:assert/strict');
const test = require('node:test');

test('подтверждает возврат управления только из окна владельца и только один раз для активной сессии', async () => {
  const { createOwnerLoginConfirmation } = await import('../../../core/adapters/ui/owner-login-confirmation.ts');
  const { decidePngGate } = await import('../../../core/domain/png-gate.ts');
  const ownerFrame = {};
  const otherFrame = {};
  const origin = 'https://owner.example';
  const endpoint = '/owner/login/complete';
  const completed: string[] = [];
  const adapter = createOwnerLoginConfirmation({
    ownerFrame, origin, endpoint, complete: (sessionId: string) => completed.push(sessionId),
  });
  const request = {
    method: 'POST', path: endpoint, frame: ownerFrame, origin,
    body: { sessionId: 'session-1', nonce: 'nonce-1' },
  };
  const fact = { sessionId: 'session-1', source: 'trusted-adapter', confirmed: true };
  const gate = (completion: typeof fact | null) => decidePngGate({
    sessionId: 'session-1', sessionActive: true, loginStep: false,
    manualInputSeen: true, hasKnownSecret: false, hasNonEmptyFields: false,
    completion, stable: true, maskApplied: true, withinLimits: true,
  });

  assert.equal(adapter.handle(request), null);
  adapter.begin({ sessionId: 'session-1', nonce: 'nonce-1' });
  for (const invalid of [
    { ...request, frame: otherFrame },
    { ...request, origin: 'https://other.example' },
    { ...request, method: 'GET' },
    { ...request, path: `${endpoint}/` },
    { ...request, body: { ...request.body, sessionId: 'old-session' } },
    { ...request, body: { ...request.body, nonce: 'old-nonce' } },
    { ...request, body: { ...request.body, extra: true } },
  ]) assert.equal(adapter.handle(invalid), null);
  assert.deepEqual(completed, []);
  assert.deepEqual(gate(null), { ok: false, code: 'login-step' });
  const confirmation = adapter.handle(request);
  assert.deepEqual(confirmation, fact);
  assert.deepEqual(gate(confirmation), { ok: true });
  assert.equal(adapter.handle(request), null);
  assert.deepEqual(completed, ['session-1']);

  adapter.begin({ sessionId: 'session-2', nonce: 'nonce-2' });
  assert.equal(adapter.handle(request), null);
  adapter.close();
  const second = { ...request, body: { sessionId: 'session-2', nonce: 'nonce-2' } };
  assert.equal(adapter.handle(second), null);
  adapter.begin({ sessionId: 'session-2', nonce: 'nonce-3' });
  assert.equal(adapter.handle(second), null);
  assert.deepEqual(adapter.handle({ ...second, body: { ...second.body, nonce: 'nonce-3' } }), {
    sessionId: 'session-2', source: 'trusted-adapter', confirmed: true,
  });
  assert.deepEqual(completed, ['session-1', 'session-2']);
});
