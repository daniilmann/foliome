const assert = require('node:assert/strict');
const test = require('node:test');

const loadMcp = async () => (await import('../../../core/adapters/channel/preparation-mcp.ts')).createPreparationMcp;
const request = (id: number, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const call = (id: number, name: string, args: unknown = {}) => request(id, 'tools/call', { name, arguments: args });
const init = request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic-client', version: '1' } });
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };

function fixture() {
  const calls: unknown[][] = [];
  let ownerOpened = false;
  const task = { type: 'preparation', sourceId: 'synthetic-source', instruction: 'synthetic task' };
  const snapshot = { snapshot: 1, page: { host: 'example.test', path: '/', title: 'synthetic' }, truncated: false, frames: [], elements: [] };
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const ports = {
    getTask: async (...args: unknown[]) => { calls.push(['getTask', ...args]); return ownerOpened ? { ok: true, task } : { ok: false, code: 'blocked' }; },
    getSnapshot: async (...args: unknown[]) => { calls.push(['getSnapshot', ...args]); return { ok: true, snapshot, image: { bytes, snapshotNumber: 1 } }; },
    readText: async (...args: unknown[]) => { calls.push(['readText', ...args]); return { ok: true, text: 'synthetic text', snapshot: { ...snapshot, snapshot: 2 }, image: { bytes, snapshotNumber: 2 } }; },
  };
  return { calls, ports, task, snapshot, bytes, open: () => { ownerOpened = true; } };
}

async function handshake(handler: (value: unknown) => Promise<any>) {
  const response = await handler(init);
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, '2025-11-25');
  assert.ok(response.result.capabilities.tools);
  assert.equal(typeof response.result.serverInfo.name, 'string');
  assert.equal(typeof response.result.serverInfo.version, 'string');
  assert.equal(await handler(initialized), undefined);
}

function resultContent(response: any) {
  assert.equal(response.jsonrpc, '2.0');
  assert.ok(Array.isArray(response.result.content));
  return response.result.content;
}

test('согласует MCP и объявляет только ограниченные инструменты', async () => {
  const create = await loadMcp();
  const f = fixture();
  const handler = create(f.ports);
  await handshake(handler);
  const pong = await handler(request(2, 'ping'));
  assert.deepEqual(pong, { jsonrpc: '2.0', id: 2, result: {} });
  const list = await handler(request(3, 'tools/list'));
  assert.deepEqual(list.result.tools.map((tool: any) => tool.name).sort(), ['current_task', 'readText', 'snapshot']);
  for (const tool of list.result.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.inputSchema.properties);
  }
  const schemas = Object.fromEntries(list.result.tools.map((tool: any) => [tool.name, tool.inputSchema])) as Record<string, any>;
  assert.deepEqual(Object.keys(schemas.current_task.properties), []);
  assert.deepEqual(Object.keys(schemas.snapshot.properties), []);
  assert.deepEqual(Object.keys(schemas.readText.properties).sort(), ['nodeNumber', 'options', 'snapshotNumber']);
  assert.deepEqual([...schemas.readText.required].sort(), ['nodeNumber', 'snapshotNumber']);
  for (const key of ['snapshotNumber', 'nodeNumber']) {
    assert.equal(schemas.readText.properties[key].type, 'integer');
    assert.ok(Number.isSafeInteger(schemas.readText.properties[key].minimum));
    assert.ok(Number.isSafeInteger(schemas.readText.properties[key].maximum));
  }
  assert.equal(schemas.readText.properties.options.additionalProperties, false);
  assert.deepEqual(Object.keys(schemas.readText.properties.options.properties), ['deep']);
  assert.equal(schemas.readText.properties.options.properties.deep.type, 'boolean');
  assert.deepEqual(f.calls, []);
});

