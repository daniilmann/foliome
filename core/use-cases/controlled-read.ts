import type { ActionCandidate, ActionVerdict, DenialBudget } from '../domain/action-verdict.ts';
const { decideReadPolicy } =
  require('../domain/action-verdict.ts') as typeof import('../domain/action-verdict.ts');

type Session = Readonly<{
  sessionId: string;
  sourceId: string;
  accessId: string;
  sessionActive: boolean;
  loginStep: boolean;
  snapshotNumber: number;
}>;
type Target = Omit<ActionCandidate, 'sameNode'> &
  Readonly<{ identity: string; descriptor: string; text: string }>;
type Observation = Readonly<{
  snapshotNumber: number;
  candidates: readonly Target[];
  sessionId: string;
  sourceId: string;
  accessId: string;
}>;
type Filtered = Extract<
  ReturnType<typeof import('../domain/snapshot-filter.ts').filterTextSnapshot>,
  { ok: true }
>['snapshot'];
type SnapshotResult =
  | {
      ok: true;
      snapshot: Filtered;
      image:
        | { bytes: Buffer; snapshotNumber: number }
        | { code: 'login-step' | 'unstable' | 'limit' | 'error' };
      binding?: { snapshotNumber: number; candidates: Target[] };
    }
  | { ok: false; code: 'internal' | 'protocol-unavailable' | 'session-revoked' };
type Ports = {
  getSession(): Session | undefined;
  collectTarget: ((snapshot: number) => Promise<Observation>) & {
    read(
      snapshot: number,
      node: number,
      proof: { identity: string; descriptor: string },
      deep?: boolean,
    ): Promise<{ ok: true; text: string } | { ok: false; code: 'stale' | 'internal' }>;
  };
  captureSnapshot(snapshot: number): Promise<SnapshotResult>;
  persistSnapshot(result: Extract<SnapshotResult, { ok: true }>): Promise<unknown>;
  onProtocolUnavailable(sessionId: string): void | Promise<void>;
  denialBudget?: { record(sessionId: string, kind: DenialBudget): boolean };
  revokeSession?(sessionId: string): void | Promise<void>;
  protocol: {
    appendVerdict(value: {
      sessionId: string;
      sourceId: string;
      accessId: string;
      snapshotNumber: number;
      nodeNumber: number | null;
      method: 'readText' | 'other';
      actionClass: 'read' | 'unknown';
      decision: 'allowed' | 'blocked';
      reason:
        | Exclude<Extract<ActionVerdict, { ok: false }>['code'], 'session-unavailable'>
        | 'allowed'
        | 'limit'
        | 'internal';
    }): number | Promise<number>;
    appendOutcome(value: {
      verdictId: number;
      status: 'ok' | 'stale' | 'internal';
    }): void | Promise<void>;
  };
};

export declare const createControlledRead: typeof create;
declare const exports: { createControlledRead: typeof create };

