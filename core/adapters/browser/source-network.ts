import type { CDPSession } from 'playwright-core';
type Session = Pick<CDPSession, 'send' | 'on'>;
type Send = (...args: Parameters<Session['send']>) => Promise<unknown>;
type Events = {
  'Page.frameAttached': { frameId: string };
  'Page.frameDetached': { frameId: string; reason: string };
  'Page.frameNavigated': { frame: { id: string; parentId?: string } };
  'Fetch.requestPaused': {
    requestId: string;
    request: { url: string };
    frameId: string;
    resourceType: string;
    responseStatusCode?: number;
    responseErrorReason?: string;
  };
  'Target.receivedMessageFromTarget': { sessionId: string; message: string };
  'Target.detachedFromTarget': { sessionId: string };
  'Target.attachedToTarget': {
    sessionId: string;
    targetInfo: { targetId: string; type: string };
    waitingForDebugger: boolean;
  };
};
type Listen = <E extends keyof Events>(event: E, listener: (value: Events[E]) => void) => void;
type Pending = { resolve(value: unknown): void; reject(): void };
type Child = {
  receive(message: string): void;
  close(): void;
};

const deadlineMs = 5000;
const boundaryError = () => new Error('source-network');

async function timed<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(boundaryError()), deadlineMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function childSession(parent: Send, sessionId: string) {
  const pending = new Map<number, Pending>();
  const listeners = new Map<string, (value: never) => void>();
  let serial = 0;
  let closed = false;
  const send: Send = async (method, params) => {
    if (closed) throw boundaryError();
    const id = ++serial;
    try {
      return await timed(
        new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject: () => reject(boundaryError()) });
          void parent('Target.sendMessageToTarget', {
            sessionId,
            message: JSON.stringify({ id, method, params }),
          }).catch(() => reject(boundaryError()));
        }),
      );
    } finally {
      pending.delete(id);
    }
  };
  const on: Listen = (event, listener) => {
    listeners.set(event, listener);
  };
  return {
    send,
    on,
    receive(message: string) {
      const packet = JSON.parse(message) as {
        id?: number;
        method?: string;
        params?: never;
        error?: unknown;
        result?: unknown;
      };
      if (typeof packet.id === 'number') {
        const reply = pending.get(packet.id);
        if (packet.error) reply?.reject();
        else reply?.resolve(packet.result);
      } else if (packet.method !== undefined && packet.params !== undefined) {
        listeners.get(packet.method)?.(packet.params);
      }
    },
    close() {
      closed = true;
      for (const reply of pending.values()) reply.reject();
      pending.clear();
      listeners.clear();
    },
  };
}

async function protect(
  session: Session,
  origin: string,
  active: () => boolean,
  revoke: () => void,
): Promise<void> {
  const rootSend: Send = session.send.bind(session);
  const rootOn: Listen = (event, listener) => session.on(event, listener);
  const { frameTree } = await timed(session.send('Page.getFrameTree'));
  const rootId = frameTree?.frame?.id;
  if (!rootId || frameTree.frame.url !== 'about:blank' || frameTree.childFrames?.length)
    throw boundaryError();

  async function guard(send: Send, on: Listen, frameId: string | undefined) {
    const children = new Map<string, Child>();
    const descendants = new Set<string>();
    if (frameId) {
      on('Page.frameAttached', (event) => descendants.add(event.frameId));
      on('Page.frameDetached', (event) => {
        if (event.reason !== 'swap') descendants.delete(event.frameId);
      });
      on('Page.frameNavigated', ({ frame }) => {
        if (!frame.parentId && frame.id !== frameId && active()) revoke();
      });
    }
    on('Fetch.requestPaused', (event) => {
      const { requestId, request, frameId: id, resourceType } = event;
      let allowed = false;
      try {
        const destination = new URL(request.url);
        allowed =
          active() &&
          event.responseStatusCode === undefined &&
          event.responseErrorReason === undefined &&
          destination.protocol === 'https:' &&
          !destination.username &&
          !destination.password &&
          (resourceType !== 'Document' ||
            (id === rootId
              ? destination.origin === origin
              : id === frameId || descendants.has(id)));
      } catch {
        // Uninspectable requests remain refused.
      }
      // Fetch pauses each hop at request time, before the loader can proceed.
      void (
        allowed
          ? send('Fetch.continueRequest', { requestId })
          : send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
      ).catch(() => {
        // Requests can disappear while paused. A failed continuation cannot permit one.
      });
    });
    on('Target.receivedMessageFromTarget', ({ sessionId, message }) => {
      try {
        children.get(sessionId)?.receive(message);
      } catch {
        if (active()) revoke();
      }
    });
    on('Target.detachedFromTarget', ({ sessionId }) => {
      children.get(sessionId)?.close();
      children.delete(sessionId);
    });
    on('Target.attachedToTarget', ({ sessionId, targetInfo, waitingForDebugger }) => {
      if (!active()) return;
      const isFrame = targetInfo.type === 'iframe';
      if (!isFrame && targetInfo.type !== 'worker') {
        revoke();
        return;
      }
      const child = childSession(send, sessionId);
      children.set(sessionId, child);
      void (async () => {
        await guard(child.send, child.on, isFrame ? targetInfo.targetId : undefined);
        if (active() && waitingForDebugger) await child.send('Runtime.runIfWaitingForDebugger');
      })().catch(() => {
        if (active() && children.get(sessionId) === child) revoke();
      });
    });
    if (frameId) {
      await timed(send('Page.enable'));
      await timed(send('Network.setBypassServiceWorker', { bypass: true }));
      // Chrome exposes a dedicated worker's requests through the owning frame's Fetch domain.
      await timed(
        send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }),
      );
    }
    // Related targets can have separate loaders. Attach and install the guard before resuming them.
    await timed(
      send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: false,
      }),
    );
  }
  session.on('close', () => {
    if (active()) revoke();
  });
  await guard(rootSend, rootOn, rootId);
}

export declare const protectSourceNetwork: typeof protect;
declare const exports: { protectSourceNetwork: typeof protect };
exports.protectSourceNetwork = protect;
