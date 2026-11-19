import type { Socket } from 'node:net';
import type { createPreparationRuntime } from '../main.ts';
import type { prepareDomCollector } from './browser/collect-dom.ts';
import type { attachOwnerWindow } from './ui/owner-window.ts';

const { connectInstalledOwnerUpdates } =
  require('./update/install.ts') as typeof import('./update/install.ts');
const { randomUUID } = require('node:crypto') as typeof import('node:crypto');
const { mkdir } = require('node:fs/promises') as typeof import('node:fs/promises');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
const { createActionProtocol } =
  require('./store/action-protocol.ts') as typeof import('./store/action-protocol.ts');
const { createTechnicalLog } = require('./technical-log.ts') as typeof import('./technical-log.ts');
const { createTextSnapshotStore } =
  require('./store/text-snapshot-store.ts') as typeof import('./store/text-snapshot-store.ts');
const { createAdmittedChannel } =
  require('./channel/admission.ts') as typeof import('./channel/admission.ts');
const { startExecutor } = require('./executor/start.ts') as typeof import('./executor/start.ts');
const { prepareDomCollector: prepare } =
  require('./browser/collect-dom.ts') as typeof import('./browser/collect-dom.ts');
const { protectSourceNetwork } =
  require('./browser/source-network.ts') as typeof import('./browser/source-network.ts');
const { attachOwnerWindow: attach } =
  require('./ui/owner-window.ts') as typeof import('./ui/owner-window.ts');
const { openSystemSocket, createSocketConfiguration } =
  require('./system/darwin.ts') as typeof import('./system/darwin.ts');

type Collector = Awaited<ReturnType<typeof prepareDomCollector>>;
const { captureViewportPng } =
  require('./browser/capture-snapshot.ts') as typeof import('./browser/capture-snapshot.ts');
type Cdp = Parameters<typeof prepareDomCollector>[0];
type OwnerContext = Parameters<typeof attachOwnerWindow>[0]['context'];
type OwnerPage = Parameters<typeof attachOwnerWindow>[0]['page'];
type Page = OwnerPage & {
  close(): Promise<void>;
  on(event: 'close', listener: () => void): unknown;
};
type Context = OwnerContext & {
  newPage(): Promise<Page>;
  newCDPSession(page: Page): Promise<Cdp & Parameters<typeof protectSourceNetwork>[0]>;
  close(): Promise<void>;
};
type Chrome = {
  newContext(options?: { serviceWorkers: 'block' }): Promise<Context>;
  close(): Promise<void>;
  isConnected(): boolean;
};
type Paths = {
  home: string;
  app: string;
  data: string;
  channel: string;
  socket: string;
  database: string;
  sshConfig: string;
};
type Observation = {
  permissions: Record<'home' | 'app' | 'data' | 'channel' | 'socket', boolean>;
  adminMembers: string[];
  canary: string;
};
type Options = {
  paths: Paths;
  ownerName: string;
  executorUid: number;
  observeMacOS(paths: Paths): Promise<Observation>;
  runProcess: Parameters<typeof startExecutor>[0]['run'];
  launchChrome(): Promise<Chrome>;
  settleChromeLaunch?(): Promise<void>;
  now?(): number;
  supervisedRelease?: boolean;
  peerUid?: (socket: Socket) => Promise<number>;
  configureSocket?: (file: string) => Promise<void>;
  source: {
    url: string;
    sessionId: string;
    sourceId: string;
    accessId: string;
    instruction: string;
  };
};

