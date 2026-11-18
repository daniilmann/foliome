const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const test = require('node:test');

const loadMcp = async () =>
  (await import('../../../core/adapters/channel/preparation-mcp.ts')).createPreparationMcp;
const request = (id: number, method: string, params?: unknown) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params === undefined ? {} : { params }),
});
const call = (id: number, name: string, args: unknown = {}) =>
  request(id, 'tools/call', { name, arguments: args });
const init = request(1, 'initialize', {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'synthetic-client', version: '1' },
});
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };

function fixture() {
  const calls: unknown[][] = [];
  let ownerOpened = false;
  const task = {
    type: 'preparation' as const,
    sourceId: 'synthetic-source',
    instruction: 'synthetic task',
  };
  const snapshot = {
    snapshot: 1,
    page: { host: 'example.test', path: '/', title: 'synthetic' },
    truncated: false,
    frames: [],
    elements: [],
  };
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const ports: Parameters<Awaited<ReturnType<typeof loadMcp>>>[0] = {
    getTask: async (...args: unknown[]) => {
      calls.push(['getTask', ...args]);
      return ownerOpened ? { ok: true, task } : { ok: false, code: 'blocked' };
    },
    getSnapshot: async (...args: unknown[]) => {
      calls.push(['getSnapshot', ...args]);
      return { ok: true, snapshot, image: { bytes, snapshotNumber: 1 } };
    },
    readText: async (...args: unknown[]) => {
      calls.push(['readText', ...args]);
      return {
        ok: true,
        text: 'synthetic text',
        snapshot: { ...snapshot, snapshot: 2 },
        image: { bytes, snapshotNumber: 2 },
      };
    },
  };
  return {
    calls,
    ports,
    task,
    snapshot,
    bytes,
    open: () => {
      ownerOpened = true;
    },
  };
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function result(value: unknown) {
  return object(object(value).result);
}
function string(value: unknown): string {
  assert.ok(typeof value === 'string');
  return value;
}
function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
async function handshake(handler: (value: unknown) => Promise<unknown>) {
  const response = object(await handler(init));
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 1);
  const data = result(response);
  assert.equal(data.protocolVersion, '2025-11-25');
  assert.ok(object(data.capabilities).tools);
  assert.equal(typeof object(data.serverInfo).name, 'string');
  assert.equal(typeof object(data.serverInfo).version, 'string');
  assert.equal(await handler(initialized), undefined);
}
function resultContent(response: unknown) {
  assert.equal(object(response).jsonrpc, '2.0');
  return array(result(response).content).map(object);
}
function isError(value: unknown) {
  const response = object(value);
  return response.error || (response.result && object(response.result).isError);
}

test('согласует MCP и объявляет только ограниченные инструменты', async () => {
  const create = await loadMcp();
  const f = fixture();
  const handler = create(f.ports);
  await handshake(handler);
  const pong = await handler(request(2, 'ping'));
  assert.deepEqual(pong, { jsonrpc: '2.0', id: 2, result: {} });
  const list = array(result(await handler(request(3, 'tools/list'))).tools).map(object);
  assert.deepEqual(list.map((tool) => tool.name).sort(), ['current_task', 'readText', 'snapshot']);
  for (const tool of list) {
    const schema = object(tool.inputSchema);
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.ok(schema.properties);
  }
  const schemas = Object.fromEntries(
    list.map((tool) => [string(tool.name), object(tool.inputSchema)]),
  );
  assert.deepEqual(Object.keys(object(schemas.current_task.properties)), []);
  assert.deepEqual(Object.keys(object(schemas.snapshot.properties)), []);
  const readSchema = schemas.readText;
  const properties = object(readSchema.properties);
  assert.deepEqual(Object.keys(properties).sort(), ['nodeNumber', 'options', 'snapshotNumber']);
  assert.deepEqual([...array(readSchema.required)].sort(), ['nodeNumber', 'snapshotNumber']);
  for (const key of ['snapshotNumber', 'nodeNumber']) {
    const property = object(properties[key]);
    assert.equal(property.type, 'integer');
    assert.ok(Number.isSafeInteger(property.minimum));
    assert.ok(Number.isSafeInteger(property.maximum));
  }
  const options = object(properties.options);
  assert.equal(options.additionalProperties, false);
  assert.deepEqual(Object.keys(object(options.properties)), ['deep']);
  assert.equal(object(object(options.properties).deep).type, 'boolean');
  assert.deepEqual(f.calls, []);
});

