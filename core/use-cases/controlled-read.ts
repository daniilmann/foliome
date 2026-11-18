import type { ActionCandidate, ActionVerdict } from '../domain/action-verdict.ts';
const { decideActionVerdict } = require('../domain/action-verdict.ts') as typeof import('../domain/action-verdict.ts');

type Session = Readonly<{ sessionId: string; sourceId: string; accessId: string; sessionActive: boolean; loginStep: boolean; snapshotNumber: number }>;
type Target = Omit<ActionCandidate, 'sameNode'> & Readonly<{ identity: string; descriptor: string; text: string }>;
type Observation = Readonly<{ snapshotNumber: number; candidates: readonly Target[]; sessionId: string; sourceId: string; accessId: string }>;
type SnapshotResult = { ok: true; snapshot: { snapshot: number }; image: unknown } | { ok: false; code: string };
type Ports = {
  getSession(): Session | undefined;
  collectTarget: ((snapshot: number) => Promise<Observation>) & { read(snapshot: number, node: number, proof: { identity: string; descriptor: string }, deep?: boolean): Promise<{ ok: true; text: string } | { ok: false; code: 'stale' | 'internal' }> };
  captureSnapshot(snapshot: number): Promise<SnapshotResult>;
  persistSnapshot(result: Extract<SnapshotResult, { ok: true }>): Promise<unknown>;
  onProtocolUnavailable(sessionId: string): void;
  protocol: {
    appendVerdict(value: { sessionId: string; sourceId: string; accessId: string; snapshotNumber: number; nodeNumber: number | null; method: 'readText' | 'other'; actionClass: 'read' | 'unknown'; decision: 'allowed' | 'blocked'; reason: Exclude<Extract<ActionVerdict, { ok: false }>['code'], 'session-unavailable'> | 'allowed' | 'internal' }): number | Promise<number>;
    appendOutcome(value: { verdictId: number; status: 'ok' | 'stale' | 'internal' }): void | Promise<void>;
  };
};

export declare const createControlledRead: typeof create;
declare const exports: { createControlledRead: typeof create };

function own(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && 'value' in property ? property.value : undefined;
}
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }

