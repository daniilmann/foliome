import type { DatabaseSync } from 'node:sqlite';
import type { BrowserEvent } from '../../use-cases/preparation.ts';
import type { SnapshotDeviationFlag } from '../browser/capture-snapshot.ts';

type Reason = 'allowed' | 'unsupported' | 'not-declared' | 'value-not-allowed' | 'not-found' |
  'ambiguous' | 'hidden' | 'disabled' | 'covered' | 'stale' | 'foreign-frame' | 'foreign-host' |
  'bad-url' | 'form-repeat' | 'popup-blocked' | 'download-refused' | 'secret-field' |
  'unclassified' | 'blocked-payment' | 'blocked-change' | 'limit' | 'internal';
type Verdict = Readonly<{
  sessionId: string; sourceId: string; accessId: string;
  snapshotNumber: number; nodeNumber: number | null;
  method: 'readText' | 'other'; actionClass: 'read' | 'unknown';
  decision: 'allowed' | 'blocked'; reason: Reason;
}>;
type Outcome = Readonly<{ verdictId: number; status: 'ok' | 'stale' | 'internal' | 'limit' }>;
type Clock = () => number;
type SnapshotDeviation = Readonly<{
  sessionId: string; sourceId: string; accessId: string; snapshotNumber: number;
  host: string; path: string; code: 'retake' | 'unstable' | 'limit' | 'error';
  flags: readonly SnapshotDeviationFlag[]; retakes: number; elapsedMs: number;
}>;
const flagOrder: readonly SnapshotDeviationFlag[] = ['flow', 'rectangles', 'animations', 'observer', 'visualViewport'];

export declare const createActionProtocol: typeof create;
declare const exports: { createActionProtocol: typeof create };

const reasons = new Set<Reason>([
  'allowed', 'unsupported', 'not-declared', 'value-not-allowed', 'not-found', 'ambiguous',
  'hidden', 'disabled', 'covered', 'stale', 'foreign-frame', 'foreign-host', 'bad-url',
  'form-repeat', 'popup-blocked', 'download-refused', 'secret-field', 'unclassified',
  'blocked-payment', 'blocked-change', 'limit', 'internal',
]);