function own(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && 'value' in property ? property.value : undefined;
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function create(ports: Ports) {
  let inFlight = false;
  async function read(command: unknown, beforeSnapshot: Observation) {
    if (inFlight) return { ok: false as const, code: 'session-unavailable' as const };
    inFlight = true;
    try {
      const session = ports.getSession();
      if (!session?.sessionActive)
        return { ok: false as const, code: 'session-unavailable' as const };
      const active = () => {
        const current = ports.getSession();
        return (
          !!current?.sessionActive &&
          current.sessionId === session.sessionId &&
          current.sourceId === session.sourceId &&
          current.accessId === session.accessId &&
          current.loginStep === session.loginStep
        );
      };
      if (
        !positive(session.snapshotNumber) ||
        !beforeSnapshot ||
        beforeSnapshot.sessionId !== session.sessionId ||
        beforeSnapshot.sourceId !== session.sourceId ||
        beforeSnapshot.accessId !== session.accessId ||
        !positive(beforeSnapshot.snapshotNumber) ||
        !Array.isArray(beforeSnapshot.candidates)
      )
        return { ok: false as const, code: 'session-unavailable' as const };
      const snapshotNumber = session.snapshotNumber;
      const requestedNode = own(command, 'nodeNumber');
      let verdict: ReturnType<typeof decideReadPolicy> =
        beforeSnapshot.snapshotNumber !== snapshotNumber
          ? { ok: false, code: 'stale' }
          : decideReadPolicy(command, {
              sessionActive: true,
              loginStep: session.loginStep,
              snapshotNumber,
              candidates: beforeSnapshot.candidates.map((candidate) => ({
                ...candidate,
                sameNode: true,
              })),
            });
      // A budgeted denial must still identify the same control in the live observation.
      if (verdict.ok || 'budget' in verdict) {
        const prior = verdict;
        const previous = beforeSnapshot.candidates.filter(
          (candidate) => candidate.nodeNumber === requestedNode,
        );
        const observed = await ports.collectTarget(snapshotNumber);
        if (!active()) return { ok: false as const, code: 'session-revoked' as const };
        verdict =
          ports.getSession()?.snapshotNumber !== snapshotNumber ||
          (observed.sessionId !== undefined && observed.sessionId !== session.sessionId) ||
          (observed.sourceId !== undefined && observed.sourceId !== session.sourceId) ||
          (observed.accessId !== undefined && observed.accessId !== session.accessId)
            ? { ok: false, code: 'stale' }
            : decideReadPolicy(command, {
                sessionActive: true,
                loginStep: session.loginStep,
                snapshotNumber: observed.snapshotNumber,
                candidates: observed.candidates.map((candidate) => ({
                  ...candidate,
                  sameNode:
                    previous.length === 1 &&
                    typeof previous[0].identity === 'string' &&
                    typeof previous[0].descriptor === 'string' &&
                    previous[0].identity === candidate.identity &&
                    previous[0].descriptor === candidate.descriptor,
                })),
              });
        if (
          'budget' in verdict &&
          (!('budget' in prior) || verdict.code !== prior.code || verdict.budget !== prior.budget)
        )
          verdict = { ok: false, code: 'stale' };
        if ('budget' in prior && verdict.ok) verdict = { ok: false, code: 'stale' };
      }
      const unavailable = async () => {
        try {
          if (active()) await ports.onProtocolUnavailable(session.sessionId);
        } catch {
          // The revocation port withdraws the session before releasing resources.
        }
        return { ok: false as const, code: 'protocol-unavailable' as const };
      };
      const protocolFailure = (value: unknown) =>
        typeof value === 'object' &&
        value !== null &&
        own(value, 'code') === 'protocol-unavailable';
      const reason = verdict.ok
        ? 'allowed'
        : verdict.code === 'session-unavailable'
          ? 'internal'
          : verdict.code;
      const entry = {
        sessionId: session.sessionId,
        sourceId: session.sourceId,
        accessId: session.accessId,
        snapshotNumber,
        nodeNumber: positive(requestedNode) ? requestedNode : null,
        method: own(command, 'method') === 'readText' ? ('readText' as const) : ('other' as const),
        actionClass:
          own(command, 'actionClass') === 'read' ? ('read' as const) : ('unknown' as const),
      };
      async function appendVerdict(
        decision: 'allowed' | 'blocked',
        reason: Parameters<Ports['protocol']['appendVerdict']>[0]['reason'],
      ) {
        const pending = ports.protocol.appendVerdict({ ...entry, decision, reason });
        if (protocolFailure(pending)) throw new Error('protocol-unavailable');
        const id = await pending;
        if (!positive(id)) throw new Error('protocol-unavailable');
        return id;
      }
      let verdictId: number;
      try {
        verdictId = await appendVerdict(verdict.ok ? 'allowed' : 'blocked', reason);
      } catch {
        return await unavailable();
      }
      if (!active()) return { ok: false as const, code: 'session-revoked' as const };
      if ('budget' in verdict) {
        if (ports.getSession()?.snapshotNumber !== snapshotNumber)
          return { ok: false as const, code: 'stale' as const };
        if (!ports.denialBudget || !ports.revokeSession) return await unavailable();
        try {
          if (ports.denialBudget.record(session.sessionId, verdict.budget)) {
            await appendVerdict('blocked', 'limit');
            await ports.revokeSession(session.sessionId);
            return { ok: false as const, code: verdict.code };
          }
        } catch {
          return await unavailable();
        }
      }
      let text: string | undefined;
      if (verdict.ok) {
        let status: 'ok' | 'stale' | 'internal' = 'internal';
        try {
          const previous = beforeSnapshot.candidates.filter(
            (candidate) => candidate.nodeNumber === verdict.nodeNumber,
          );
          if (
            ports.getSession()?.snapshotNumber !== snapshotNumber ||
            previous.length !== 1 ||
            typeof previous[0].identity !== 'string' ||
            typeof previous[0].descriptor !== 'string'
          )
            status = 'stale';
          else {
            const result = await ports.collectTarget.read(
              snapshotNumber,
              verdict.nodeNumber,
              { identity: previous[0].identity, descriptor: previous[0].descriptor },
              verdict.deep,
            );
            if (result.ok && typeof result.text === 'string') {
              text = result.text;
              status = 'ok';
            } else if (!result.ok && result.code === 'stale') status = 'stale';
          }
        } catch {
          status = 'internal';
        }
        if (!active()) return { ok: false as const, code: 'session-revoked' as const };
        try {
          const pending = ports.protocol.appendOutcome({ verdictId, status });
          if (protocolFailure(pending)) return await unavailable();
          const value = await pending;
          if (protocolFailure(value)) return await unavailable();
        } catch {
          return await unavailable();
        }
        if (!active()) return { ok: false as const, code: 'session-revoked' as const };
        if (status !== 'ok' || text === undefined)
          return { ok: false as const, code: status === 'ok' ? ('internal' as const) : status };
      }
      if (!Number.isSafeInteger(snapshotNumber + 1))
        return { ok: false as const, code: 'limit' as const };
      let snapshot: SnapshotResult;
      try {
        const pending = ports.captureSnapshot(snapshotNumber + 1);
        if (protocolFailure(pending)) return await unavailable();
        snapshot = await pending;
      } catch (error) {
        if (protocolFailure(error)) return await unavailable();
        return { ok: false as const, code: 'internal' as const };
      }
      if (!active()) return { ok: false as const, code: 'session-revoked' as const };
      if (!snapshot.ok) {
        if (snapshot.code === 'protocol-unavailable') return await unavailable();
        return { ok: false as const, code: snapshot.code };
      }
      if (snapshot.snapshot.snapshot !== snapshotNumber + 1)
        return { ok: false as const, code: 'internal' as const };
      try {
        const persisted = ports.persistSnapshot(snapshot);
        if (protocolFailure(persisted)) return await unavailable();
        const persistedResult = await persisted;
        if (protocolFailure(persistedResult)) return await unavailable();
      } catch (error) {
        if (protocolFailure(error)) return await unavailable();
        return { ok: false as const, code: 'internal' as const };
      }
      if (!active()) return { ok: false as const, code: 'session-revoked' as const };
      if (!verdict.ok)
        return {
          ok: false as const,
          code: verdict.code,
          snapshot: snapshot.snapshot,
          image: snapshot.image,
        };
      return {
        ok: true as const,
        data: { text, snapshot: snapshot.snapshot, image: snapshot.image },
      };
    } catch {
      return { ok: false as const, code: 'internal' as const };
    } finally {
      inFlight = false;
    }
  }
  return { read };
}
exports.createControlledRead = create;