test('не вызывает сценарии до рукопожатия и при неверных или неизвестных командах', async () => {
  const create = await loadMcp();
  const f = fixture();
  const handler = create(f.ports);
  for (const message of [call(2, 'current_task'), call(3, 'snapshot'), call(4, 'readText', { snapshotNumber: 1, nodeNumber: 1 })]) {
    const reply = await handler(message);
    assert.ok(reply.error || reply.result?.isError);
  }
  assert.deepEqual(f.calls, []);
  await handshake(handler);
  const invalid = [
    call(10, 'current_task', { extra: true }), call(11, 'snapshot', { extra: true }),
    call(12, 'readText', {}), call(13, 'readText', null),
    call(14, 'readText', { snapshotNumber: 0, nodeNumber: 1 }),
    call(15, 'readText', { snapshotNumber: 1, nodeNumber: -1 }),
    call(16, 'readText', { snapshotNumber: 1.5, nodeNumber: 1 }),
    call(17, 'readText', { snapshotNumber: Number.MAX_SAFE_INTEGER + 1, nodeNumber: 1 }),
    call(18, 'readText', { snapshotNumber: '1', nodeNumber: 1 }),
    call(19, 'readText', { snapshotNumber: 1, nodeNumber: 1, options: { deep: 'true' } }),
    call(20, 'readText', { snapshotNumber: 1, nodeNumber: 1, options: { deep: true, extra: 1 } }),
    call(21, 'readText', { snapshotNumber: 1, nodeNumber: 1, method: 'domClick' }),
    call(22, 'constructor'), call(23, '__proto__'), call(24, 'domClick'),
    request(25, 'tools/call', { name: 'current_task', arguments: {}, extra: 1 }),
    request(26, 'unsupported', { name: 'snapshot' }),
  ];
  for (const message of invalid) {
    const reply = await handler(message);
    assert.ok(reply.error || reply.result?.isError, JSON.stringify(message));
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
  assert.deepEqual(JSON.parse(task.find((entry: any) => entry.type === 'text').text), f.task);
  const contents = resultContent(await handler(call(4, 'snapshot')));
  assert.ok(contents.every((entry: any) => entry.type === 'text' || entry.type === 'image'));
  const text = contents.find((entry: any) => entry.type === 'text');
  assert.deepEqual(JSON.parse(text.text), f.snapshot);
  const image = contents.find((entry: any) => entry.type === 'image');
  assert.deepEqual(image, { type: 'image', mimeType: 'image/png', data: f.bytes.toString('base64') });
  assert.doesNotMatch(JSON.stringify(contents), /"bytes"|snapshotNumber|"type":"Buffer"/);
  const args = { snapshotNumber: 1, nodeNumber: 2, options: { deep: true } };
  const read = resultContent(await handler(call(5, 'readText', args)));
  assert.match(JSON.stringify(read), /synthetic text/);
  await handler(call(6, 'readText', { snapshotNumber: 1, nodeNumber: 2 }));
  assert.deepEqual(f.calls, [['getTask'], ['getTask'], ['getSnapshot'], ['readText', args], ['readText', { snapshotNumber: 1, nodeNumber: 2 }]]);
});

test('скрывает ошибки портов и изолирует состояние соединений', async () => {
  const create = await loadMcp();
  const f = fixture();
  const first = create(f.ports);
  const second = create(f.ports);
  await handshake(first);
  const denied = await second(call(2, 'snapshot'));
  assert.ok(denied.error || denied.result?.isError);
  assert.deepEqual(f.calls, []);
  await handshake(second);
  await second(call(3, 'snapshot'));
  assert.deepEqual(f.calls, [['getSnapshot']]);
  for (const name of ['getTask', 'getSnapshot', 'readText']) {
    const ports = { ...f.ports, [name]: async () => { throw new Error('synthetic-private-error'); } };
    const handler = create(ports);
    await handshake(handler);
    const method = name === 'getTask' ? 'current_task' : name === 'getSnapshot' ? 'snapshot' : 'readText';
    const args = name === 'readText' ? { snapshotNumber: 1, nodeNumber: 1 } : {};
    const response = await handler(call(4, method, args));
    assert.ok(response.error || response.result?.isError);
    assert.doesNotMatch(JSON.stringify(response), /synthetic-private-error|stack/);
    if (response.error) {
      assert.deepEqual(Object.keys(response.error).sort(), ['code', 'message']);
      assert.equal(typeof response.error.code, 'number');
    }
  }
});

test('ping доступен до завершения рукопожатия', async () => {
  const create = await loadMcp();
  const f = fixture();
  const handler = create(f.ports);
  assert.deepEqual(await handler(request(2, 'ping')), { jsonrpc: '2.0', id: 2, result: {} });
  assert.equal((await handler(init)).result.protocolVersion, '2025-11-25');
  assert.deepEqual(await handler(request(3, 'ping')), { jsonrpc: '2.0', id: 3, result: {} });
  assert.deepEqual(f.calls, []);
});

test('согласует поддерживаемую версию с клиентом старого протокола', async () => {
  const create = await loadMcp();
  const f = fixture();
  const handler = create(f.ports);
  const response = await handler(request(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'synthetic-client', version: '1' } }));
  assert.equal(response.result.protocolVersion, '2025-11-25');
  assert.equal(await handler(initialized), undefined);
  assert.deepEqual((await handler(request(2, 'ping'))).result, {});
  assert.deepEqual(f.calls, []);
});