function integer(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function create(database: DatabaseSync, clock: Clock) {
  database.exec('PRAGMA foreign_keys = ON');
  if (database.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) {
    throw new Error('foreign keys unavailable');
  }
  database.exec('SAVEPOINT action_protocol_schema');
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS action_verdicts (
        id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 9007199254740991),
        at_ms INTEGER NOT NULL CHECK (at_ms BETWEEN 0 AND 9007199254740991),
        session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 128 AND session_id NOT GLOB '*[^A-Za-z0-9_-]*'),
        source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 128 AND source_id NOT GLOB '*[^A-Za-z0-9_-]*'),
        access_id TEXT NOT NULL CHECK (length(access_id) BETWEEN 1 AND 128 AND access_id NOT GLOB '*[^A-Za-z0-9_-]*'),
        snapshot_number INTEGER NOT NULL CHECK (snapshot_number BETWEEN 1 AND 9007199254740991),
        node_number INTEGER CHECK (node_number BETWEEN 1 AND 9007199254740991),
        method TEXT NOT NULL CHECK (method IN ('readText', 'other')),
        action_class TEXT NOT NULL CHECK (action_class IN ('read', 'unknown')),
        actor TEXT NOT NULL CHECK (actor = 'agent'),
        decision TEXT NOT NULL CHECK (decision IN ('allowed', 'blocked')),
        reason TEXT NOT NULL CHECK (reason IN ('allowed', 'unsupported', 'not-declared', 'value-not-allowed',
          'not-found', 'ambiguous', 'hidden', 'disabled', 'covered', 'stale', 'foreign-frame', 'foreign-host',
          'bad-url', 'form-repeat', 'popup-blocked', 'download-refused', 'secret-field', 'unclassified',
          'blocked-payment', 'blocked-change', 'limit', 'internal')),
        CHECK ((decision = 'allowed' AND reason = 'allowed' AND node_number IS NOT NULL
          AND method = 'readText' AND action_class = 'read')
          OR (decision = 'blocked' AND reason <> 'allowed'))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS action_outcomes (
        verdict_id INTEGER PRIMARY KEY REFERENCES action_verdicts(id),
        at_ms INTEGER NOT NULL CHECK (at_ms BETWEEN 0 AND 9007199254740991),
        status TEXT NOT NULL CHECK (status IN ('ok', 'stale', 'internal', 'limit'))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS action_browser_events (
        id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 9007199254740991),
        at_ms INTEGER NOT NULL CHECK (at_ms BETWEEN 0 AND 9007199254740991),
        session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 128 AND session_id NOT GLOB '*[^A-Za-z0-9_-]*'),
        source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 128 AND source_id NOT GLOB '*[^A-Za-z0-9_-]*'),
        access_id TEXT NOT NULL CHECK (length(access_id) BETWEEN 1 AND 128 AND access_id NOT GLOB '*[^A-Za-z0-9_-]*'),
        step_number INTEGER NOT NULL CHECK (step_number BETWEEN 1 AND 9007199254740991),
        kind TEXT NOT NULL CHECK (kind IN ('main-frame-navigation', 'non-get-request')),
        method TEXT NOT NULL CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'other')),
        host TEXT NOT NULL CHECK (length(host) BETWEEN 1 AND 253),
        path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 2048)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS action_snapshot_deviations (
        id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 9007199254740991),
        at_ms INTEGER NOT NULL CHECK (at_ms BETWEEN 0 AND 9007199254740991),
        session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 128 AND session_id NOT GLOB '*[^A-Za-z0-9_-]*'),
        source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 128 AND source_id NOT GLOB '*[^A-Za-z0-9_-]*'),
        access_id TEXT NOT NULL CHECK (length(access_id) BETWEEN 1 AND 128 AND access_id NOT GLOB '*[^A-Za-z0-9_-]*'),
        snapshot_number INTEGER NOT NULL CHECK (snapshot_number BETWEEN 1 AND 9007199254740991),
        host TEXT NOT NULL CHECK (length(host) BETWEEN 1 AND 253),
        path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 2048),
        code TEXT NOT NULL CHECK (code IN ('retake', 'unstable', 'limit', 'error')),
        flags TEXT NOT NULL CHECK (json_valid(flags) AND json_type(flags) = 'array'),
        retakes INTEGER NOT NULL CHECK (retakes BETWEEN 0 AND 9007199254740991),
        elapsed_ms INTEGER NOT NULL CHECK (elapsed_ms BETWEEN 0 AND 9007199254740991)
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS action_verdicts_no_update BEFORE UPDATE ON action_verdicts BEGIN SELECT RAISE(ABORT, 'append only'); END;
      CREATE TRIGGER IF NOT EXISTS action_verdicts_no_delete BEFORE DELETE ON action_verdicts BEGIN SELECT RAISE(ABORT, 'append only'); END;
      CREATE TRIGGER IF NOT EXISTS action_verdicts_no_replace BEFORE INSERT ON action_verdicts WHEN EXISTS (SELECT 1 FROM action_verdicts WHERE id = NEW.id) BEGIN SELECT RAISE(ABORT, 'append only'); END;
      CREATE TRIGGER IF NOT EXISTS action_outcomes_no_update BEFORE UPDATE ON action_outcomes BEGIN SELECT RAISE(ABORT, 'append only'); END;
      CREATE TRIGGER IF NOT EXISTS action_outcomes_no_delete BEFORE DELETE ON action_outcomes BEGIN SELECT RAISE(ABORT, 'append only'); END;
      CREATE TRIGGER IF NOT EXISTS action_outcomes_no_replace BEFORE INSERT ON action_outcomes WHEN EXISTS (SELECT 1 FROM action_outcomes WHERE verdict_id = NEW.verdict_id) BEGIN SELECT RAISE(ABORT, 'append only'); END;
      CREATE TRIGGER IF NOT EXISTS action_browser_events_no_update BEFORE UPDATE ON action_browser_events BEGIN SELECT RAISE(ABORT, 'append only'); END;
      CREATE TRIGGER IF NOT EXISTS action_browser_events_no_delete BEFORE DELETE ON action_browser_events BEGIN SELECT RAISE(ABORT, 'append only'); END;
      CREATE TRIGGER IF NOT EXISTS action_browser_events_no_replace BEFORE INSERT ON action_browser_events WHEN EXISTS (SELECT 1 FROM action_browser_events WHERE id = NEW.id) BEGIN SELECT RAISE(ABORT, 'append only'); END;
      CREATE TRIGGER IF NOT EXISTS action_snapshot_deviations_no_update BEFORE UPDATE ON action_snapshot_deviations BEGIN SELECT RAISE(ABORT, 'append only'); END;
      CREATE TRIGGER IF NOT EXISTS action_snapshot_deviations_no_delete BEFORE DELETE ON action_snapshot_deviations BEGIN SELECT RAISE(ABORT, 'append only'); END;
      CREATE TRIGGER IF NOT EXISTS action_snapshot_deviations_no_replace BEFORE INSERT ON action_snapshot_deviations WHEN EXISTS (SELECT 1 FROM action_snapshot_deviations WHERE id = NEW.id) BEGIN SELECT RAISE(ABORT, 'append only'); END;
    `);
    database.exec('RELEASE action_protocol_schema');
  } catch (error) {
    database.exec('ROLLBACK TO action_protocol_schema');
    database.exec('RELEASE action_protocol_schema');
    throw error;
  }
  const insertVerdict = database.prepare(`INSERT INTO action_verdicts
    (at_ms, session_id, source_id, access_id, snapshot_number, node_number, method, action_class, actor, decision, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'agent', ?, ?)`);
  const insertOutcome = database.prepare('INSERT INTO action_outcomes (verdict_id, at_ms, status) VALUES (?, ?, ?)');
  const insertBrowserEvent = database.prepare(`INSERT INTO action_browser_events
    (at_ms, session_id, source_id, access_id, step_number, kind, method, host, path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertSnapshotDeviation = database.prepare(`INSERT INTO action_snapshot_deviations
    (at_ms, session_id, source_id, access_id, snapshot_number, host, path, code, flags, retakes, elapsed_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  function time(): number {
    if (database.isTransaction) throw new Error('active transaction');
    const value = clock();
    if (database.isTransaction) throw new Error('active transaction');
    if (!integer(value, 0)) throw new Error('invalid time');
    return value;
  }
  const listRows = database.prepare(`SELECT v.at_ms AS atMs, v.source_id AS sourceId, v.access_id AS accessId,
    v.actor, v.method, v.snapshot_number AS snapshotNumber, v.node_number AS nodeNumber,
    v.decision, v.reason, o.status AS outcome FROM action_verdicts v
    LEFT JOIN action_outcomes o ON o.verdict_id = v.id ORDER BY v.id`);
  return {
    list() {
      return listRows.all() as unknown as readonly { atMs: number; sourceId: string; accessId: string; actor: string; method: string; snapshotNumber: number; nodeNumber: number | null; decision: 'allowed' | 'blocked'; reason: string; outcome: string | null }[];
    },
    appendVerdict(value: Verdict): number {
      if (!identifier(value.sessionId) || !identifier(value.sourceId) || !identifier(value.accessId) ||
        !integer(value.snapshotNumber, 1) || (value.nodeNumber !== null && !integer(value.nodeNumber, 1)) ||
        !['readText', 'other'].includes(value.method) || !['read', 'unknown'].includes(value.actionClass) ||
        !reasons.has(value.reason) ||
        !((value.decision === 'allowed' && value.reason === 'allowed' && value.nodeNumber !== null &&
          value.method === 'readText' && value.actionClass === 'read') ||
          (value.decision === 'blocked' && value.reason !== 'allowed'))) throw new Error('invalid verdict');
      const result = insertVerdict.run(time(), value.sessionId, value.sourceId, value.accessId,
        value.snapshotNumber, value.nodeNumber, value.method, value.actionClass, value.decision, value.reason);
      const id = Number(result.lastInsertRowid);
      if (!integer(id, 1)) throw new Error('invalid verdict id');
      return id;
    },
    appendOutcome(value: Outcome): void {
      if (!integer(value.verdictId, 1) || !['ok', 'stale', 'internal', 'limit'].includes(value.status)) {
        throw new Error('invalid outcome');
      }
      insertOutcome.run(value.verdictId, time(), value.status);
    },
    appendBrowserEvent(value: BrowserEvent): void {
      if (!identifier(value.sessionId) || !identifier(value.sourceId) || !identifier(value.accessId) ||
        !integer(value.stepNumber, 1) || !['main-frame-navigation', 'non-get-request'].includes(value.kind) ||
        !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'other'].includes(value.method) ||
        typeof value.host !== 'string' || value.host.length < 1 || value.host.length > 253 ||
        typeof value.path !== 'string' || value.path.length < 1 || value.path.length > 2048) {
        throw new Error('invalid browser event');
      }
      insertBrowserEvent.run(time(), value.sessionId, value.sourceId, value.accessId,
        value.stepNumber, value.kind, value.method, value.host, value.path);
    },
    appendSnapshotDeviation(value: SnapshotDeviation): void {
      if (!identifier(value.sessionId) || !identifier(value.sourceId) || !identifier(value.accessId) ||
        !integer(value.snapshotNumber, 1) || typeof value.host !== 'string' || value.host.length < 1 || value.host.length > 253 ||
        typeof value.path !== 'string' || value.path.length < 1 || value.path.length > 2048 ||
        !['retake', 'unstable', 'limit', 'error'].includes(value.code) || !Array.isArray(value.flags) ||
        value.flags.some((flag, index) => !flagOrder.includes(flag) || (index > 0 && flagOrder.indexOf(value.flags[index - 1]) >= flagOrder.indexOf(flag))) ||
        !integer(value.retakes, 0) || !integer(value.elapsedMs, 0)) throw new Error('invalid snapshot deviation');
      insertSnapshotDeviation.run(time(), value.sessionId, value.sourceId, value.accessId, value.snapshotNumber,
        value.host, value.path, value.code, JSON.stringify(value.flags), value.retakes, value.elapsedMs);
    },
  };
}

exports.createActionProtocol = create;
