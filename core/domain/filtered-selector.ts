import type { filterTextSnapshot } from './snapshot-filter.ts';

type Snapshot = Extract<ReturnType<typeof filterTextSnapshot>, { ok: true }>['snapshot'];
type Condition =
  | { kind: 'text'; operator: 'equals' | 'contains'; value: string }
  | { kind: 'attribute'; name: string; operator: 'equals' | 'token' | 'prefix' | 'suffix' | 'contains' | 'language-prefix'; value: string };

const attributes = new Set(['id', 'name', 'class', 'data-testid', 'type', 'autocomplete', 'placeholder', 'aria-label', 'href']);
const attributeOperators = new Set(['equals', 'token', 'prefix', 'suffix', 'contains', 'language-prefix']);
const whitespace = ' \t\n\r\f\v\u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
const tokenWhitespace = ' \t\n\r\f';

function normalizeText(value: string): string {
  let result = '';
  let pendingSpace = false;
  for (const char of value) {
    if (whitespace.includes(char)) pendingSpace = result.length > 0;
    else {
      if (pendingSpace) result += ' ';
      result += char;
      pendingSpace = false;
    }
  }
  return result;
}

function valid(value: unknown): value is Condition {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const condition = value as Record<string, unknown>;
  if (typeof condition.value !== 'string' || typeof condition.operator !== 'string') return false;
  if (condition.kind === 'text') return condition.operator === 'equals' || condition.operator === 'contains';
  return condition.kind === 'attribute' && typeof condition.name === 'string' && attributes.has(condition.name) && attributeOperators.has(condition.operator);
}

function tokenContains(actual: string, wanted: string): boolean {
  if (!wanted || [...wanted].some(char => tokenWhitespace.includes(char))) return false;
  let token = '';
  for (const char of actual) {
    if (tokenWhitespace.includes(char)) {
      if (token === wanted) return true;
      token = '';
    } else token += char;
  }
  return token === wanted;
}

function matches(actual: string, condition: Condition): boolean {
  if (condition.kind === 'text') {
    const text = normalizeText(actual);
    const value = normalizeText(condition.value);
    return condition.operator === 'equals' ? text === value : text.toLowerCase().includes(value.toLowerCase());
  }
  switch (condition.operator) {
    case 'equals': return actual === condition.value;
    case 'token': return tokenContains(actual, condition.value);
    case 'prefix': return condition.value !== '' && actual.startsWith(condition.value);
    case 'suffix': return condition.value !== '' && actual.endsWith(condition.value);
    case 'contains': return condition.value !== '' && actual.includes(condition.value);
    case 'language-prefix': return actual === condition.value || actual.startsWith(condition.value + '-');
  }
}

function select(snapshot: Snapshot | null, conditions: unknown): number[] {
  if (!snapshot || !Array.isArray(conditions) || !Array.from(conditions).every(valid)) return [];
  return snapshot.elements.filter(element => conditions.every((condition: Condition) => {
    if (condition.kind === 'text') return matches(element.text, condition);
    const value = condition.name === 'href' ? element.href : element.attrs?.[condition.name];
    return typeof value === 'string' && matches(value, condition);
  })).map(element => element.n);
}

export declare const selectFilteredNodes: typeof select;
declare const exports: { selectFilteredNodes: typeof select };
exports.selectFilteredNodes = select;
