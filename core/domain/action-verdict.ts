export type ActionCandidate = Readonly<{
  nodeNumber: number;
  sameNode: boolean;
  visible: boolean;
  enabled: boolean;
  sourceFrame: boolean;
  secretField: boolean;
  prohibited: 'blocked-payment' | 'blocked-change' | null;
}>;

/** Facts are supplied by the kernel, not by the command sender. */
export type ActionContext = Readonly<{
  sessionActive: boolean;
  loginStep: boolean;
  snapshotNumber: number;
  candidates: readonly ActionCandidate[];
}>;

export type ActionVerdict =
  | { ok: true; snapshotNumber: number; nodeNumber: number; deep: boolean }
  | {
      ok: false;
      code:
        | 'unsupported'
        | 'unclassified'
        | 'session-unavailable'
        | 'stale'
        | 'not-found'
        | 'ambiguous'
        | 'foreign-frame'
        | 'hidden'
        | 'disabled'
        | 'secret-field'
        | 'blocked-payment'
        | 'blocked-change';
    };

export declare const decideActionVerdict: typeof decide;
declare const exports: { decideActionVerdict: typeof decide };

function ownValue(record: unknown, key: PropertyKey): unknown {
  if (typeof record !== 'object' || record === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function hasOnlyDataKeys(record: unknown, allowed: readonly string[]): boolean {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return false;
  return Reflect.ownKeys(record).every(
    (key) =>
      typeof key === 'string' &&
      allowed.includes(key) &&
      Object.hasOwn(Object.getOwnPropertyDescriptor(record, key) ?? {}, 'value'),
  );
}

function decide(command: unknown, context: ActionContext): ActionVerdict {
  try {
    if (
      !hasOnlyDataKeys(command, [
        'method',
        'snapshotNumber',
        'nodeNumber',
        'actionClass',
        'options',
      ])
    ) {
      return { ok: false, code: 'unsupported' };
    }
    const snapshotNumber = ownValue(command, 'snapshotNumber');
    const nodeNumber = ownValue(command, 'nodeNumber');
    if (
      ownValue(command, 'method') !== 'readText' ||
      typeof snapshotNumber !== 'number' ||
      !Number.isSafeInteger(snapshotNumber) ||
      snapshotNumber < 1 ||
      typeof nodeNumber !== 'number' ||
      !Number.isSafeInteger(nodeNumber) ||
      nodeNumber < 1
    )
      return { ok: false, code: 'unsupported' };

    let deep = false;
    if (Object.hasOwn(command as object, 'options')) {
      const options = ownValue(command, 'options');
      if (!hasOnlyDataKeys(options, ['deep'])) return { ok: false, code: 'unsupported' };
      if (Object.hasOwn(options as object, 'deep')) {
        const value = ownValue(options, 'deep');
        if (typeof value !== 'boolean') return { ok: false, code: 'unsupported' };
        deep = value;
      }
    }
    if (ownValue(context, 'sessionActive') !== true) {
      return { ok: false, code: 'session-unavailable' };
    }
    if (ownValue(context, 'snapshotNumber') !== snapshotNumber) return { ok: false, code: 'stale' };
    const candidates = ownValue(context, 'candidates');
    if (!Array.isArray(candidates)) return { ok: false, code: 'not-found' };
    const matches: unknown[] = [];
    for (let index = 0; index < candidates.length; index++) {
      const candidate = ownValue(candidates, String(index));
      if (ownValue(candidate, 'nodeNumber') === nodeNumber) matches.push(candidate);
    }
    if (matches.length === 0) return { ok: false, code: 'not-found' };
    if (matches.length !== 1) return { ok: false, code: 'ambiguous' };
    const candidate = matches[0];
    if (ownValue(candidate, 'sameNode') !== true) return { ok: false, code: 'stale' };
    if (ownValue(candidate, 'sourceFrame') !== true) return { ok: false, code: 'foreign-frame' };
    if (ownValue(candidate, 'visible') !== true) return { ok: false, code: 'hidden' };
    if (ownValue(candidate, 'enabled') !== true) return { ok: false, code: 'disabled' };
    if (ownValue(candidate, 'secretField') !== false) return { ok: false, code: 'secret-field' };
    const prohibited = ownValue(candidate, 'prohibited');
    if (prohibited === 'blocked-payment' || prohibited === 'blocked-change')
      return { ok: false, code: prohibited };
    if (prohibited !== null || ownValue(command, 'actionClass') !== 'read') {
      return { ok: false, code: 'unclassified' };
    }
    return { ok: true, snapshotNumber, nodeNumber, deep };
  } catch {
    return { ok: false, code: 'unsupported' };
  }
}

exports.decideActionVerdict = decide;
