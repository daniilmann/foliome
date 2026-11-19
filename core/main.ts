const { randomUUID } = require('node:crypto') as typeof import('node:crypto');
import type { prepareDomCollector } from './adapters/browser/collect-dom.ts';
import type { createActionProtocol, LogProtocolEvent } from './adapters/store/action-protocol.ts';
import type { createTextSnapshotStore } from './adapters/store/text-snapshot-store.ts';
import type { DenialBudget } from './domain/action-verdict.ts';
const { captureCabinetSnapshot } =
  require('./adapters/browser/capture-snapshot.ts') as typeof import('./adapters/browser/capture-snapshot.ts');
const { createPreparationMcp } =
  require('./adapters/channel/preparation-mcp.ts') as typeof import('./adapters/channel/preparation-mcp.ts');
const { createControlledRead } =
  require('./use-cases/controlled-read.ts') as typeof import('./use-cases/controlled-read.ts');

type Collector = Awaited<ReturnType<typeof prepareDomCollector>>;
type Browser = Pick<
  Collector,
  | 'collectFrame'
  | 'observeTargets'
  | 'readObservedTarget'
  | 'loginObservations'
  | 'finishLoginObservation'
> & {
  openSource(sessionId: string): Promise<void>;
  closeSource(): Promise<void>;
  capturePng(viewport?: import('./adapters/browser/capture-snapshot.ts').Viewport): Promise<Buffer>;
};
type Ports = {
  browser: Browser;
  protocol: ReturnType<typeof createActionProtocol>;
  store: ReturnType<typeof createTextSnapshotStore>;
  now(): number;
  sleep(ms: number): Promise<void>;
  executorRunning(): boolean;
  protocolUnavailable?(): void;
  actionDenialLimit?(): void;
};
type Scope = { sessionId: string; sourceId: string; accessId: string; instruction: string };
type Session = {
  sessionId: string;
  ready: boolean;
  confirmed: boolean;
  number: number;
  busy: boolean;
  denials?: Record<DenialBudget, number>;
  observation?: Awaited<ReturnType<Collector['observeTargets']>> &
    Pick<Scope, 'sessionId' | 'sourceId' | 'accessId'>;
};
export declare const createPreparationRuntime: typeof create;
declare const exports: {
  createPreparationRuntime: typeof create;
  createInstalledKernel: typeof createInstalled;
};

