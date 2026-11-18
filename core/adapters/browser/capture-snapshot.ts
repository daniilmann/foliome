import type { PngGateFacts } from '../../domain/png-gate.ts';
import type { PngPlan } from './png.ts';
import type { prepareDomCollector } from './collect-dom.ts';

type Binding = Awaited<
  ReturnType<Awaited<ReturnType<typeof prepareDomCollector>>['observeTargets']>
>;

const { isDeepStrictEqual } = require('node:util') as typeof import('node:util');
const { filterTextSnapshot } =
  require('../../domain/snapshot-filter.ts') as typeof import('../../domain/snapshot-filter.ts');
const { decidePngGate } =
  require('../../domain/png-gate.ts') as typeof import('../../domain/png-gate.ts');
const { protectPng } = require('./png.ts') as typeof import('./png.ts');

export type Viewport = Readonly<{ x: number; y: number; width: number; height: number }>;
type Session = Omit<PngGateFacts, 'stable' | 'maskApplied' | 'withinLimits'>;
type Frame = Readonly<{
  facts: unknown;
  plan: PngPlan | null;
  binding?: Binding;
  revision: number;
  animationIds: readonly string[];
  viewport?: Viewport;
  viewportStable: boolean;
  maskAnimationActive: boolean;
}>;
type DeviationCode = 'retake' | 'unstable' | 'limit' | 'error';
export type SnapshotDeviationFlag =
  'flow' | 'rectangles' | 'animations' | 'observer' | 'visualViewport';
type Deviation = Readonly<{
  code: DeviationCode;
  flags: readonly SnapshotDeviationFlag[];
  snapshotNumber: number;
  host: string;
  path: string;
  retakes: number;
  elapsedMs: number;
}>;
type Ports = Readonly<{
  collect: () => Promise<Frame>;
  capturePng: (viewport?: Viewport) => Promise<Buffer>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  recordDeviation: (entry: Deviation) => Promise<void>;
}>;
type Filtered = Extract<ReturnType<typeof filterTextSnapshot>, { ok: true }>['snapshot'];
type Image =
  | { code: 'login-step' | 'unstable' | 'limit' | 'error' }
  | { bytes: Buffer; snapshotNumber: number };
type Result =
  | { ok: true; snapshot: Filtered; image: Image; binding?: Binding }
  | { ok: false; code: 'internal' | 'protocol-unavailable' | 'session-revoked' };

export declare const captureCabinetSnapshot: typeof capture;
export declare const captureViewportPng: typeof captureViewport;
declare const exports: {
  captureCabinetSnapshot: typeof capture;
  captureViewportPng: typeof captureViewport;
};

function validViewport(viewport: Viewport): boolean {
  return (
    !!viewport &&
    [viewport.x, viewport.y, viewport.width, viewport.height].every(Number.isSafeInteger) &&
    viewport.x >= 0 &&
    viewport.y >= 0 &&
    viewport.width > 0 &&
    viewport.height > 0 &&
    Number.isSafeInteger(viewport.x + viewport.width) &&
    Number.isSafeInteger(viewport.y + viewport.height)
  );
}

async function captureViewport(
  cdp: { send(method: string, params?: Record<string, unknown>): Promise<unknown> },
  viewport?: Viewport,
): Promise<Buffer> {
  if (!viewport || !validViewport(viewport) || viewport.width > 1600 || viewport.height > 1200)
    throw new Error('viewport');
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { ...viewport, scale: 1 },
  });
  if (
    !result ||
    typeof result !== 'object' ||
    !('data' in result) ||
    typeof result.data !== 'string'
  )
    throw new Error('capture');
  return Buffer.from(result.data, 'base64');
}

class Deadline extends Error {}
class SessionRevoked extends Error {}

