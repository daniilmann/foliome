export type BrowserEvent = Readonly<{
  sessionId: string; sourceId: string; accessId: string; stepNumber: number;
  kind: 'main-frame-navigation' | 'non-get-request';
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'other';
  // host and path are supplied by the trusted address filter.
  host: string; path: string;
}>;

export interface PreparationPorts<Result> {
  openSource(): Promise<void>;
  closeSource(): Promise<void>;
  saveVerdict(): Promise<void>;
  read(): Promise<Result>;
  saveOutcome(value: Result): Promise<void>;
  saveBrowserEvent?(event: BrowserEvent): Promise<void>;
  protocolUnavailable?(code: 'protocol-unavailable'): Promise<void>;
}

type Session = {
  sessionId?: string;
  ready: boolean;
  inFlight: boolean;
  snapshot?: string;
  snapshotGeneration: number;
};

export declare const createPreparationSession: typeof buildPreparationSession;
declare const exports: { createPreparationSession: typeof buildPreparationSession };

function buildPreparationSession<Result>(ports: PreparationPorts<Result>) {
  let current: Session | undefined;
  let lifecycle: Promise<void> = Promise.resolve();
  let unavailable = false;

  function enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = lifecycle.then(operation);
    lifecycle = pending.catch(() => {});
    return pending;
  }

  function closeSession(session: Session): Promise<void> {
    if (current !== session) return Promise.resolve();
    current = undefined;
    return enqueue(async () => {
      try {
        await ports.closeSource();
      } catch {
        unavailable = true;
        throw new Error("source-close-failed");
      }
    });
  }

  async function open(sessionId?: string): Promise<void> {
    if (current || unavailable) throw new Error("session-unavailable");
    const session: Session = { sessionId, ready: false, inFlight: false, snapshotGeneration: 0 };
    current = session;
    try {
      await enqueue(async () => {
        if (unavailable) throw new Error("session-unavailable");
        await ports.openSource();
      });
      if (current !== session) throw new Error("session-revoked");
      session.ready = true;
    } catch {
      if (current === session) {
        try {
          await closeSession(session);
        } catch {
          // The source remains unavailable after a failed close.
        }
      }
      throw new Error("session-open-failed");
    }
  }

  function bindSnapshot(snapshot: string): void {
    if (!current?.ready) throw new Error("session-unavailable");
    if (typeof snapshot !== "string" || !snapshot) throw new Error("snapshot-invalid");
    current.snapshot = snapshot;
    current.snapshotGeneration++;
  }

  function close(): Promise<void> {
    return current ? closeSession(current) : lifecycle;
  }

  async function record(session: Session, operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch {
      if (current === session) {
        const closing = closeSession(session);
        try {
          await closing;
        } catch {
          // A failed close already makes the source unavailable.
        }
        try {
          await ports.protocolUnavailable?.('protocol-unavailable');
        } catch {
          // Notification failure must not expose its contents or restore the session.
        }
      }
      throw new Error('protocol-unavailable');
    }
  }

  async function recordBrowserEvent(event: BrowserEvent): Promise<void> {
    const session = current;
    if (!session?.ready) throw new Error('session-unavailable');
    if (!session.sessionId || event.sessionId !== session.sessionId) {
      throw new Error('session-unavailable');
    }
    await record(session, async () => {
      if (!ports.saveBrowserEvent) throw new Error('protocol-unavailable');
      await ports.saveBrowserEvent(event);
    });
    if (current !== session) throw new Error('session-revoked');
  }

  async function readForVerdict(snapshot: string): Promise<Result> {
    const session = current;
    if (!session?.ready || session.inFlight || !session.snapshot || session.snapshot !== snapshot) {
      throw new Error("session-unavailable");
    }
    session.inFlight = true;
    const generation = session.snapshotGeneration;
    const assertCurrent = () => {
      if (current !== session || session.snapshotGeneration !== generation) {
        throw new Error("session-revoked");
      }
    };
    try {
      await record(session, () => ports.saveVerdict());
      assertCurrent();
      const result = await ports.read();
      await record(session, () => ports.saveOutcome(result));
      assertCurrent();
      return result;
    } finally {
      session.inFlight = false;
    }
  }

  return { open, bindSnapshot, close, readForVerdict, recordBrowserEvent };
}

exports.createPreparationSession = buildPreparationSession;