async function createInstalled(options: Options) {
  const url = new URL(options.source.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error('source-url');
  for (const value of Object.values(options.paths)) {
    if (!path.isAbsolute(value) || path.normalize(value) !== value || value.includes('\0'))
      throw new Error('boundary-config');
  }
  await mkdir(path.dirname(options.paths.database), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(options.paths.socket), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(options.paths.database);
  const now = options.now ?? Date.now;
  const retentionCadence = 24 * 60 * 60 * 1000;
  let retentionTimer: ReturnType<typeof setInterval> | undefined;
  let ownerBrowser: Chrome | undefined, sourceBrowser: Chrome | undefined;
  let ownerContext: Context | undefined, sourceContext: Context | undefined;
  let owner: Page | undefined,
    sourcePage: Page | undefined,
    collector: Collector | undefined,
    cdp: Cdp | undefined;
  let runtime: ReturnType<typeof createPreparationRuntime> | undefined;
  let window: Awaited<ReturnType<typeof attachOwnerWindow>> | undefined;
  let running = false,
    closed = false,
    generation = 0;
  let preparationBusy = false;
  let releaseHandoff = false;
  let releasingSha: string | undefined;
  let workers = 0;
  let updates: ReturnType<typeof connectInstalledOwnerUpdates> | undefined;
  let worker: { stop(): void | Promise<void> } | undefined;
  let channelClose: (() => Promise<void>) | undefined;
  let closePromise: Promise<void> | undefined;
  let closingSource: Promise<void> | undefined;
  let protocol: ReturnType<typeof createActionProtocol> | undefined;
  let firstSession = true;
  let startupLogUnavailable = false;
  const log = createTechnicalLog({
    directory: path.join(options.paths.data, 'logs'),
    now: () => new Date(now()),
    onUnavailable(code, sessionId) {
      if (closed) return;
      if (firstSession) startupLogUnavailable = true;
      else runtime?.recordLogUnavailable(sessionId, code);
    },
  });
  function startLogSession(sessionId: string) {
    // Protocol validation remains authoritative for identifiers from installation configuration.
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return;
    log.beginSession(sessionId);
    log.write({ level: 'info', code: 'started' });
  }
  startLogSession(options.source.sessionId);
  const sockets = new Set<Socket>();
  function stopWorker() {
    const old = worker;
    worker = undefined;
    if (old) {
      try {
        void Promise.resolve(old.stop()).catch(() => {});
      } catch {
        /* Already stopped. */
      }
    }
  }
  function protocolUnavailable() {
    running = false;
    stopWorker();
    log.write({ level: 'error', code: 'protocol-unavailable' });
    window?.setStatus('protocol-unavailable');
  }
  const server = createAdmittedChannel({
    expectedUid: options.executorUid,
    maxLineBytes: 1024 * 1024,
    ...(options.peerUid ? { peerUid: options.peerUid } : {}),
    onDenied: (code) => {
      try {
        protocol?.appendDenial(code);
      } catch {
        protocolUnavailable();
        void runtime?.closeSource().catch(() => {});
        return;
      }
      log.write({ level: 'warn', code: 'channel-denied' });
    },
    createHandler: () => runtime!.createHandler(),
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  async function closeWithin(operation: () => Promise<void>): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('source-close-failed')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
  function closeSource(): Promise<void> {
    if (closingSource) return closingSource;
    generation++;
    log.endSession();
    running = false;
    stopWorker();
    const oldCollector = collector;
    collector = undefined;
    sourcePage = undefined;
    cdp = undefined;
    const release = async () => {
      const privateCleanup: Promise<void>[] = [];
      if (oldCollector) privateCleanup.push(closeWithin(() => oldCollector.close()));
      const context = sourceContext;
      if (context)
        privateCleanup.push(
          closeWithin(async () => {
            await context.close();
            if (sourceContext === context) sourceContext = undefined;
          }),
        );
      await Promise.allSettled(privateCleanup);
      const browser = sourceBrowser;
      if (browser) {
        await closeWithin(async () => {
          await browser.close();
          if (browser.isConnected()) throw new Error('source-close-failed');
          if (sourceBrowser === browser) {
            sourceBrowser = undefined;
            sourceContext = undefined;
            preparationBusy = false;
            window?.cancel();
          }
        });
      } else {
        await closeWithin(async () => {
          await options.settleChromeLaunch?.();
          preparationBusy = false;
          window?.cancel();
        });
      }
    };
    closingSource = release()
      .catch(() => {
        window?.setStatus('session-unavailable');
        throw new Error('source-close-failed');
      })
      .finally(() => {
        closingSource = undefined;
      });
    return closingSource;
  }
  async function close() {
    if (closePromise) return closePromise;
    closed = true;
    clearInterval(retentionTimer);
    generation++;
    running = false;
    stopWorker();
    closePromise = (async () => {
      window?.close();
      try {
        await runtime?.shutdown();
      } catch {
        /* Continue releasing resources. */
      }
      const sourceClosed = await closeSource().then(
        () => true,
        () => false,
      );
      for (const socket of sockets) socket.destroy();
      await channelClose?.();
      try {
        await ownerContext?.close();
      } catch {
        /* Continue releasing resources. */
      }
      try {
        await ownerBrowser?.close();
      } catch {
        /* Continue releasing resources. */
      }
      db.close();
      updates?.close();
      if (!sourceClosed) throw new Error('source-close-failed');
      if (releasingSha) updates?.finish(releasingSha);
      else if (updates && process.connected) process.disconnect?.();
    })();
    return closePromise;
  }
  try {
    protocol = createActionProtocol(db, now);
    const store = createTextSnapshotStore(db, now);
    const pruneSnapshots = () => {
      if (closed) return;
      try {
        store.prune();
      } catch {
        // Retry at the next scheduled maintenance if the clock or database is unavailable.
      }
    };
    pruneSnapshots();
    retentionTimer = setInterval(pruneSnapshots, retentionCadence);
    retentionTimer.unref();
    const browser: Parameters<typeof createPreparationRuntime>[0]['browser'] = {
      async openSource(sessionId) {
        const token = generation;
        const startedAt = performance.now();
        if (firstSession) {
          firstSession = false;
          pruneSnapshots();
          const unavailable = startupLogUnavailable;
          startupLogUnavailable = false;
          if (unavailable && !runtime!.recordLogUnavailable(sessionId, 'log-unavailable'))
            throw new Error('protocol-unavailable');
        } else {
          startLogSession(sessionId);
        }
        const check = () => {
          if (closed || generation !== token) throw new Error('session-unavailable');
        };
        try {
          sourceBrowser = await options.launchChrome();
          check();
          sourceContext = await sourceBrowser.newContext({ serviceWorkers: 'block' });
          check();
          sourcePage = await sourceContext.newPage();
          check();
          const page = sourcePage;
          const record = runtime!.bindBrowserEvents();
          page.on('close', () => {
            if (generation !== token) return;
            running = false;
            generation++;
            stopWorker();
            void runtime?.closeSource().catch(() => {});
          });
          await sourceContext.route('**/*', async (route) => {
            try {
              const request = route.request();
              const frame = request.frame() as { page(): unknown };
              const destination = new URL(request.url());
              if (
                closed ||
                generation !== token ||
                frame.page() !== page ||
                destination.protocol !== 'https:' ||
                (request.isNavigationRequest() &&
                  frame === page.mainFrame() &&
                  destination.origin !== url.origin)
              )
                throw new Error('refused');
              await (route as typeof route & { fallback(): Promise<void> }).fallback();
            } catch {
              try {
                await route.abort();
              } catch {
                /* Request already closed. */
              }
            }
          });
          check();
          await protectSourceNetwork(
            await sourceContext.newCDPSession(page),
            url.origin,
            () => !closed && generation === token,
            () => {
              void runtime?.closeSource().catch(() => {});
            },
          );
          check();
          cdp = await sourceContext.newCDPSession(page);
          check();
          collector = await prepare(cdp, { sourceHost: url.hostname, sourceOrigin: url.origin });
          check();
          const localCollector = collector;
          let navigationMethod = 'GET';
          type EventPage = { on(event: string, listener: (value: never) => void): unknown };
          const events = page as unknown as EventPage;
          const write = (
            kind: 'main-frame-navigation' | 'non-get-request',
            method: string,
            raw: string,
          ) => {
            if (closed || generation !== token || collector !== localCollector) return;
            let recorded: boolean;
            try {
              const address = localCollector.eventAddress(raw, raw === url.href);
              const verb =
                (['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const).find(
                  (value) => value === method,
                ) ?? 'other';
              recorded = record({ kind, method: verb, ...address });
            } catch {
              if (generation === token) {
                protocolUnavailable();
                void runtime?.closeSource().catch(() => {});
              }
              return;
            }
            if (recorded)
              log.write({
                level: 'debug',
                code: 'browser-event',
                kind,
                elapsedMs: Math.floor(performance.now() - startedAt),
              });
          };
          events.on('framenavigated', ((frame: { url(): string }) => {
            if (frame !== page.mainFrame()) return;
            const address = frame.url();
            const method = navigationMethod;
            navigationMethod = 'other';
            // A refused load can commit Chrome's local error document instead of a source URL.
            if (address === 'about:blank' || address === 'chrome-error://chromewebdata/') return;
            write('main-frame-navigation', method, address);
          }) as (value: never) => void);
          events.on('request', ((request: {
            method(): string;
            url(): string;
            isNavigationRequest(): boolean;
            frame(): unknown;
          }) => {
            const method = request.method();
            try {
              if (request.isNavigationRequest() && request.frame() === page.mainFrame())
                navigationMethod = method;
            } catch {
              /* A navigation request can arrive before Playwright can resolve its frame. */
            }
            if (method !== 'GET') write('non-get-request', method, request.url());
          }) as (value: never) => void);
          await page.goto(url.href);
          check();
        } catch (error) {
          await closeSource();
          throw error;
        }
      },
      closeSource,
      collectFrame: (...args) => collector!.collectFrame(...args),
      observeTargets: (...args) => collector!.observeTargets(...args),
      readObservedTarget: (...args) => collector!.readObservedTarget(...args),
      loginObservations: () => collector!.loginObservations(),
      checkpointLogin: () => collector!.checkpointLogin(),
      finishLoginObservation: () => collector!.finishLoginObservation(),
      capturePng: (viewport) => captureViewportPng(cdp!, viewport),
    };
    const { createPreparationRuntime: createRuntime } =
      require('../main.ts') as typeof import('../main.ts');
    runtime = createRuntime(
      {
        browser,
        protocol,
        store,
        now,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        executorRunning: () => running && !closed,
        protocolUnavailable,
        actionDenialLimit() {
          log.write({ level: 'error', code: 'action-denial-limit' });
          window?.setStatus('limit');
        },
      },
      options.source,
    );
    ownerBrowser = await options.launchChrome();
    ownerContext = await ownerBrowser.newContext();
    owner = await ownerContext.newPage();
    owner.on('close', () => {
      void close().catch(() => {});
    });
    async function openSource(refresh = true) {
      if (closed || releaseHandoff || preparationBusy) throw new Error('session-unavailable');
      preparationBusy = true;
      const token = generation;
      try {
        const sessionId = await runtime!.open();
        if (closed || token !== generation) throw new Error('session-unavailable');
        window!.begin({ sessionId, nonce: randomUUID() });
        if (refresh) window!.refresh();
      } catch (error) {
        if (generation === token) preparationBusy = false;
        throw error;
      }
    }
    window = await attach({
      context: ownerContext,
      page: owner,
      rows: runtime.rows,
      logEvents: runtime.logEvents,
      onLogLevel: log.setLevel,
      onOpen: () => openSource(false),
      onRelease: options.supervisedRelease
        ? async (sha) => {
            if (closed || releaseHandoff || preparationBusy || workers || !updates) return false;
            releaseHandoff = true;
            if (!(await updates.accept(sha)) || closed) {
              releaseHandoff = false;
              return false;
            }
            releasingSha = sha;
            void close().catch(() => {});
            return true;
          }
        : undefined,
      async onLoginComplete(sessionId) {
        const token = generation;
        if (closed || !(await runtime!.confirmLogin(sessionId)) || closed || token !== generation)
          return false;
        workers++;
        void (async () => {
          let observation: Observation | undefined;
          try {
            observation = await options.observeMacOS(options.paths);
          } catch {
            /* Fail closed. */
          }
          const result = await startExecutor(
            {
              permissions: async () =>
                !!observation &&
                (['home', 'app', 'data', 'channel', 'socket'] as const).every(
                  (key) => observation!.permissions?.[key] === true,
                ),
              adminGroup: async () =>
                !!observation &&
                options.ownerName !== 'root' &&
                observation.adminMembers?.length === 2 &&
                new Set(observation.adminMembers).size === 2 &&
                observation.adminMembers.includes('root') &&
                observation.adminMembers.includes(options.ownerName),
              pfCanary: async () => observation?.canary ?? '',
              run: async (...args) => {
                if (closed || token !== generation) throw new Error('revoked');
                return options.runProcess(...args);
              },
            },
            { sshConfigPath: options.paths.sshConfig },
          );
          if (result.ok && 'worker' in result) {
            const started = result.worker;
            void started.finished.then(
              () => {
                workers--;
              },
              () => {
                workers--;
              },
            );
            if (closed || token !== generation) {
              try {
                await started.stop();
              } catch {
                /* Withdrawn worker. */
              }
              void started.finished.catch(() => {});
              return;
            }
            worker = started;
            running = true;
            void started.finished.then(
              () => {
                if (worker !== started) return;
                worker = undefined;
                running = false;
                void runtime?.closeSource().catch(() => {});
              },
              () => {
                if (worker !== started) return;
                worker = undefined;
                running = false;
                window?.setStatus('executor-launch');
                void runtime?.closeSource().catch(() => {});
              },
            );
          } else {
            workers--;
            if (!closed && token === generation)
              window?.setStatus(result.ok ? 'executor-launch' : result.code);
          }
        })().catch(() => {
          workers--;
          if (!closed && token === generation) window?.setStatus('executor-launch');
        });
        return true;
      },
    });
    const configure =
      options.configureSocket ??
      (process.platform === 'darwin' && options.executorUid === process.getuid?.()
        ? createSocketConfiguration(options.executorUid, os.userInfo().username)
        : undefined);
    if (!configure) throw new Error('boundary-permissions');
    const channel = await openSystemSocket({
      path: options.paths.socket,
      configure,
      recoverStale: true,
      handler: (socket) => {
        server.emit('connection', socket);
      },
    });
    if (!channel.ok) throw new Error('boundary-permissions');
    channelClose = channel.close;
    if (options.supervisedRelease) {
      updates = connectInstalledOwnerUpdates(window.setReleases, window.setReleaseStatus);
      window.refresh();
    }
    return {
      openSource,
      ownerPage() {
        if (!owner) throw new Error('session-unavailable');
        return owner;
      },
      sourcePage() {
        if (!sourcePage) throw new Error('session-unavailable');
        return sourcePage;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
export declare const createInstalledKernel: typeof createInstalled;
declare const exports: { createInstalledKernel: typeof createInstalled };
exports.createInstalledKernel = createInstalled;