test('readText возвращает текст, следующий снимок и соответствующий PNG', async () => {
  const create = await loadMcp();
  const f = fixture();
  const successor = { ...f.snapshot, snapshot: 2 };
  const ports = { ...f.ports, readText: async () => ({ ok: true, text: 'synthetic text', snapshot: successor, image: { bytes: f.bytes, snapshotNumber: 2 } }) };
  const handler = create(ports);
  await handshake(handler);
  const content = resultContent(await handler(call(2, 'readText', { snapshotNumber: 1, nodeNumber: 2 })));
  assert.equal(content.length, 3);
  assert.deepEqual(content[0], { type: 'text', text: 'synthetic text' });
  assert.equal(content[1].type, 'text');
  assert.deepEqual(JSON.parse(content[1].text), successor);
  assert.deepEqual(content[2], { type: 'image', mimeType: 'image/png', data: f.bytes.toString('base64') });
});

test('readText и snapshot сообщают причину отсутствия PNG без изображения', async (t: any) => {
  const create = await loadMcp();
  for (const method of ['snapshot', 'readText']) {
    for (const code of ['login-step', 'unstable', 'limit', 'error']) {
      await t.test(`${method}: ${code}`, async () => {
        const f = fixture();
        const successor = { ...f.snapshot, snapshot: 2 };
        const result = { ok: true, snapshot: successor, image: { code } };
        const ports = { ...f.ports, getSnapshot: async () => result, readText: async () => ({ ...result, text: 'synthetic text' }) };
        const handler = create(ports);
        await handshake(handler);
        const args = method === 'readText' ? { snapshotNumber: 1, nodeNumber: 2 } : {};
        const content = resultContent(await handler(call(2, method, args)));
        const offset = method === 'readText' ? 1 : 0;
        assert.equal(content.length, offset + 2);
        if (offset) assert.deepEqual(content[0], { type: 'text', text: 'synthetic text' });
        assert.equal(content[offset].type, 'text');
        assert.deepEqual(JSON.parse(content[offset].text), successor);
        assert.deepEqual(content[offset + 1], { type: 'text', text: code });
      });
    }
  }
});

test('причины отказа readText передаются фиксированными кодами', async (t: any) => {
  const create = await loadMcp();
  for (const [code, expected] of [['hidden', 'hidden'], ['disabled', 'disabled'], ['foreign-frame', 'foreign-frame'], ['stale', 'stale'], ['synthetic-unknown', 'internal']]) {
    await t.test(code, async () => {
      const f = fixture();
      const handler = create({ ...f.ports, readText: async () => ({ ok: false, code }) });
      await handshake(handler);
      const response = await handler(call(2, 'readText', { snapshotNumber: 1, nodeNumber: 2 }));
      assert.equal(response.result.isError, true);
      assert.deepEqual(resultContent(response), [{ type: 'text', text: expected }]);
    });
  }
});