test('не вызывает сценарии до рукопожатия и при неверных или неизвестных командах', async () => {
  const create = await loadMcp();
  const f = fixture();
  const handler = create(f.ports);
  for (const message of [
    call(2, 'current_task'),
    call(3, 'snapshot'),
    call(4, 'readText', { snapshotNumber: 1, nodeNumber: 1 }),
  ]) {
    const reply = await handler(message);
    assert.ok(isError(reply));
  }
  assert.deepEqual(f.calls, []);
  await handshake(handler);
  const invalid = [
    call(10, 'current_task', { extra: true }),
    call(11, 'snapshot', { extra: true }),
    call(12, 'readText', {}),
    call(13, 'readText', null),
    call(14, 'readText', { snapshotNumber: 0, nodeNumber: 1 }),
    call(15, 'readText', { snapshotNumber: 1, nodeNumber: -1 }),
    call(16, 'readText', { snapshotNumber: 1.5, nodeNumber: 1 }),
    call(17, 'readText', { snapshotNumber: Number.MAX_SAFE_INTEGER + 1, nodeNumber: 1 }),
    call(18, 'readText', { snapshotNumber: '1', nodeNumber: 1 }),
    call(19, 'readText', { snapshotNumber: 1, nodeNumber: 1, options: { deep: 'true' } }),
    call(20, 'readText', { snapshotNumber: 1, nodeNumber: 1, options: { deep: true, extra: 1 } }),
    call(21, 'readText', { snapshotNumber: 1, nodeNumber: 1, method: 'domClick' }),
    call(22, 'constructor'),
    call(23, '__proto__'),
    call(24, 'domClick'),
    request(25, 'tools/call', { name: 'current_task', arguments: {}, extra: 1 }),
    request(26, 'unsupported', { name: 'snapshot' }),
  ];
  for (const message of invalid) {
    const reply = await handler(message);
    assert.ok(isError(reply), JSON.stringify(message));
  }
  assert.deepEqual(f.calls, []);
});

test('передаёт только доверенные аргументы и возвращает защищённые текст и PNG', async () => {
  const create = await loadMcp();
  const f = fixture();
  const handler = create(f.ports);
  await handshake(handler);
  const blocked = await handler(call(2, 'current_task'));
  assert.match(JSON.stringify(blocked), /blocked/);
  assert.deepEqual(f.calls, [['getTask']]);
  f.open();
  const task = resultContent(await handler(call(3, 'current_task')));
  assert.deepEqual(JSON.parse(string(task.find((entry) => entry.type === 'text')?.text)), f.task);
  const contents = resultContent(await handler(call(4, 'snapshot')));
  assert.ok(contents.every((entry) => entry.type === 'text' || entry.type === 'image'));
  const text = contents.find((entry) => entry.type === 'text');
  assert.deepEqual(JSON.parse(string(text?.text)), f.snapshot);
  const image = contents.find((entry) => entry.type === 'image');
  assert.deepEqual(image, {
    type: 'image',
    mimeType: 'image/png',
    data: f.bytes.toString('base64'),
  });
  assert.doesNotMatch(JSON.stringify(contents), /"bytes"|snapshotNumber|"type":"Buffer"/);
  const args = { snapshotNumber: 1, nodeNumber: 2, options: { deep: true } };
  const read = resultContent(await handler(call(5, 'readText', args)));
  assert.match(JSON.stringify(read), /synthetic text/);
  await handler(call(6, 'readText', { snapshotNumber: 1, nodeNumber: 2 }));
  assert.deepEqual(f.calls, [
    ['getTask'],
    ['getTask'],
    ['getSnapshot'],
    ['readText', args],
    ['readText', { snapshotNumber: 1, nodeNumber: 2 }],
  ]);
});

test('скрывает ошибки портов и изолирует состояние соединений', async () => {
  const create = await loadMcp();
  const f = fixture();
  const first = create(f.ports);
  const second = create(f.ports);
  await handshake(first);
  const denied = await second(call(2, 'snapshot'));
  assert.ok(isError(denied));
  assert.deepEqual(f.calls, []);
  await handshake(second);
  await second(call(3, 'snapshot'));
  assert.deepEqual(f.calls, [['getSnapshot']]);
  for (const name of ['getTask', 'getSnapshot', 'readText']) {
    const ports: Parameters<Awaited<ReturnType<typeof loadMcp>>>[0] = {
      ...f.ports,
      [name]: async () => {
        throw new Error('synthetic-private-error');
      },
    };
    const handler = create(ports);
    await handshake(handler);
    const method =
      name === 'getTask' ? 'current_task' : name === 'getSnapshot' ? 'snapshot' : 'readText';
    const args = name === 'readText' ? { snapshotNumber: 1, nodeNumber: 1 } : {};
    const response = await handler(call(4, method, args));
    assert.ok(isError(response));
    assert.doesNotMatch(JSON.stringify(response), /synthetic-private-error|stack/);
    const error = object(response).error;
    if (error) {
      assert.deepEqual(Object.keys(object(error)).sort(), ['code', 'message']);
      assert.equal(typeof object(error).code, 'number');
    }
  }
});

