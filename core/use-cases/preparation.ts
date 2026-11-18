export interface PreparationPorts<Result> {
  openSource(): Promise<void>;
  closeSource(): Promise<void>;
  saveVerdict(): Promise<void>;
  read(): Promise<Result>;
  saveOutcome(value: Result): Promise<void>;
}

type Session = {
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

  async function open(): Promise<void> {
    if (current || unavailable) throw new Error("session-unavailable");
    const session: Session = { ready: false, inFlight: false, snapshotGeneration: 0 };
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
    const record = async (operation: () => Promise<void>) => {
      try {
        await operation();
      } catch {
        try {
          await closeSession(session);
        } catch {
          // A failed close already makes the source unavailable.
        }
        throw new Error("protocol-unavailable");
      }
    };

    try {
      await record(() => ports.saveVerdict());
      assertCurrent();
      const result = await ports.read();
      await record(() => ports.saveOutcome(result));
      assertCurrent();
      return result;
    } finally {
      session.inFlight = false;
    }
  }

  return { open, bindSnapshot, close, readForVerdict };
}

exports.createPreparationSession = buildPreparationSession;
