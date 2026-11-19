import type { DatabaseSync } from 'node:sqlite';
import type { filterTextSnapshot } from '../../domain/snapshot-filter.ts';

type Filtered = Extract<ReturnType<typeof filterTextSnapshot>, { ok: true }>;
type Scope = Readonly<{ sourceId: string; accessId: string }>;
type Append = Scope & Readonly<{ sessionId: string; result: Filtered }>;
type Page = Scope & Readonly<{ host: string; path: string }>;

export declare const createTextSnapshotStore: typeof create;
declare const exports: { createTextSnapshotStore: typeof create };

const retentionMs = 90 * 24 * 60 * 60 * 1000;
const maxBytes = 256 * 1024;
const attrs = new Set([
  'id',
  'name',
  'class',
  'data-testid',
  'type',
  'autocomplete',
  'placeholder',
  'aria-label',
]);
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const integer = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Only the successful result of the kernel's filter is accepted at this trusted boundary.
// Rebuild the object so extra properties cannot enter storage.
function serialize(result: Filtered): { json: string; number: number; host: string; path: string } {
  if (!record(result) || result.ok !== true || !record(result.snapshot))
    throw new Error('invalid snapshot');
  const s = result.snapshot;
  if (
    !integer(s.snapshot, 1) ||
    !record(s.page) ||
    typeof s.page.host !== 'string' ||
    typeof s.page.path !== 'string' ||
    typeof s.page.title !== 'string' ||
    typeof s.truncated !== 'boolean' ||
    !Array.isArray(s.frames) ||
    !Array.isArray(s.elements)
  )
    throw new Error('invalid snapshot');
  const frames = s.frames.map((f: unknown) => {
    if (
      !record(f) ||
      typeof f.host !== 'string' ||
      typeof f.foreign !== 'boolean' ||
      typeof f.unavailable !== 'boolean'
    )
      throw new Error('invalid snapshot');
    return { host: f.host, foreign: f.foreign, unavailable: f.unavailable };
  });
  const elements = s.elements.map((e: unknown) => {
    if (
      !record(e) ||
      !integer(e.n, 1) ||
      !integer(e.frame, 0) ||
      typeof e.role !== 'string' ||
      typeof e.text !== 'string'
    )
      throw new Error('invalid snapshot');
    const element: {
      n: number;
      frame: number;
      role: string;
      text: string;
      field?: string;
      name?: string;
      state?: string;
      href?: string;
      attrs?: Record<string, string>;
    } = { n: e.n, frame: e.frame, role: e.role, text: e.text };
    for (const key of ['field', 'name', 'state', 'href'] as const) {
      if (e[key] !== undefined) {
        if (typeof e[key] !== 'string') throw new Error('invalid snapshot');
        element[key] = e[key];
      }
    }
    if (e.attrs !== undefined) {
      if (!record(e.attrs)) throw new Error('invalid snapshot');
      element.attrs = {};
      for (const [key, value] of Object.entries(e.attrs)) {
        if (attrs.has(key)) {
          if (typeof value !== 'string') throw new Error('invalid snapshot');
          element.attrs[key] = value;
        }
      }
    }
    return element;
  });
  const json = JSON.stringify({
    snapshot: s.snapshot,
    page: { host: s.page.host, path: s.page.path, title: s.page.title },
    truncated: s.truncated,
    frames,
    elements,
  });
  if (Buffer.byteLength(json, 'utf8') > maxBytes) throw new Error('snapshot too large');
  return { json, number: s.snapshot, host: s.page.host, path: s.page.path };
}

function create(database: DatabaseSync, clock: () => number) {
  const columns = `(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at_ms INTEGER NOT NULL CHECK (at_ms BETWEEN 0 AND 9007199254740991),
    session_id TEXT NOT NULL, source_id TEXT NOT NULL, access_id TEXT NOT NULL,
    snapshot_number INTEGER NOT NULL CHECK (snapshot_number BETWEEN 1 AND 9007199254740991),
    host TEXT NOT NULL, path TEXT NOT NULL,
    snapshot_json TEXT NOT NULL CHECK (length(CAST(snapshot_json AS BLOB)) <= 262144),
    UNIQUE (session_id, snapshot_number)
  ) STRICT`;
  database.exec(`CREATE TABLE IF NOT EXISTS text_snapshots ${columns};
  CREATE INDEX IF NOT EXISTS text_snapshots_page ON text_snapshots (source_id, access_id, host, path, id DESC);`);
  const insert = database.prepare(
    'INSERT INTO text_snapshots (at_ms, session_id, source_id, access_id, snapshot_number, host, path, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const latest = database.prepare(
    'SELECT snapshot_json FROM text_snapshots WHERE source_id = ? AND access_id = ? AND host = ? AND path = ? ORDER BY id DESC LIMIT 1',
  );
  const prune = database.prepare(`DELETE FROM main.text_snapshots AS old
    WHERE old.at_ms < ?
      AND EXISTS (SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = 'text_snapshots' AND sql = ?)
      AND NOT EXISTS (SELECT 1 FROM main.sqlite_schema WHERE type = 'trigger' AND tbl_name = 'text_snapshots')
      AND NOT EXISTS (SELECT 1 FROM temp.sqlite_schema WHERE type = 'trigger' AND tbl_name = 'text_snapshots')
      AND EXISTS (
        SELECT 1 FROM main.text_snapshots AS newer
        WHERE newer.source_id = old.source_id AND newer.access_id = old.access_id
          AND newer.host = old.host AND newer.path = old.path AND newer.id > old.id
      )`);
  let lastPruneAt = 0;
  function time(): number {
    const now = clock();
    if (!integer(now, 0)) throw new Error('invalid time');
    return now;
  }
  return {
    append(value: Append): void {
      if (
        !value ||
        !identifier(value.sessionId) ||
        !identifier(value.sourceId) ||
        !identifier(value.accessId)
      )
        throw new Error('invalid scope');
      const snapshot = serialize(value.result);
      insert.run(
        time(),
        value.sessionId,
        value.sourceId,
        value.accessId,
        snapshot.number,
        snapshot.host,
        snapshot.path,
        snapshot.json,
      );
    },
    latest(value: Page): Filtered['snapshot'] | null {
      if (
        !value ||
        !identifier(value.sourceId) ||
        !identifier(value.accessId) ||
        typeof value.host !== 'string' ||
        typeof value.path !== 'string'
      )
        throw new Error('invalid scope');
      const row = latest.get(value.sourceId, value.accessId, value.host, value.path);
      return row ? (JSON.parse(row.snapshot_json as string) as Filtered['snapshot']) : null;
    },
    prune(): void {
      const now = time();
      if (now < lastPruneAt) return;
      prune.run(now - retentionMs, `CREATE TABLE text_snapshots ${columns}`);
      lastPruneAt = now;
    },
  };
}

exports.createTextSnapshotStore = create;
