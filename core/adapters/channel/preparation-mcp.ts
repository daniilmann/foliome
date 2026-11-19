type RequestId = string | number;
type ReadArgs = { snapshotNumber: number; nodeNumber: number; options?: { deep?: boolean } };
const failureCodes = [
  'blocked',
  'internal',
  'protocol-unavailable',
  'session-revoked',
  'session-unavailable',
  'stale',
  'unsupported',
  'blocked-payment',
  'blocked-change',
  'unclassified',
  'secret-field',
  'not-declared',
  'limit',
  'hidden',
  'disabled',
  'foreign-frame',
  'ambiguous',
  'not-found',
] as const;
type Failure = { ok: false; code: (typeof failureCodes)[number] };
type Snapshot = {
  snapshot: number;
  page: { host: string; path: string; title: string };
  truncated: boolean;
  frames: readonly unknown[];
  elements: readonly unknown[];
};
type Image =
  | { bytes: Buffer; snapshotNumber: number }
  | { code: 'login-step' | 'unstable' | 'limit' | 'error' };
type SnapshotResult = { ok: true; snapshot: Snapshot; image: Image };
type ProtectedSnapshot = Omit<SnapshotResult, 'ok'>;
type Ports = {
  getTask(): Promise<
    Failure | { ok: true; task: { type: 'preparation'; sourceId: string; instruction: string } }
  >;
  getSnapshot(): Promise<Failure | SnapshotResult>;
  readText(
    args: ReadArgs,
  ): Promise<Failure | (Failure & ProtectedSnapshot) | (SnapshotResult & { text: string })>;
  unsupported?(category: 'unsupported'): Promise<Failure | void>;
};
export declare const createPreparationMcp: typeof create;
declare const exports: { createPreparationMcp: typeof create };
const VERSION = '2025-11-25';
const INVALID = { code: -32602, message: 'Invalid params' };
const METHOD = { code: -32601, message: 'Method not found' };
const STATE = { code: -32002, message: 'Server not initialized' };
const INTERNAL = { code: -32603, message: 'Internal error' };
const failureCodeSet: ReadonlySet<string> = new Set(failureCodes);
const verdictCodeSet: ReadonlySet<string> = new Set([
  'stale',
  'unclassified',
  'blocked-payment',
  'blocked-change',
  'secret-field',
  'not-found',
  'ambiguous',
  'hidden',
  'disabled',
  'foreign-frame',
]);
const imageCodeSet: ReadonlySet<string> = new Set(['login-step', 'unstable', 'limit', 'error']);
const numberSchema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const tools = [
  {
    name: 'current_task',
    description: 'Get the current preparation task',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'snapshot',
    description: 'Get the protected snapshot',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'readText',
    description: 'Read text from a snapshot node',
    inputSchema: {
      type: 'object',
      properties: {
        snapshotNumber: numberSchema,
        nodeNumber: numberSchema,
        options: {
          type: 'object',
          properties: { deep: { type: 'boolean' } },
          additionalProperties: false,
        },
      },
      required: ['snapshotNumber', 'nodeNumber'],
      additionalProperties: false,
    },
  },
];
function object(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
function fields(
  value: unknown,
  allowed: string[],
  required: string[] = [],
): value is Record<string, unknown> {
  if (!object(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.every(
      (key) =>
        typeof key === 'string' &&
        allowed.includes(key) &&
        !!Object.getOwnPropertyDescriptor(value, key) &&
        'value' in Object.getOwnPropertyDescriptor(value, key)!,
    ) && required.every((key) => Object.hasOwn(value, key))
  );
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
type Content = { type: string; text?: string; mimeType?: string; data?: string };
function snapshotContent(snapshot: unknown, image: unknown): Content[] | null {
  if (!object(snapshot) || !positive(snapshot.snapshot) || !object(image)) return null;
  const text = { type: 'text', text: JSON.stringify(snapshot) };
  if (
    fields(image, ['bytes', 'snapshotNumber'], ['bytes', 'snapshotNumber']) &&
    Buffer.isBuffer(image.bytes) &&
    image.snapshotNumber === snapshot.snapshot
  )
    return [text, { type: 'image', mimeType: 'image/png', data: image.bytes.toString('base64') }];
  if (
    fields(image, ['code'], ['code']) &&
    typeof image.code === 'string' &&
    imageCodeSet.has(image.code)
  )
    return [text, { type: 'text', text: image.code }];
  return null;
}
function validVersion(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function create(ports: Ports) {
  let state: 'new' | 'initializing' | 'ready' = 'new';
  return async (message: unknown): Promise<unknown> => {
    try {
      if (
        !fields(message, ['jsonrpc', 'id', 'method', 'params'], ['jsonrpc', 'method']) ||
        message.jsonrpc !== '2.0' ||
        typeof message.method !== 'string'
      )
        return undefined;
      const hasId = Object.hasOwn(message, 'id');
      const id = message.id;
      if (
        hasId &&
        !(typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id) && id >= 0))
      )
        return undefined;
      const reply = (result: unknown) =>
        hasId ? { jsonrpc: '2.0', id: id as RequestId, result } : undefined;
      const error = (value: typeof INVALID) =>
        hasId ? { jsonrpc: '2.0', id: id as RequestId, error: value } : undefined;
      if (message.method === 'notifications/initialized') {
        if (
          !hasId &&
          state === 'initializing' &&
          (message.params === undefined || fields(message.params, []))
        )
          state = 'ready';
        return undefined;
      }
      if (!hasId) return undefined;
      if (message.method === 'initialize') {
        const p = message.params;
        if (
          state !== 'new' ||
          !fields(
            p,
            ['protocolVersion', 'capabilities', 'clientInfo'],
            ['protocolVersion', 'capabilities', 'clientInfo'],
          ) ||
          !validVersion(p.protocolVersion) ||
          !object(p.capabilities) ||
          !fields(p.clientInfo, ['name', 'version', 'title'], ['name', 'version']) ||
          typeof p.clientInfo.name !== 'string' ||
          !p.clientInfo.name ||
          typeof p.clientInfo.version !== 'string' ||
          !p.clientInfo.version ||
          (Object.hasOwn(p.clientInfo, 'title') && typeof p.clientInfo.title !== 'string')
        )
          return error(INVALID);
        state = 'initializing';
        return reply({
          protocolVersion: VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'preparation', version: '1.0.0' },
        });
      }
      if (message.method === 'ping') {
        if (message.params !== undefined && !fields(message.params, [])) return error(INVALID);
        return reply({});
      }
      if (state !== 'ready') return error(STATE);
      if (message.method === 'tools/list') {
        if (message.params !== undefined && !fields(message.params, [])) return error(INVALID);
        return reply({ tools });
      }
      if (message.method !== 'tools/call') return error(METHOD);
      const p = message.params;
      if (!fields(p, ['name', 'arguments'], ['name']) || typeof p.name !== 'string')
        return error(INVALID);
      if (p.name !== 'current_task' && p.name !== 'snapshot' && p.name !== 'readText') {
        const result = await ports.unsupported?.('unsupported');
        if (result && !result.ok && result.code === 'protocol-unavailable')
          return reply({ content: [{ type: 'text', text: result.code }], isError: true });
        return error(METHOD);
      }
      const args = Object.hasOwn(p, 'arguments') ? p.arguments : {};
      if (
        !fields(
          args,
          p.name === 'readText' ? ['snapshotNumber', 'nodeNumber', 'options'] : [],
          p.name === 'readText' ? ['snapshotNumber', 'nodeNumber'] : [],
        )
      )
        return error(INVALID);
      let result:
        | Awaited<ReturnType<Ports['getTask']>>
        | Awaited<ReturnType<Ports['getSnapshot']>>
        | Awaited<ReturnType<Ports['readText']>>;
      if (p.name === 'current_task') result = await ports.getTask();
      else if (p.name === 'snapshot') result = await ports.getSnapshot();
      else if (p.name === 'readText') {
        if (
          !positive(args.snapshotNumber) ||
          !positive(args.nodeNumber) ||
          (Object.hasOwn(args, 'options') &&
            (!fields(args.options, ['deep']) ||
              (Object.hasOwn(args.options, 'deep') && typeof args.options.deep !== 'boolean')))
        )
          return error(INVALID);
        const safe: ReadArgs = { snapshotNumber: args.snapshotNumber, nodeNumber: args.nodeNumber };
        if (Object.hasOwn(args, 'options'))
          safe.options = Object.hasOwn(args.options as object, 'deep')
            ? { deep: (args.options as { deep: boolean }).deep }
            : {};
        result = await ports.readText(safe);
      } else return error(METHOD);
      if (!object(result) || (result.ok !== true && result.ok !== false)) return error(INTERNAL);
      if (!result.ok) {
        const code = failureCodeSet.has(result.code) ? result.code : 'internal';
        const next =
          p.name === 'readText' &&
          verdictCodeSet.has(code) &&
          'snapshot' in result &&
          'image' in result
            ? snapshotContent(result.snapshot, result.image)
            : null;
        return reply({
          content: [{ type: 'text', text: code }, ...(next ?? [])],
          isError: true,
        });
      }
      const content: Content[] = [];
      if (p.name === 'current_task') {
        if (!('task' in result)) return error(INTERNAL);
        content.push({ type: 'text', text: JSON.stringify(result.task) });
      } else {
        if ('task' in result) return error(INTERNAL);
        if (p.name === 'readText' && !('text' in result)) return error(INTERNAL);
        if ('text' in result) {
          if (typeof result.text !== 'string') return error(INTERNAL);
          content.push({ type: 'text', text: result.text });
        }
        const next = snapshotContent(result.snapshot, result.image);
        if (!next) return error(INTERNAL);
        content.push(...next);
      }
      return reply({ content });
    } catch {
      return object(message) &&
        Object.hasOwn(message, 'id') &&
        (typeof message.id === 'string' ||
          (typeof message.id === 'number' && Number.isSafeInteger(message.id) && message.id >= 0))
        ? { jsonrpc: '2.0', id: message.id, error: INTERNAL }
        : undefined;
    }
  };
}
exports.createPreparationMcp = create;
