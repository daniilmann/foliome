type Pending = Readonly<{ sessionId: string; nonce: string }>;
type Completion = Readonly<{
  sessionId: string;
  source: "trusted-adapter";
  confirmed: true;
}>;
type Options = Readonly<{
  ownerFrame: object;
  origin: string;
  endpoint: string;
  complete: (sessionId: string) => boolean;
}>;

export declare const createOwnerLoginConfirmation: typeof create;
declare const exports: { createOwnerLoginConfirmation: typeof create };

function ownField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field && Object.hasOwn(field, "value") ? field.value : undefined;
}

function create({ ownerFrame, origin, endpoint, complete }: Options) {
  let pending: Pending | null = null;
  const usedNonces = new Set<string>();

  function begin(value: Pending): void {
    pending = null;
    try {
      const sessionId = ownField(value, "sessionId");
      const nonce = ownField(value, "nonce");
      if (
        typeof sessionId !== "string" || sessionId.length === 0 ||
        typeof nonce !== "string" || nonce.length === 0 || usedNonces.has(nonce)
      ) return;
      usedNonces.add(nonce);
      pending = { sessionId, nonce };
    } catch {
      // Invalid facts cannot start a confirmation.
    }
  }

  function close(): void {
    pending = null;
  }

  function handle(request: unknown): Completion | null {
    try {
      if (
        pending === null ||
        ownField(request, "method") !== "POST" ||
        ownField(request, "path") !== endpoint ||
        ownField(request, "frame") !== ownerFrame ||
        ownField(request, "origin") !== origin
      ) return null;
      const body = ownField(request, "body");
      if (typeof body !== "object" || body === null) return null;
      const keys = Reflect.ownKeys(body);
      if (keys.length !== 2 || !keys.includes("sessionId") || !keys.includes("nonce")) return null;
      const sessionId = ownField(body, "sessionId");
      const nonce = ownField(body, "nonce");
      if (
        typeof sessionId !== "string" || sessionId.length === 0 ||
        typeof nonce !== "string" || nonce.length === 0 ||
        sessionId !== pending.sessionId || nonce !== pending.nonce
      ) return null;
      pending = null;
      if (complete(sessionId) !== true) return null;
      return { sessionId, source: "trusted-adapter", confirmed: true };
    } catch {
      return null;
    }
  }

  return { begin, close, handle };
}

exports.createOwnerLoginConfirmation = create;
