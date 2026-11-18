import type { Socket } from 'node:net';
import type { createPreparationRuntime } from '../main.ts';
import type { prepareDomCollector } from './browser/collect-dom.ts';
import type { attachOwnerWindow } from './ui/owner-window.ts';

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
  newCDPSession(page: Page): Promise<Cdp>;
  close(): Promise<void>;
};
type Chrome = { newContext(): Promise<Context>; close(): Promise<void> };
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
  const log = createTechnicalLog(options.paths.database + '.technical.log');
  log('started');
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
  let worker: { stop(): void | Promise<void> } | undefined;
  let channelClose: (() => Promise<void>) | undefined;
  let closePromise: Promise<void> | undefined;
  let protocol: ReturnType<typeof createActionProtocol> | undefined;
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
  const server = createAdmittedChannel({
    expectedUid: options.executorUid,
    maxLineBytes: 1024 * 1024,
    ...(options.peerUid ? { peerUid: options.peerUid } : {}),
    onDenied: (code) => {
      try {
        protocol?.appendDenial(code);
        log('channel-denied');
      } catch {
        log('protocol-unavailable');
        running = false;
        stopWorker();
        window?.setStatus('protocol-unavailable');
        void runtime?.closeSource().catch(() => {});
      }
    },
    createHandler: () => runtime!.createHandler(),
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  async function closeSource() {
    generation++;
    running = false;
    stopWorker();
    window?.cancel();
    const oldCollector = collector,
      oldContext = sourceContext,
      oldBrowser = sourceBrowser;
    collector = undefined;
    sourceContext = undefined;
    sourceBrowser = undefined;
    sourcePage = undefined;
    cdp = undefined;
    try {
      await oldCollector?.close();
    } catch {
      /* Continue releasing resources. */
    }
    try {
      await oldContext?.close();
    } catch {
      /* Continue releasing resources. */
    }
    try {
      await oldBrowser?.close();
    } catch {
      /* Continue releasing resources. */
    }
  }
  async function close() {
    if (closePromise) return closePromise;
    closed = true;
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
      await closeSource();
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
    })();
    return closePromise;
  }
  try {
    protocol = createActionProtocol(db, Date.now);
    const store = createTextSnapshotStore(db, Date.now);
    const browser: Parameters<typeof createPreparationRuntime>[0]['browser'] = {
      async openSource() {
        const token = generation;
        const check = () => {
          if (closed || generation !== token) throw new Error('session-unavailable');
        };
        try {
          sourceBrowser = await options.launchChrome();
          check();
          sourceContext = await sourceBrowser.newContext();
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
              const request = route.request() as ReturnType<typeof route.request> & {
                isNavigationRequest(): boolean;
              };
              const destination = new URL(request.url());
              if (
                destination.protocol !== 'https:' ||
                (request.isNavigationRequest() &&
                  request.frame() === page.mainFrame() &&
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
          cdp = await sourceContext.newCDPSession(page);
          check();
          collector = await prepare(cdp, { sourceHost: url.hostname });
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
            try {
              const address = localCollector.eventAddress(raw);
              const verb =
                (['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const).find(
                  (value) => value === method,
                ) ?? 'other';
              if (record({ kind, method: verb, ...address })) log('browser-event');
            } catch {
              if (generation === token) {
                running = false;
                stopWorker();
                window?.setStatus('protocol-unavailable');
                void runtime?.closeSource().catch(() => {});
              }
            }
          };
          events.on('framenavigated', ((frame: { url(): string }) => {
            if (frame !== page.mainFrame() || frame.url() === 'about:blank') return;
            const method = navigationMethod;
            navigationMethod = 'other';
            write('main-frame-navigation', method, frame.url());
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
        now: Date.now,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        executorRunning: () => running && !closed,
        protocolUnavailable: () => {
          running = false;
          stopWorker();
          window?.setStatus('protocol-unavailable');
          log('protocol-unavailable');
        },
      },
      options.source,
    );
    ownerBrowser = await options.launchChrome();
    ownerContext = await ownerBrowser.newContext();
    owner = await ownerContext.newPage();
    owner.on('close', () => {
      void close();
    });
    async function openSource(refresh = true) {
      if (closed) throw new Error('session-unavailable');
      const token = generation;
      const sessionId = await runtime!.open();
      if (closed || token !== generation) throw new Error('session-unavailable');
      window!.begin({ sessionId, nonce: randomUUID() });
      if (refresh) window!.refresh();
    }
    window = await attach({
      context: ownerContext,
      page: owner,
      rows: runtime.rows,
      onOpen: () => openSource(false),
      onLoginComplete(sessionId) {
        if (closed || !runtime!.confirmLogin(sessionId)) return false;
        const token = generation;
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
          } else if (!closed && token === generation)
            window?.setStatus(result.ok ? 'executor-launch' : result.code);
        })();
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