function create(ports: Ports) {
  let inFlight = false;
  async function read(command: unknown, beforeSnapshot: Observation) {
    if (inFlight) return { ok: false as const, code: 'session-unavailable' };
    inFlight = true;
    try {
      const session = ports.getSession();
      if (!session?.sessionActive) return { ok: false as const, code: 'session-unavailable' };
      const active = () => {
        const current = ports.getSession();
        return !!current?.sessionActive && current.sessionId === session.sessionId && current.sourceId === session.sourceId && current.accessId === session.accessId && current.loginStep === session.loginStep;
      };
      if (!positive(session.snapshotNumber) || !beforeSnapshot || beforeSnapshot.sessionId !== session.sessionId ||
          beforeSnapshot.sourceId !== session.sourceId || beforeSnapshot.accessId !== session.accessId ||
          !positive(beforeSnapshot.snapshotNumber) || !Array.isArray(beforeSnapshot.candidates)) return { ok: false as const, code: 'session-unavailable' };
      const snapshotNumber = session.snapshotNumber;
      const requestedNode = own(command, 'nodeNumber');
      let verdict: ActionVerdict = beforeSnapshot.snapshotNumber !== snapshotNumber
        ? { ok: false, code: 'stale' }
        : decideActionVerdict(command, { sessionActive: true, loginStep: session.loginStep, snapshotNumber, candidates: beforeSnapshot.candidates.map(candidate => ({ ...candidate, sameNode: true })) });
      if (verdict.ok) {
        const { nodeNumber } = verdict;
        const previous = beforeSnapshot.candidates.filter(candidate => candidate.nodeNumber === nodeNumber);
        const observed = await ports.collectTarget(snapshotNumber);
        if (!active()) return { ok: false as const, code: 'session-revoked' };
        verdict = ports.getSession()?.snapshotNumber !== snapshotNumber
          ? { ok: false, code: 'stale' }
          : decideActionVerdict(command, { sessionActive: true, loginStep: session.loginStep, snapshotNumber: observed.snapshotNumber, candidates: observed.candidates.map(candidate => ({ ...candidate, sameNode: previous.length === 1 && previous[0].identity === candidate.identity && previous[0].descriptor === candidate.descriptor })) });
      }
      const unavailable = () => {
        if (active()) ports.onProtocolUnavailable(session.sessionId);
        return { ok: false as const, code: 'protocol-unavailable' };
      };
      const protocolFailure = (value: unknown) => typeof value === 'object' && value !== null && own(value, 'code') === 'protocol-unavailable';
      const reason = verdict.ok ? 'allowed' : verdict.code === 'session-unavailable' ? 'internal' : verdict.code;
      let verdictId: number;
      try {
        const pending = ports.protocol.appendVerdict({ sessionId: session.sessionId, sourceId: session.sourceId, accessId: session.accessId, snapshotNumber, nodeNumber: positive(requestedNode) ? requestedNode : null, method: own(command, 'method') === 'readText' ? 'readText' : 'other', actionClass: own(command, 'actionClass') === 'read' ? 'read' : 'unknown', decision: verdict.ok ? 'allowed' : 'blocked', reason });
        if (protocolFailure(pending)) return unavailable();
        const value = await pending;
        if (protocolFailure(value)) return unavailable();
        if (!positive(value)) return unavailable();
        verdictId = value;
      } catch { return unavailable(); }
      if (!active()) return { ok: false as const, code: 'session-revoked' };
      let text: string | undefined;
      if (verdict.ok) {
        let status: 'ok' | 'stale' | 'internal' = 'internal';
        try {
          const previous = beforeSnapshot.candidates.filter(candidate => candidate.nodeNumber === verdict.nodeNumber);
          if (ports.getSession()?.snapshotNumber !== snapshotNumber || previous.length !== 1 || typeof previous[0].identity !== 'string' || typeof previous[0].descriptor !== 'string') status = 'stale';
          else {
            const result = await ports.collectTarget.read(snapshotNumber, verdict.nodeNumber, { identity: previous[0].identity, descriptor: previous[0].descriptor }, verdict.deep);
            if (result.ok && typeof result.text === 'string') { text = result.text; status = 'ok'; }
            else if (!result.ok && result.code === 'stale') status = 'stale';
          }
        } catch { status = 'internal'; }
        try {
          const pending = ports.protocol.appendOutcome({ verdictId, status });
          if (protocolFailure(pending)) return unavailable();
          const value = await pending;
          if (protocolFailure(value)) return unavailable();
        } catch { return unavailable(); }
        if (!active()) return { ok: false as const, code: 'session-revoked' };
        if (status !== 'ok' || text === undefined) return { ok: false as const, code: status };
      }
      if (!Number.isSafeInteger(snapshotNumber + 1)) return { ok: false as const, code: 'limit' };
      let snapshot: SnapshotResult;
      try {
        const pending = ports.captureSnapshot(snapshotNumber + 1);
        if (protocolFailure(pending)) return unavailable();
        snapshot = await pending;
      } catch (error) {
        if (protocolFailure(error)) return unavailable();
        return { ok: false as const, code: 'internal' };
      }
      if (!active()) return { ok: false as const, code: 'session-revoked' };
      if (!snapshot.ok) {
        if (snapshot.code === 'protocol-unavailable') return unavailable();
        return { ok: false as const, code: snapshot.code };
      }
      if (snapshot.snapshot.snapshot !== snapshotNumber + 1) return { ok: false as const, code: 'internal' };
      try {
        const persisted = ports.persistSnapshot(snapshot);
        if (protocolFailure(persisted)) return unavailable();
        const persistedResult = await persisted;
        if (protocolFailure(persistedResult)) return unavailable();
      } catch (error) {
        if (protocolFailure(error)) return unavailable();
        return { ok: false as const, code: 'internal' };
      }
      if (!active()) return { ok: false as const, code: 'session-revoked' };
      if (!verdict.ok) return { ok: false as const, code: verdict.code, snapshot: snapshot.snapshot, image: snapshot.image };
      return { ok: true as const, data: { text, snapshot: snapshot.snapshot, image: snapshot.image } };
    } catch { return { ok: false as const, code: 'internal' }; }
    finally { inFlight = false; }
  }
  return { read };
}
exports.createControlledRead = create;
