type Secret = { value: string; kind: 'login' | 'password' | 'code' };
type Frame = { index: number; host: string; foreign: boolean; unavailable: boolean };
type NodeFact = { n: number; frame: number; parent?: number; visible: boolean; role: string; text: string; name?: string; state?: string; field?: 'empty' | 'filled' | 'sealed'; href?: string; attrs?: Record<string, string> };
type Facts = { snapshot: number; page: { url: string; title: string }; frames: Frame[]; nodes: NodeFact[]; secrets: Secret[] };
type Element = { n: number; frame: number; role: string; text: string; name?: string; state?: string; field?: string; href?: string; attrs?: Record<string, string> };
type Snapshot = { snapshot: number; page: { host: string; path: string; title: string }; truncated: boolean; frames: { host: string; foreign: boolean; unavailable: boolean }[]; elements: Element[] };
type Result = { ok: true; snapshot: Snapshot } | { ok: false; code: 'internal' };

const attrsAllowed = new Set(['id', 'name', 'class', 'data-testid', 'type', 'autocomplete', 'placeholder', 'aria-label']);
const fieldRoles = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox', 'slider']);
const digitPattern = /\p{Nd}/u;
const wordPattern = /[\p{L}\p{N}_]/u;
const boundary = '\u0000';

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\p{White_Space}/gu, ' ').replace(/[\p{Cf}\p{Cc}]/gu, '').replace(/ +/g, ' ');
}
function digit(char: string): number {
  const code = char.codePointAt(0)!;
  let start = code;
  while (start > 0 && digitPattern.test(String.fromCodePoint(start - 1))) start--;
  return (code - start) % 10;
}
function tokenMask(value: string): string {
  return value.replace(/[A-Za-z0-9]+[A-Za-z0-9_\-.~%+=/]*/g, (run: string) => {
    const segments = [...run.matchAll(/[A-Za-z0-9]+/g)];
    const hit = segments.find((m) => {
      const d = (m[0].match(/[0-9]/g) ?? []).length;
      return (m[0].length >= 20 && d > 0) || (m[0].length >= 12 && d >= 3) || (m[0].length >= 8 && /^[a-f\d]+$/i.test(m[0]) && d >= 2);
    });
    return hit ? run.slice(0, hit.index) + '{id}' : run;
  });
}

