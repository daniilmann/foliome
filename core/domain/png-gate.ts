export type PngGateFacts = Readonly<{
  sessionId: string;
  sessionActive: boolean;
  loginStep: boolean;
  manualInputSeen: boolean;
  hasKnownSecret: boolean;
  hasNonEmptyFields: boolean;
  completion: Readonly<{
    sessionId: string;
    source: "trusted-adapter";
    confirmed: boolean;
  }> | null;
  stable: boolean;
  maskApplied: boolean;
  withinLimits: boolean;
}>;

export type PngGateResult =
  | { ok: true }
  | { ok: false; code: "login-step" | "unstable" | "limit" | "error" };

/**
 * The caller supplies kernel-owned session facts. Only the trusted adapter may supply
 * a completion, after observing the authorized transition in that session.
 * The source tag classifies that fact. It carries no proof of origin.
 */
export declare const decidePngGate: typeof decide;
declare const exports: { decidePngGate: typeof decide };

function ownFact(record: unknown, key: string): unknown {
  if (typeof record !== "object" || record === null) return undefined;
  const fact = Object.getOwnPropertyDescriptor(record, key);
  return fact && Object.hasOwn(fact, "value") ? fact.value : undefined;
}

function allowsLoginState(facts: PngGateFacts): boolean {
  const sessionId = ownFact(facts, "sessionId");
  const loginStep = ownFact(facts, "loginStep");
  const manualInputSeen = ownFact(facts, "manualInputSeen");
  const hasKnownSecret = ownFact(facts, "hasKnownSecret");
  const hasNonEmptyFields = ownFact(facts, "hasNonEmptyFields");
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    ownFact(facts, "sessionActive") !== true ||
    typeof loginStep !== "boolean" ||
    typeof manualInputSeen !== "boolean" ||
    typeof hasKnownSecret !== "boolean" ||
    typeof hasNonEmptyFields !== "boolean"
  ) {
    return false;
  }

  const completion = ownFact(facts, "completion");
  if (completion === null) {
    // Login observations persist after navigation until the trusted transition.
    return !manualInputSeen && !hasKnownSecret && !hasNonEmptyFields;
  }
  return (
    ownFact(completion, "sessionId") === sessionId &&
    ownFact(completion, "source") === "trusted-adapter" &&
    ownFact(completion, "confirmed") === true
  );
}

function decide(facts: PngGateFacts): PngGateResult {
  try {
    if (!allowsLoginState(facts)) return { ok: false, code: "login-step" };
    if (ownFact(facts, "stable") !== true) return { ok: false, code: "unstable" };
    if (ownFact(facts, "withinLimits") !== true) return { ok: false, code: "limit" };
    if (ownFact(facts, "maskApplied") !== true) return { ok: false, code: "error" };
    return { ok: true };
  } catch {
    return { ok: false, code: "error" };
  }
}

exports.decidePngGate = decide;
