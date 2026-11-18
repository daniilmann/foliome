const assert = require('node:assert/strict');
const test = require('node:test');

test('отзывает право ожидающего вызова включая ожидание записи итога проверяет идентичность сессии перед выдачей и отвязывает снимок завершённой сессии', async () => {
  const { createPreparationSession } = await import('../../../core/use-cases/preparation.ts');

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }

  function fixture() {
    const verdict = deferred<void>();
    const outcome = deferred<void>();
    const verdictStarted = deferred<void>();
    const outcomeStarted = deferred<void>();
    const calls: string[] = [];
    let sourceOpen = false;
    const session = createPreparationSession({
      openSource: async () => { sourceOpen = true; calls.push('open'); },
      closeSource: async () => { sourceOpen = false; calls.push('close'); },
      saveVerdict: async () => {
        calls.push('verdict');
        verdictStarted.resolve();
        await verdict.promise;
      },
      read: async () => {
        assert.equal(sourceOpen, true);
        calls.push('read');
        return 'synthetic result';
      },
      saveOutcome: async (value: string) => {
        assert.equal(value, 'synthetic result');
        calls.push('outcome');
        outcomeStarted.resolve();
        await outcome.promise;
      },
    });
    return { session, calls, verdict, outcome, verdictStarted, outcomeStarted,
      isSourceOpen: () => sourceOpen };
  }

  {
    const f = fixture();
    await f.session.open();
    f.session.bindSnapshot('snapshot');
    const pending = f.session.readForVerdict('snapshot');
    await f.verdictStarted.promise;
    await f.session.close();
    assert.equal(f.isSourceOpen(), false);
    f.verdict.resolve();
    await assert.rejects(pending);
    assert.deepEqual(f.calls, ['open', 'verdict', 'close']);
  }

  {
    const f = fixture();
    await f.session.open();
    f.session.bindSnapshot('snapshot');
    const pending = f.session.readForVerdict('snapshot');
    f.verdict.resolve();
    await f.outcomeStarted.promise;
    await f.session.close();
    await f.session.open();
    f.outcome.resolve();
    await assert.rejects(pending);
    assert.deepEqual(f.calls, ['open', 'verdict', 'read', 'outcome', 'close', 'open']);
  }

  {
    const f = fixture();
    await f.session.open();
    f.verdict.resolve();
    f.outcome.resolve();
    await assert.rejects(f.session.readForVerdict(undefined as unknown as string));
    assert.deepEqual(f.calls, ['open']);
  }

  {
    const f = fixture();
    await f.session.open();
    f.session.bindSnapshot('old snapshot');
    await f.session.close();
    await f.session.open();
    await assert.rejects(f.session.readForVerdict('old snapshot'));
    assert.deepEqual(f.calls, ['open', 'close', 'open']);
  }

  {
    const f = fixture();
    await f.session.open();
    f.session.bindSnapshot('snapshot');
    const pending = f.session.readForVerdict('snapshot');
    await f.verdictStarted.promise;
    await assert.rejects(f.session.readForVerdict('snapshot'));
    assert.deepEqual(f.calls, ['open', 'verdict']);
    f.verdict.resolve();
    await f.outcomeStarted.promise;
    assert.deepEqual(f.calls, ['open', 'verdict', 'read', 'outcome']);
    f.outcome.resolve();
    assert.equal(await pending, 'synthetic result');
    f.session.bindSnapshot('fresh snapshot');
    assert.equal(await f.session.readForVerdict('fresh snapshot'), 'synthetic result');
    assert.deepEqual(f.calls, ['open', 'verdict', 'read', 'outcome', 'verdict', 'read', 'outcome']);
  }
});

test('сохраняет итог начатого чтения после закрытия и не отзывает новую сессию', async () => {
  const { createPreparationSession } = await import('../../../core/use-cases/preparation.ts');
  let finishRead!: (value: string) => void;
  let signalReadStarted!: () => void;
  const readResult = new Promise<string>((resolve) => { finishRead = resolve; });
  const readStarted = new Promise<void>((resolve) => { signalReadStarted = resolve; });
  const outcomes: string[] = [];
  const session = createPreparationSession({
    openSource: async () => {}, closeSource: async () => {}, saveVerdict: async () => {},
    read: async () => { signalReadStarted(); return readResult; },
    saveOutcome: async (value: string) => { outcomes.push(value); },
  });
  await session.open();
  session.bindSnapshot('old-snapshot');
  const pending = session.readForVerdict('old-snapshot');
  await readStarted;
  await session.close();
  await session.open();
  session.bindSnapshot('fresh-snapshot');
  finishRead('old-result');
  await assert.rejects(pending, { message: 'session-revoked' });
  assert.deepEqual(outcomes, ['old-result']);
  assert.equal(await session.readForVerdict('fresh-snapshot'), 'old-result');
  assert.deepEqual(outcomes, ['old-result', 'old-result']);
  await session.close();
});