async function bounded<T>(call: () => Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) throw new Deadline();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(call),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Deadline()), Math.min(ms, 2_147_483_647));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function validPlan(plan: PngPlan | null): plan is PngPlan {
  return (
    !!plan &&
    Array.isArray(plan.masks) &&
    Array.isArray(plan.labels) &&
    plan.masks.every(
      (r) =>
        r &&
        [r.x, r.y, r.width, r.height].every(Number.isSafeInteger) &&
        r.x >= 0 &&
        r.y >= 0 &&
        r.width > 0 &&
        r.height > 0,
    ) &&
    plan.labels.every(
      (l) =>
        l &&
        [l.x, l.y, l.number].every(Number.isSafeInteger) &&
        l.x >= 0 &&
        l.y >= 0 &&
        l.number > 0,
    )
  );
}

function validFrame(frame: Frame): boolean {
  return (
    !!frame &&
    Number.isSafeInteger(frame.revision) &&
    Array.isArray(frame.animationIds) &&
    frame.animationIds.every((id) => typeof id === 'string') &&
    typeof frame.viewportStable === 'boolean' &&
    typeof frame.maskAnimationActive === 'boolean'
  );
}

async function capture(
  ports: Ports,
  getSession: () => Session,
  deadlineMs: number,
): Promise<Result> {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return { ok: false, code: 'internal' };
  let start: number;
  let sessionId: string;
  try {
    const initial = getSession();
    if (
      !initial ||
      initial.sessionActive !== true ||
      typeof initial.sessionId !== 'string' ||
      !initial.sessionId
    )
      return { ok: false, code: 'session-revoked' };
    sessionId = initial.sessionId;
    start = ports.now();
  } catch {
    return { ok: false, code: 'internal' };
  }
  const currentSession = (): Session | null => {
    const session = getSession();
    return session && session.sessionActive === true && session.sessionId === sessionId
      ? session
      : null;
  };
  const revoked = (): Result => ({ ok: false, code: 'session-revoked' });
  if (!Number.isFinite(start)) return { ok: false, code: 'internal' };
  const wallStart = performance.now();
  const remaining = () =>
    Math.min(deadlineMs - (ports.now() - start), deadlineMs - (performance.now() - wallStart));
  let retakes = 0;
  let flags: readonly SnapshotDeviationFlag[] = [];
  let snapshot: Filtered | undefined;
  let collectingText = false;
  const record = async (code: DeviationCode): Promise<boolean> => {
    if (!snapshot) return false;
    try {
      const elapsed = ports.now() - start;
      if (!Number.isFinite(elapsed)) return false;
      const entry: Deviation = {
        code,
        flags: code === 'retake' || code === 'unstable' ? flags : [],
        snapshotNumber: snapshot.snapshot,
        host: snapshot.page.host,
        path: snapshot.page.path,
        retakes,
        elapsedMs: Math.max(0, Math.floor(elapsed)),
      };
      // Protocol recording gets its own finite bound even when capture time has expired.
      await bounded(() => {
        if (!currentSession()) throw new SessionRevoked();
        return ports.recordDeviation(entry);
      }, deadlineMs);
      return true;
    } catch {
      return false;
    }
  };
  const fail = async (code: 'unstable' | 'limit' | 'error'): Promise<Result> => {
    if (!snapshot) return { ok: false, code: 'internal' };
    const recorded = await record(code);
    if (!currentSession()) return revoked();
    if (!recorded) return { ok: false, code: 'protocol-unavailable' };
    return { ok: true, snapshot, image: { code } };
  };
  try {
    while (true) {
      if (!currentSession()) return revoked();
      collectingText = true;
      const first = await bounded(() => {
        if (!currentSession()) throw new SessionRevoked();
        return ports.collect();
      }, remaining());
      const session = currentSession();
      if (!session) return revoked();
      const filtered = filterTextSnapshot(first.facts);
      if (!filtered.ok) return { ok: false, code: 'internal' };
      collectingText = false;
      snapshot = filtered.snapshot;
      const login = decidePngGate({
        ...session,
        stable: true,
        withinLimits: true,
        maskApplied: true,
      });
      if (!login.ok)
        return login.code === 'login-step'
          ? { ok: true, snapshot, image: { code: 'login-step' } }
          : await fail(login.code);
      if (!validFrame(first) || !validPlan(first.plan)) return await fail('error');
      const baseline = structuredClone(first);
      if (baseline.viewport !== undefined && !validViewport(baseline.viewport))
        return await fail('error');
      if (baseline.viewport && (baseline.viewport.width > 1600 || baseline.viewport.height > 1200))
        return await fail('limit');
      if (!baseline.viewportStable) return await fail('error');
      if (!currentSession()) return revoked();
      const bytes = await bounded(() => {
        if (!currentSession()) throw new SessionRevoked();
        return ports.capturePng(baseline.viewport);
      }, remaining());
      if (!currentSession()) return revoked();
      collectingText = true;
      const second = await bounded(() => {
        if (!currentSession()) throw new SessionRevoked();
        return ports.collect();
      }, remaining());
      const latest = currentSession();
      if (!latest) return revoked();
      const checked = filterTextSnapshot(second.facts);
      if (!checked.ok) return { ok: false, code: 'internal' };
      collectingText = false;
      if (!validFrame(second) || !validPlan(second.plan)) return await fail('error');
      const differences: SnapshotDeviationFlag[] = [];
      if (
        !isDeepStrictEqual(baseline.facts, second.facts) ||
        !isDeepStrictEqual(baseline.binding, second.binding)
      )
        differences.push('flow');
      if (!isDeepStrictEqual(baseline.plan, second.plan)) differences.push('rectangles');
      if (
        baseline.maskAnimationActive ||
        second.maskAnimationActive ||
        !isDeepStrictEqual([...baseline.animationIds].sort(), [...second.animationIds].sort())
      )
        differences.push('animations');
      if (baseline.revision !== second.revision) differences.push('observer');
      if (
        !baseline.viewportStable ||
        !second.viewportStable ||
        !isDeepStrictEqual(baseline.viewport, second.viewport)
      )
        differences.push('visualViewport');
      flags = differences;
      if (flags.length !== 0) {
        retakes++;
        const recorded = await record('retake');
        if (!currentSession()) return revoked();
        if (!recorded) return { ok: false, code: 'protocol-unavailable' };
        if (remaining() <= 300) return await fail('unstable');
        await bounded(() => {
          if (!currentSession()) throw new SessionRevoked();
          return ports.sleep(300);
        }, remaining());
        continue;
      }
      if (!validPlan(baseline.plan)) return await fail('error');
      const protectedImage = protectPng(bytes, baseline.plan, baseline.viewport);
      if (remaining() <= 0) return await fail('unstable');
      if (!protectedImage.ok) return await fail(protectedImage.code);
      const finalSession = currentSession();
      if (!finalSession) return revoked();
      const gate = decidePngGate({
        ...finalSession,
        stable: true,
        withinLimits: true,
        maskApplied: true,
      });
      if (!gate.ok)
        return gate.code === 'login-step'
          ? { ok: true, snapshot, image: { code: 'login-step' } }
          : await fail(gate.code);
      return {
        ok: true,
        snapshot,
        image: { bytes: protectedImage.bytes, snapshotNumber: snapshot.snapshot },
        ...(baseline.binding === undefined ? {} : { binding: baseline.binding }),
      };
    }
  } catch (error) {
    try {
      if (error instanceof SessionRevoked || !currentSession()) return revoked();
      if (collectingText) return { ok: false, code: 'internal' };
      return await fail(error instanceof Deadline ? 'unstable' : 'error');
    } catch {
      return { ok: false, code: 'internal' };
    }
  }
}

exports.captureCabinetSnapshot = capture;

exports.captureViewportPng = captureViewport;
