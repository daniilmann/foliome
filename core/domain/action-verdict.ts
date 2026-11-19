type Prohibited = 'blocked-payment' | 'blocked-change';
export type DenialBudget = 'hard' | 'label';
export type ActionFacts = Readonly<{
  label: string;
  inputKind: string;
  autocomplete: string;
  currentPath: string;
  href: string;
  formAction: string;
  confirmationForm: boolean;
  formFieldKinds: readonly string[];
  tag?: string;
  controlType?: string;
  role?: string;
  alternateLabels?: readonly string[];
}>;

export type ActionCandidate = Readonly<{
  nodeNumber: number;
  sameNode: boolean;
  visible: boolean;
  enabled: boolean;
  sourceFrame: boolean;
  secretField: boolean;
  prohibited: Prohibited | null;
  facts?: ActionFacts;
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
export declare const decideReadPolicy: typeof decideWithBudget;
export declare const classifyProhibitedFacts: typeof classify;
declare const exports: {
  decideActionVerdict: typeof decide;
  decideReadPolicy: typeof decideWithBudget;
  classifyProhibitedFacts: typeof classify;
};

type Classification = { prohibited: Prohibited | null; budget: DenialBudget | null };
type ReadPolicy = ActionVerdict | { ok: false; code: Prohibited; budget: DenialBudget };
const paymentFields = new Set(['amount', 'recipient', 'transfer details']);
const cardAutocomplete = new Set([
  'cc-name',
  'cc-given-name',
  'cc-additional-name',
  'cc-family-name',
  'cc-number',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-csc',
  'cc-type',
]);
const paymentLabels = new Set([
  'pay',
  'payment',
  'transfer',
  'оплатить',
  'платёж',
  'платеж',
  'перевод',
  'перевести',
]);
const changeLabels = new Set(['delete', 'remove', 'settings', 'удалить', 'настройки']);
const readLabels = new Set([
  'save as pdf',
  'change period',
  'сохранить как pdf',
  'изменить период',
]);

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ').toLowerCase() : '';
}

function path(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 2048) return '';
  try {
    const url = new URL(value, 'https://example.invalid');
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.pathname.toLowerCase() : '';
  } catch {
    return '';
  }
}

function classify(
  facts: unknown,
  loginStep = ownValue(facts, 'loginStep') === true,
): Classification {
  const alternateLabels = ownValue(facts, 'alternateLabels');
  const labels = [
    ownValue(facts, 'label'),
    ...(Array.isArray(alternateLabels) ? alternateLabels : []),
  ].map(normalized);
  const inputKind = normalized(ownValue(facts, 'inputKind'));
  const autocomplete = normalized(ownValue(facts, 'autocomplete')).split(' ');
  const fields = ownValue(facts, 'formFieldKinds');
  const fieldKinds = Array.isArray(fields) ? fields : [];
  const formAction = path(ownValue(facts, 'formAction'));
  const paymentPath = [
    path(ownValue(facts, 'currentPath')),
    path(ownValue(facts, 'href')),
    formAction,
  ].includes('/payment');
  const confirmationForm =
    ownValue(facts, 'confirmationForm') === true ||
    fieldKinds.some((kind) => paymentFields.has(kind));
  const credential =
    inputKind === 'password' ||
    autocomplete.some(
      (kind) => kind === 'current-password' || kind === 'new-password' || kind === 'one-time-code',
    );
  if (
    paymentPath ||
    paymentFields.has(inputKind) ||
    autocomplete.some((kind) => cardAutocomplete.has(kind)) ||
    (credential && (!loginStep || confirmationForm))
  )
    return { prohibited: 'blocked-payment', budget: 'hard' };

  if (labels.some((label) => paymentLabels.has(label)))
    return { prohibited: 'blocked-payment', budget: 'label' };
  if (labels.some((label) => changeLabels.has(label)))
    return { prohibited: 'blocked-change', budget: 'label' };
  const safeFields =
    Array.isArray(fields) && fieldKinds.every((kind) => kind === 'date' || kind === 'choice');
  const safeLabel = safeFields && labels.some((label) => readLabels.has(label));
  const conditionalLabels = safeLabel ? labels.filter((label) => !readLabels.has(label)) : labels;

  if (
    conditionalLabels.some((label) =>
      /(?:pay(?:ment)?|transfer|оплат|плат[её]ж|перевод)/iu.test(label),
    )
  )
    return { prohibited: 'blocked-payment', budget: null };
  const tag = ownValue(facts, 'tag');
  const type = ownValue(facts, 'controlType');
  if (
    conditionalLabels.some((label) =>
      /(?:save|delete|remove|change|apply|сохран|удал|измен|примен)/iu.test(label),
    ) ||
    (!safeLabel &&
      ((type === 'submit' && (tag === 'input' || tag === 'button')) ||
        (type === 'reset' && tag === 'input')))
  )
    return { prohibited: 'blocked-change', budget: null };
  return { prohibited: null, budget: null };
}

function validFacts(facts: unknown): boolean {
  const list = (values: unknown, count: number, size: number) =>
    Array.isArray(values) &&
    values.length <= count &&
    values.every((value) => typeof value === 'string' && value.length <= size);
  const alternateLabels = ownValue(facts, 'alternateLabels');
  return (
    ['label', 'inputKind', 'autocomplete', 'currentPath', 'href', 'formAction'].every((key) => {
      const value = ownValue(facts, key);
      return typeof value === 'string' && value.length <= 2048;
    }) &&
    typeof ownValue(facts, 'confirmationForm') === 'boolean' &&
    list(ownValue(facts, 'formFieldKinds'), 32, 64) &&
    (alternateLabels === undefined || list(alternateLabels, 6, 256))
  );
}

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
  const verdict = decideWithBudget(command, context);
  return 'budget' in verdict ? { ok: false, code: verdict.code } : verdict;
}

function decideWithBudget(command: unknown, context: ActionContext): ReadPolicy {
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
    const actionClass = ownValue(command, 'actionClass');
    const facts = ownValue(candidate, 'facts');
    if (actionClass === 'read' && facts !== undefined) {
      if (!validFacts(facts)) return { ok: false, code: 'unclassified' };
      const { prohibited, budget } = classify(facts, ownValue(context, 'loginStep') === true);
      if (prohibited) return { ok: false, code: prohibited, ...(budget ? { budget } : {}) };
    }
    if (ownValue(candidate, 'secretField') !== false) return { ok: false, code: 'secret-field' };
    const prohibited = ownValue(candidate, 'prohibited');
    if (prohibited === 'blocked-payment' || prohibited === 'blocked-change')
      return { ok: false, code: prohibited };
    if (prohibited !== null || actionClass !== 'read') {
      return { ok: false, code: 'unclassified' };
    }
    return { ok: true, snapshotNumber, nodeNumber, deep };
  } catch {
    return { ok: false, code: 'unsupported' };
  }
}

exports.decideActionVerdict = decide;
exports.decideReadPolicy = decideWithBudget;
exports.classifyProhibitedFacts = classify;