type Range = { start: number; end: number; kind: 'secret' | 'card' };
function ranges(text: string, secrets: Secret[]): Range[] {
  const found: Range[] = [];
  const groups = [...text.matchAll(/\p{Nd}+/gu)].map(m => ({ start: m.index, end: m.index + m[0].length, value: [...m[0]].map(digit).join('') }));
  const separated = (a: number, b: number) => {
    const between = text.slice(a, b);
    return /^[ .\-\u0000]*$/.test(between) && between.replace(/\u0000/g, '').length <= 2;
  };
  const cardEnds = new Set<number>();
  const cardStarts = new Set<number>();
  for (let i = 0; i < groups.length; i++) {
    let number = '';
    for (let j = i; j < groups.length; j++) {
      const group = groups[j];
      if (j > i && (!separated(groups[j - 1].end, group.start) || groups[j - 1].value.length < 3 || groups[j - 1].value.length > 6 || group.value.length < 3 || group.value.length > 6)) break;
      number += group.value;
      if (number.length > 19) break;
      if (number.length < 13 || (j > i && group.value.length > 6)) continue;
      let sum = 0;
      for (let k = number.length - 1; k >= 0; k--) {
        let n = Number(number[k]);
        if ((number.length - 1 - k) % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
        sum += n;
      }
      if (sum % 10 === 0) {
        let remaining = number.length - 4;
        for (let k = i; k <= j && remaining > 0; k++) {
          const g = groups[k];
          let end = g.start;
          for (const ch of text.slice(g.start, g.end)) { if (remaining-- <= 0) break; end += ch.length; }
          if (end > g.start) found.push({ start: g.start, end, kind: 'card' });
        }
        cardEnds.add(group.end);
        cardStarts.add(groups[i].start);
      }
    }
  }
  for (const match of text.matchAll(/\b(?:cvv|cvc)\b[\s\u0000:=-]*([\p{Nd}]{3,4})(?!\p{Nd})/giu)) {
    const start = match.index + match[0].length - match[1].length;
    found.push({ start, end: start + match[1].length, kind: 'secret' });
    cardEnds.add(start + match[1].length);
  }
  for (const secret of secrets) {
    const value = normalize(secret.value);
    if (!value) continue;
    if (/^\p{Nd}+$/u.test(value)) {
      const wanted = [...value].map(digit).join('');
      if (wanted.length < 4) continue;
      for (let i = 0; i < groups.length; i++) {
        if (i > 0 && separated(groups[i - 1].end, groups[i].start) && !cardEnds.has(groups[i - 1].end)) continue;
        let valueDigits = '';
        for (let j = i; j < groups.length; j++) {
          if (j > i && !separated(groups[j - 1].end, groups[j].start)) break;
          valueDigits += groups[j].value;
          if (valueDigits.length >= wanted.length) {
            if (valueDigits === wanted && (j + 1 === groups.length || cardStarts.has(groups[j + 1].start) || (groups[j + 1].value.length >= 3 && groups.slice(i, j + 1).every(g => g.value.length === 1)) || !separated(groups[j].end, groups[j + 1].start))) found.push({ start: groups[i].start, end: groups[j].end, kind: 'secret' });
            break;
          }
        }
      }
    } else {
      let compact = '';
      const offsets: number[] = [];
      for (let i = 0; i < text.length; i++) {
        if (text[i] !== boundary) { compact += text[i]; offsets.push(i); }
      }
      const haystack = secret.kind === 'login' ? compact.toLowerCase() : compact;
      const needle = secret.kind === 'login' ? value.toLowerCase() : value;
      // Case folding can change UTF-16 length; in that case do not expose the text.
      if (haystack.length !== compact.length || needle.length !== value.length) {
        if (haystack.includes(needle)) found.push({ start: 0, end: text.length, kind: 'secret' });
        continue;
      }
      let from = 0;
      while (from <= haystack.length - needle.length) {
        const at = haystack.indexOf(needle, from);
        if (at < 0) break;
        const wholeWord = value.length < 4 || (secret.kind === 'login' && value.length <= 6);
        if (!wholeWord || (!(offsets[at] > 0 && wordPattern.test(text[offsets[at] - 1])) && !(offsets[at + needle.length - 1] + 1 < text.length && wordPattern.test(text[offsets[at + needle.length - 1] + 1])))) {
          let end = at + needle.length;
          // Cover a repeated prefix that continues a self-overlapping secret.
          for (let length = needle.length - 1; length >= 2; length--) {
            if (needle.endsWith(needle.slice(0, length)) && haystack.startsWith(needle.slice(0, length), end)) { end += length; break; }
          }
          found.push({ start: offsets[at], end: offsets[end - 1] + 1, kind: 'secret' });
        }
        from = at + 1;
      }
    }
  }
  return found;
}
function maskedSlice(text: string, start: number, end: number, masks: Range[]): string {
  let result = '';
  let secret = false;
  for (let i = start; i < end;) {
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    const covered = masks.some(r => r.kind === 'secret' && i < r.end && i + ch.length > r.start);
    const card = masks.some(r => r.kind === 'card' && i < r.end && i + ch.length > r.start);
    if (covered) { if (!secret) result += '[секрет]'; secret = true; }
    else { secret = false; result += card && digitPattern.test(ch) ? '•' : ch; }
    i += ch.length;
  }
  return result;
}
function mask(value: string, secrets: Secret[]): string {
  const text = normalize(value);
  return maskedSlice(text, 0, text.length, ranges(text, secrets));
}
function address(raw: string, secrets: Secret[]): { host: string; path: string } {
  const url = new URL(raw);
  if (url.protocol !== 'https:') return { host: '', path: url.protocol };
  const safe = (value: string) => {
    let decoded: string;
    try { decoded = decodeURIComponent(value); } catch { return '…'; }
    return tokenMask(mask(decoded, secrets));
  };
  const path = url.pathname.split('/').map(part => {
    const semicolon = part.indexOf(';');
    return safe(semicolon < 0 ? part : part.slice(0, semicolon)) + (semicolon < 0 ? '' : ';…');
  }).join('/');
  const query = [...url.searchParams].map(([key, value]) => {
    const cleanKey = safe(key);
    const cleanValue = safe(value);
    return `${cleanKey}=${/^(?:sid|token|code|session|sessionid|access_token|refresh_token|password|secret|key|auth)$/i.test(key) || cleanValue.includes('{id}') ? '…' : cleanValue}`;
  }).join('&');
  return { host: safe(url.hostname), path: path + (query ? '?' + query : '') + (url.hash ? '#…' : '') };
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function valid(input: unknown): input is Facts {
  if (!isRecord(input) || !Number.isSafeInteger(input.snapshot) || (input.snapshot as number) < 1 || !isRecord(input.page) || typeof input.page.url !== 'string' || typeof input.page.title !== 'string' || !Array.isArray(input.frames) || !Array.isArray(input.nodes) || !Array.isArray(input.secrets)) return false;
  const frames = new Set<number>();
  for (const f of input.frames) {
    if (!isRecord(f) || !Number.isSafeInteger(f.index) || (f.index as number) < 0 || frames.has(f.index as number) || typeof f.host !== 'string' || typeof f.foreign !== 'boolean' || typeof f.unavailable !== 'boolean') return false;
    frames.add(f.index as number);
  }
  const nodes = new Set<number>();
  const nodeFrames = new Map<number, number>();
  for (const n of input.nodes) {
    if (!isRecord(n) || !Number.isSafeInteger(n.n) || (n.n as number) < 1 || nodes.has(n.n as number) || !Number.isSafeInteger(n.frame) || !frames.has(n.frame as number) || typeof n.visible !== 'boolean' || typeof n.role !== 'string' || typeof n.text !== 'string') return false;
    if (['name', 'state', 'href'].some(k => n[k] !== undefined && typeof n[k] !== 'string') || (n.field !== undefined && !['empty', 'filled', 'sealed'].includes(n.field as string))) return false;
    if (n.attrs !== undefined && (!isRecord(n.attrs) || Object.values(n.attrs).some(v => typeof v !== 'string'))) return false;
    if (n.parent !== undefined && (!Number.isSafeInteger(n.parent) || nodeFrames.get(n.parent as number) !== n.frame)) return false;
    nodeFrames.set(n.n as number, n.frame as number);
    nodes.add(n.n as number);
  }
  return input.secrets.every(s => isRecord(s) && typeof s.value === 'string' && ['login', 'password', 'code'].includes(s.kind as string));
}
export declare const filterTextSnapshot: typeof filter;
declare const exports: { filterTextSnapshot: typeof filter };
function filter(input: unknown): Result {
  try {
    if (!valid(input)) return { ok: false, code: 'internal' };
    const { secrets } = input;
    const pageAddress = address(input.page.url, secrets);
    const snapshot: Snapshot = { snapshot: input.snapshot, page: { ...pageAddress, title: mask(input.page.title, secrets) }, truncated: false, frames: input.frames.map(f => ({ host: tokenMask(mask(f.host, secrets)), foreign: f.foreign, unavailable: f.unavailable })), elements: [] };
    const frameMap = new Map(input.frames.map(f => [f.index, f]));
    const framePositions = new Map(input.frames.map((f, i) => [f.index, i]));
    const visible = new Map<number, boolean>();
    const documents = new Map<number, { text: string; slices: { node: NodeFact; start: number; end: number }[] }>();
    for (const node of input.nodes) {
      const frame = frameMap.get(node.frame)!;
      const shown = node.visible && (node.parent === undefined || visible.get(node.parent) === true);
      visible.set(node.n, shown);
      if (!shown || frame.foreign || frame.unavailable) continue;
      let document = documents.get(node.frame);
      if (!document) { document = { text: '', slices: [] }; documents.set(node.frame, document); }
      if (document.slices.length) document.text += boundary;
      const start = document.text.length;
      if (!node.field && !fieldRoles.has(node.role.toLowerCase())) document.text += normalize(node.text);
      document.slices.push({ node, start, end: document.text.length });
    }
    const texts = new Map<number, string>();
    for (const document of documents.values()) {
      const masks = ranges(document.text, secrets);
      const numericSecrets = new Set(secrets.map(s => normalize(s.value)).filter(s => /^\p{Nd}+$/u.test(s) && [...s].length >= 4).map(s => [...s].map(digit).join('')));
      const ancestry = new Map<number, NodeFact>();
      const descendants = new Map<number, { digits: string; slices: { start: number; end: number }[] }>();
      for (const slice of document.slices) {
        ancestry.set(slice.node.n, slice.node);
        let current: NodeFact | undefined = slice.node;
        const digits = [...document.text.slice(slice.start, slice.end)].filter(ch => digitPattern.test(ch)).map(digit).join('');
        while (current) {
          let entry = descendants.get(current.n);
          if (!entry) { entry = { digits: '', slices: [] }; descendants.set(current.n, entry); }
          entry.digits += digits;
          entry.slices.push(slice);
          current = current.parent === undefined ? undefined : ancestry.get(current.parent);
        }
      }
      for (const entry of descendants.values()) if (numericSecrets.has(entry.digits)) {
        for (const slice of entry.slices) masks.push({ start: slice.start, end: slice.end, kind: 'secret' });
      }
      for (const slice of document.slices) texts.set(slice.node.n, maskedSlice(document.text, slice.start, slice.end, masks));
    }
    const limit = (value: string) => { if ([...value].length <= 500) return value; snapshot.truncated = true; return [...value].slice(0, 500).join(''); };
    snapshot.page.host = limit(snapshot.page.host); snapshot.page.path = limit(snapshot.page.path); snapshot.page.title = limit(snapshot.page.title);
    for (const frame of snapshot.frames) frame.host = limit(frame.host);
    for (const node of input.nodes) {
      if (!texts.has(node.n)) continue;
      if (snapshot.elements.length === 3000) { snapshot.truncated = true; break; }
      const isField = !!node.field || fieldRoles.has(node.role.toLowerCase());
      const element: Element = { n: node.n, frame: framePositions.get(node.frame)!, role: limit(mask(node.role, secrets)), text: limit(texts.get(node.n)!) };
      if (node.field) element.field = node.field;
      if (!isField && node.name !== undefined) element.name = limit(mask(node.name, secrets));
      if (node.state !== undefined) element.state = limit(mask(node.state, secrets));
      if (node.href !== undefined) { const a = address(node.href, secrets); element.href = limit(a.host ? `https://${a.host}${a.path}` : a.path); }
      if (node.attrs) {
        element.attrs = {};
        for (const [key, value] of Object.entries(node.attrs)) if (attrsAllowed.has(key) && (!isField || !['name', 'placeholder', 'aria-label'].includes(key))) element.attrs[key] = limit(tokenMask(mask(value, secrets)));
      }
      snapshot.elements.push(element);
    }
    const encoder = new TextEncoder();
    const size = (value: unknown) => encoder.encode(JSON.stringify(value)).length;
    let total = size(snapshot);
    if (total > 256 * 1024) {
      snapshot.truncated = true;
      total = size(snapshot);
      while (total > 256 * 1024 && snapshot.elements.length) {
        const element = snapshot.elements.pop()!;
        total -= size(element) + (snapshot.elements.length ? 1 : 0);
      }
    }
    if (total > 256 * 1024) return { ok: false, code: 'internal' };
    return { ok: true, snapshot };
  } catch { return { ok: false, code: 'internal' }; }
}

exports.filterTextSnapshot = filter;