test('ping доступен до завершения рукопожатия', async () => {
  const create = await loadMcp();
  const f = fixture();
  const handler = create(f.ports);
  assert.deepEqual(await handler(request(2, 'ping')), { jsonrpc: '2.0', id: 2, result: {} });
  assert.equal(result(await handler(init)).protocolVersion, '2025-11-25');
  assert.deepEqual(await handler(request(3, 'ping')), { jsonrpc: '2.0', id: 3, result: {} });
  assert.deepEqual(f.calls, []);
});

test('согласует поддерживаемую версию с клиентом старого протокола', async () => {
  const create = await loadMcp();
  const f = fixture();
  const handler = create(f.ports);
  const response = await handler(
    request(1, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'synthetic-client', version: '1' },
    }),
  );
  assert.equal(result(response).protocolVersion, '2025-11-25');
  assert.equal(await handler(initialized), undefined);
  assert.deepEqual(result(await handler(request(2, 'ping'))), {});
  assert.deepEqual(f.calls, []);
});

test('readText возвращает текст, следующий снимок и соответствующий PNG', async () => {
  const create = await loadMcp();
  const f = fixture();
  const successor = { ...f.snapshot, snapshot: 2 };
  const ports: Parameters<Awaited<ReturnType<typeof loadMcp>>>[0] = {
    ...f.ports,
    readText: async () => ({
      ok: true as const,
      text: 'synthetic text',
      snapshot: successor,
      image: { bytes: f.bytes, snapshotNumber: 2 },
    }),
  };
  const handler = create(ports);
  await handshake(handler);
  const content = resultContent(
    await handler(call(2, 'readText', { snapshotNumber: 1, nodeNumber: 2 })),
  );
  assert.equal(content.length, 3);
  assert.deepEqual(content[0], { type: 'text', text: 'synthetic text' });
  assert.equal(content[1].type, 'text');
  assert.deepEqual(JSON.parse(string(content[1].text)), successor);
  assert.deepEqual(content[2], {
    type: 'image',
    mimeType: 'image/png',
    data: f.bytes.toString('base64'),
  });
});

test('readText и snapshot сообщают причину отсутствия PNG без изображения', async (t: import('node:test').TestContext) => {
  const create = await loadMcp();
  for (const method of ['snapshot', 'readText']) {
    for (const code of ['login-step', 'unstable', 'limit', 'error'] as const) {
      await t.test(`${method}: ${code}`, async () => {
        const f = fixture();
        const successor = { ...f.snapshot, snapshot: 2 };
        const result = { ok: true as const, snapshot: successor, image: { code } };
        const ports: Parameters<Awaited<ReturnType<typeof loadMcp>>>[0] = {
          ...f.ports,
          getSnapshot: async () => result,
          readText: async () => ({ ...result, text: 'synthetic text' }),
        };
        const handler = create(ports);
        await handshake(handler);
        const args = method === 'readText' ? { snapshotNumber: 1, nodeNumber: 2 } : {};
        const content = resultContent(await handler(call(2, method, args)));
        const offset = method === 'readText' ? 1 : 0;
        assert.equal(content.length, offset + 2);
        if (offset) assert.deepEqual(content[0], { type: 'text', text: 'synthetic text' });
        assert.equal(content[offset].type, 'text');
        assert.deepEqual(JSON.parse(string(content[offset].text)), successor);
        assert.deepEqual(content[offset + 1], { type: 'text', text: code });
      });
    }
  }
});

test('причины отказа readText передаются фиксированными кодами', async (t: import('node:test').TestContext) => {
  const create = await loadMcp();
  for (const [code, expected] of [
    ['hidden', 'hidden'],
    ['disabled', 'disabled'],
    ['foreign-frame', 'foreign-frame'],
    ['stale', 'stale'],
    ['synthetic-unknown', 'internal'],
  ] as const) {
    await t.test(code, async () => {
      const f = fixture();
      const handler =
        code === 'synthetic-unknown'
          ? create({
              ...f.ports,
              readText: async () => ({ ok: false, code }),
            } as unknown as Parameters<typeof create>[0])
          : create({ ...f.ports, readText: async () => ({ ok: false, code }) });
      await handshake(handler);
      const response = await handler(call(2, 'readText', { snapshotNumber: 1, nodeNumber: 2 }));
      assert.equal(result(response).isError, true);
      assert.deepEqual(resultContent(response), [{ type: 'text', text: expected }]);
    });
  }
});
