const assert = require('node:assert/strict');
const test = require('node:test');

test('разрешает фиксированный запуск только после успешной проверки всех условий границы', async () => {
  const { startExecutor } = await import('../../../core/adapters/executor/start.ts');
  const path = '/synthetic/owned/ssh_config';
  const calls: unknown[][] = [];
  const ports = {
    permissions: async () => { calls.push(['permissions']); return true; },
    adminGroup: async () => { calls.push(['admin']); return true; },
    pfCanary: async () => { calls.push(['pf']); return 'refused'; },
    run: async (...args: unknown[]) => { calls.push(['run', ...args]); return 7; },
  };
  assert.deepEqual(await startExecutor(ports, { sshConfigPath: path }), { ok: true, exitCode: 7 });
  assert.deepEqual(calls, [ ['permissions'], ['admin'], ['pf'], ['run', '/usr/bin/ssh', ['-F', path, 'executor-core'], { stdio: 'ignore', env: {} }] ]);
  calls.length = 0;
  assert.deepEqual(await startExecutor({ ...ports, run: async (...args: unknown[]) => { calls.push(['run', ...args]); return null; } }, { sshConfigPath: path }), { ok: true, exitCode: null });

  for (const [key, code, prefix, badValues] of [
    ['permissions', 'boundary-permissions', ['permissions'], [false, undefined, 'true']],
    ['adminGroup', 'boundary-admin', ['permissions', 'admin'], [false, undefined, 'true']],
    ['pfCanary', 'boundary-pf', ['permissions', 'admin', 'pf'], ['timeout', 'unreachable', true, undefined, 'unknown']],
  ] as const) {
    for (const value of [...badValues, new Error('synthetic-private-error')]) {
      calls.length = 0;
      const overridden = { ...ports, [key]: async () => {
        calls.push([key === 'adminGroup' ? 'admin' : key === 'pfCanary' ? 'pf' : key]);
        if (value instanceof Error) throw value;
        return value;
      } };
      const result = await startExecutor(overridden, { sshConfigPath: path });
      assert.deepEqual(result, { ok: false, code });
      assert.deepEqual(calls.map((entry) => entry[0]), prefix);
      assert.doesNotMatch(JSON.stringify(result), /synthetic-private-error/);
    }
  }
  for (const badPath of ['', 'relative/config', '/synthetic/../other', '/synthetic/./config', '/synthetic/config\0extra', null, 42]) {
    calls.length = 0;
    const result = await startExecutor(ports, { sshConfigPath: badPath });
    assert.deepEqual(result, { ok: false, code: 'boundary-config' });
    assert.equal(calls.some((entry) => entry[0] === 'run'), false);
  }
  calls.length = 0;
  const failure = await startExecutor({ ...ports, run: async () => { throw new Error('synthetic-private-error'); } }, { sshConfigPath: path });
  assert.deepEqual(failure, { ok: false, code: 'executor-launch' });
  assert.doesNotMatch(JSON.stringify(failure), /synthetic-private-error/);
});