function create(ports: Ports, scope: Scope) {
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* UI failures do not affect the protocol. */
      }
    }
  };
  const rows = Object.assign(() => ports.protocol.list(), {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  let current: Session | undefined;
  let lifecycle: Promise<void> = Promise.resolve();
  let failed = false;
  let lifecyclePending = false;
  let epoch = 0;
  const unavailable = () => ({ ok: false as const, code: 'session-unavailable' as const });
  function revoke(session: Session, notify?: () => void) {
    if (current !== session) return;
    const closing = closeSource();
    try {
      notify?.();
    } catch {
      /* Revocation is mandatory even if notification fails. */
    }
    return closing.catch(() => {});
  }
  function revokeForProtocol(session: Session) {
    return revoke(session, ports.protocolUnavailable);
  }
  function recordLogUnavailable(sessionId: string, code: LogProtocolEvent['code']): boolean {
    const session = current;
    if (session?.sessionId !== sessionId) return true;
    try {
      ports.protocol.appendLogEvent({ sessionId, code });
      changed();
      return true;
    } catch {
      revokeForProtocol(session);
      return false;
    }
  }
  function bindBrowserEvents() {
    const session = current;
    return (
      event: Omit<
        import('./use-cases/preparation.ts').BrowserEvent,
        'sessionId' | 'sourceId' | 'accessId' | 'stepNumber'
      >,
    ) => {
      if (!session || current !== session) return false;
      try {
        ports.protocol.appendBrowserEvent({
          ...event,
          sessionId: session.sessionId,
          sourceId: scope.sourceId,
          accessId: scope.accessId,
          stepNumber: session.number + 1,
        });
        return true;
      } catch {
        revokeForProtocol(session);
        return false;
      }
    };
  }
  function closeSource(): Promise<void> {
    if (!current) return lifecycle;
    delete current.denials;
    delete current.observation;
    current = undefined;
    lifecyclePending = true;
    lifecycle = lifecycle
      .then(() => ports.browser.closeSource())
      .catch(() => {
        failed = true;
        throw new Error('source-close-failed');
      });
    void lifecycle
      .finally(() => {
        lifecyclePending = false;
      })
      .catch(() => {});
    return lifecycle;
  }
  async function open() {
    if (current || failed || lifecyclePending) throw new Error('session-unavailable');
    if (!Number.isSafeInteger(epoch + 1)) throw new Error('session-unavailable');
    epoch++;
    const sessionId = epoch === 1 ? scope.sessionId : randomUUID();
    const session: Session = {
      sessionId,
      ready: false,
      confirmed: false,
      number: 0,
      busy: false,
      denials: { hard: 0, label: 0 },
    };
    current = session;
    try {
      const opening = lifecycle.then(async () => {
        if (current !== session || failed) throw new Error('session-unavailable');
        await ports.browser.openSource(sessionId);
      });
      lifecycle = opening.catch(() => {});
      await opening;
      if (current !== session) throw new Error('session-unavailable');
      session.ready = true;
      return session.sessionId;
    } catch (error) {
      if (current === session) await closeSource();
      throw error;
    }
  }
  function confirmLogin(id: string): boolean {
    const session = current;
    if (!session?.ready || session.confirmed || id !== session.sessionId) return false;
    try {
      ports.browser.finishLoginObservation();
      session.confirmed = true;
      return true;
    } catch {
      return false;
    }
  }
  function active(session: Session) {
    return current === session && session.ready && session.confirmed && ports.executorRunning();
  }
  async function capture(session: Session, number: number) {
    return captureCabinetSnapshot(
      {
        collect: () => ports.browser.collectFrame(number),
        capturePng: (viewport) => ports.browser.capturePng(viewport),
        now: ports.now,
        sleep: ports.sleep,
        recordDeviation: async (entry) => {
          if (!active(session)) throw new Error('session-revoked');
          ports.protocol.appendSnapshotDeviation({
            ...scope,
            sessionId: session.sessionId,
            ...entry,
          });
        },
      },
      () => ({
        sessionId: session.sessionId,
        sessionActive: active(session),
        loginStep: !session.confirmed,
        ...(active(session)
          ? ports.browser.loginObservations()
          : { manualInputSeen: false, hasKnownSecret: false }),
        hasNonEmptyFields: false,
        completion: session.confirmed
          ? { sessionId: session.sessionId, source: 'trusted-adapter' as const, confirmed: true }
          : null,
      }),
      5000,
    );
  }
  async function persist(
    session: Session,
    result: Extract<Awaited<ReturnType<typeof capture>>, { ok: true }>,
  ) {
    if (!active(session)) throw new Error('session-revoked');
    const observed = result.binding;
    if (!observed || observed.snapshotNumber !== result.snapshot.snapshot)
      throw new Error('internal');
    ports.store.append({
      ...scope,
      sessionId: session.sessionId,
      result: { ok: true, snapshot: result.snapshot },
    });
    session.number = result.snapshot.snapshot;
    session.observation = {
      ...observed,
      sessionId: session.sessionId,
      sourceId: scope.sourceId,
      accessId: scope.accessId,
    };
  }
  async function snapshot(session: Session) {
    if (!active(session) || session.busy) return unavailable();
    if (!Number.isSafeInteger(session.number + 1))
      return { ok: false as const, code: 'limit' as const };
    session.busy = true;
    try {
      const result = await capture(session, session.number + 1);
      if (!result.ok) {
        if (result.code === 'protocol-unavailable') revokeForProtocol(session);
        return result;
      }
      await persist(session, result);
      if (!active(session)) return unavailable();
      return { ok: true as const, snapshot: result.snapshot, image: result.image };
    } catch {
      return { ok: false as const, code: 'internal' as const };
    } finally {
      session.busy = false;
    }
  }
  async function observeSnapshot() {
    const session = current;
    if (!session?.ready) return unavailable();
    if (!session.confirmed) {
      ports.browser.loginObservations();
      return { ok: false as const, code: 'login-step' as const };
    }
    return snapshot(session);
  }
  function createHandler() {
    let pinned: Session | undefined = current;
    const expectedEpoch = current ? epoch : epoch + 1;
    let revoked = !current && lifecyclePending;
    const get = () => {
      if (revoked || epoch > expectedEpoch) {
        revoked = true;
        return undefined;
      }
      if (!pinned && current?.ready) pinned = current;
      if (pinned && current !== pinned) {
        revoked = true;
        return undefined;
      }
      return pinned && active(pinned) ? pinned : undefined;
    };
    return createPreparationMcp({
      async unsupported() {
        const session = get();
        if (!session || !session.observation || session.number < 1) return;
        try {
          ports.protocol.appendVerdict({
            ...scope,
            sessionId: session.sessionId,
            snapshotNumber: session.number,
            nodeNumber: null,
            method: 'other',
            actionClass: 'unknown',
            decision: 'blocked',
            reason: 'unsupported',
          });
          changed();
        } catch {
          revokeForProtocol(session);
          return { ok: false as const, code: 'protocol-unavailable' as const };
        }
      },
      async getTask() {
        return get()
          ? {
              ok: true,
              task: {
                type: 'preparation',
                sourceId: scope.sourceId,
                instruction: scope.instruction,
              },
            }
          : unavailable();
      },
      async getSnapshot() {
        const session = get();
        return session ? snapshot(session) : unavailable();
      },
      async readText(args) {
        const session = get();
        if (!session || session.busy || !session.observation) return unavailable();
        session.busy = true;
        try {
          const collectTarget = Object.assign(
            async (n: number) => ({
              ...(await ports.browser.observeTargets(n)),
              sessionId: session.sessionId,
              sourceId: scope.sourceId,
              accessId: scope.accessId,
            }),
            {
              read: (
                n: number,
                node: number,
                proof: { identity: string; descriptor: string },
                deep?: boolean,
              ) => ports.browser.readObservedTarget(n, node, proof, deep),
            },
          );
          const reader = createControlledRead({
            getSession: () =>
              active(session)
                ? {
                    ...scope,
                    sessionId: session.sessionId,
                    sessionActive: true,
                    loginStep: !session.confirmed,
                    snapshotNumber: session.number,
                  }
                : undefined,
            collectTarget,
            captureSnapshot: (n) => capture(session, n),
            persistSnapshot: async (result) => {
              await persist(session, result);
            },
            protocol: ports.protocol,
            onProtocolUnavailable: () => revokeForProtocol(session),
            denialBudget: {
              record(id, kind) {
                if (id !== session.sessionId || !active(session) || !session.denials)
                  throw new Error('session-unavailable');
                const maximum = kind === 'hard' ? 3 : 10;
                return ++session.denials[kind] === maximum;
              },
            },
            revokeSession: (id) => {
              if (id === session.sessionId) return revoke(session, ports.actionDenialLimit);
            },
          });
          const result = await reader.read(
            { method: 'readText', actionClass: 'read', ...args },
            session.observation,
          );
          changed();
          if (!result.ok) return result;
          return {
            ok: true as const,
            text: result.data.text ?? '',
            snapshot: result.data.snapshot,
            image: result.data.image,
          };
        } catch {
          return { ok: false as const, code: 'internal' as const };
        } finally {
          session.busy = false;
        }
      },
    });
  }
  return {
    open,
    closeSource,
    shutdown: closeSource,
    confirmLogin,
    observeSnapshot,
    createHandler,
    rows,
    logEvents: () => ports.protocol.listLogEvents(),
    recordLogUnavailable,
    bindBrowserEvents,
  };
}
exports.createPreparationRuntime = create;

const { createInstalledKernel: createInstalled } =
  require('./adapters/installed-kernel.ts') as typeof import('./adapters/installed-kernel.ts');
export declare const createInstalledKernel: typeof createInstalled;
exports.createInstalledKernel = createInstalled;
