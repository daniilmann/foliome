import type { ReleaseCard } from '../update/install.ts';
import type { LogProtocolRow } from '../store/action-protocol.ts';
import type { TechnicalLogLevel } from '../technical-log.ts';

const { randomUUID } = require('node:crypto') as typeof import('node:crypto');
const { createOwnerLoginConfirmation } =
  require('./owner-login-confirmation.ts') as typeof import('./owner-login-confirmation.ts');
const { renderProtocol } = require('./protocol-view.ts') as typeof import('./protocol-view.ts');
const { technicalLogLevels } =
  require('../technical-log.ts') as typeof import('../technical-log.ts');

type Row = Parameters<typeof renderProtocol>[0][number];
type Pending = Readonly<{ sessionId: string; nonce: string }>;
type Request = {
  url(): string;
  method(): string;
  frame(): object;
  isNavigationRequest(): boolean;
  allHeaders(): Promise<Record<string, string>>;
  postDataBuffer(): Buffer | null;
};
type Route = {
  request(): Request;
  abort(): Promise<void>;
  fulfill(options: {
    status: number;
    headers: Record<string, string>;
    body: string;
  }): Promise<void>;
};
type Context = {
  route(url: string, handler: (route: Route) => Promise<void>): Promise<void>;
  routeWebSocket(
    url: string,
    handler: (socket: { close(): void | Promise<void> }) => void,
  ): Promise<void>;
};
type Page = {
  mainFrame(): object;
  on(event: 'close' | 'load', listener: () => void): unknown;
  goto(url: string): Promise<unknown>;
};
type Options = Readonly<{
  context: Context;
  page: Page;
  rows: (() => readonly Row[]) & { subscribe?: (listener: () => void) => () => void };
  onLoginComplete: (sessionId: string) => boolean;
  onOpen?: () => Promise<void>;
  logEvents?: () => readonly LogProtocolRow[];
  onRelease?: (sha: string) => Promise<boolean>;
  onLogLevel?: (level: TechnicalLogLevel) => void;
}>;

export declare const attachOwnerWindow: typeof attach;
declare const exports: { attachOwnerWindow: typeof attach };

const origin = 'https://foliome-owner.invalid';
const endpoint = '/preparation/login-complete';
const releaseEndpoint = '/system/release';
const openEndpoint = '/preparation/open';
const logLevelEndpoint = '/diagnostics/log-level';
const headers = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy':
    "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function isOwnerForm(requestHeaders: Record<string, string>): boolean {
  return (
    requestHeaders.origin === origin &&
    /^application\/x-www-form-urlencoded(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(
      requestHeaders['content-type'] ?? '',
    )
  );
}

function escapeAttribute(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character] ?? character,
  );
}

function parseBody(buffer: Buffer | null, id = 'sessionId', consent = false): Pending | null {
  if (buffer === null || buffer.length > 8192) return null;
  const body = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  const parts = body.split('&');
  if (parts.length !== (consent ? 3 : 2)) return null;
  const values = new Map<string, string>();
  for (const part of parts) {
    const index = part.indexOf('=');
    if (index < 0) return null;
    const decode = (value: string) => decodeURIComponent(value.replace(/\+/g, ' '));
    const key = decode(part.slice(0, index));
    const value = decode(part.slice(index + 1));
    if (
      (key !== id && key !== 'nonce' && !(consent && key === 'consent')) ||
      values.has(key) ||
      value.length === 0
    )
      return null;
    values.set(key, value);
  }
  if (consent && values.get('consent') !== 'yes') return null;
  const sessionId = values.get(id);
  const nonce = values.get('nonce');
  return sessionId && nonce ? { sessionId, nonce } : null;
}

async function attach({
  context,
  page,
  rows,
  onLoginComplete,
  onOpen,
  logEvents,
  onLogLevel,
  onRelease,
}: Options) {
  const frame = page.mainFrame();
  const confirmation = createOwnerLoginConfirmation({
    ownerFrame: frame,
    origin,
    endpoint,
    complete: onLoginComplete,
  });
  const usedNonces = new Set<string>();
  let pending: Pending | null = null;
  let closed = false;
  let updating = false;
  let dirty = false;
  const subscription: { unsubscribe?: () => void } = {};
  let status = '';
  let engaged = false;
  let opening = false;
  let posting = false;
  let showingDiagnostics = false;
  let applying = false;
  let releaseStatus = '';
  const releases = new Map<
    ReleaseCard['kind'],
    {
      card: ReleaseCard;
      nonce: string;
      consume: ReturnType<typeof createOwnerLoginConfirmation>['handle'];
    }
  >();
  let logLevel: TechnicalLogLevel = 'error';

  function renderRelease({ card, nonce }: { card: ReleaseCard; nonce: string }): string {
    const text = escapeAttribute;
    const warning = card.checks === 'changed' || card.boundary;
    const action = card.kind === 'previous' ? 'Вернуть предыдущую' : 'Принять';
    const consent = warning ? ' name="consent" value="yes"' : '';
    const label = warning ? `${action} и подтвердить изменения` : action;
    const warnings = [
      card.checks === 'changed'
        ? '<p>Изменены проверки и стенд. Результат проверок и ревью со слов разработки.</p>'
        : '<p>Проверки GitHub пройдены. Набор совпадает с закреплённым.</p>',
      card.boundary ? '<p>Изменены граница или системные файлы.</p>' : '',
      warning ? '<p>Принимайте только изменения, которые вы уже утвердили.</p>' : '',
    ].join('');
    const form =
      engaged || opening || applying
        ? ''
        : `<form method="post" action="${releaseEndpoint}"><input type="hidden" name="sha" value="${card.sha}"><input type="hidden" name="nonce" value="${nonce}"><button type="submit"${consent}>${label}</button></form>`;
    return `<section><h2>${card.kind === 'previous' ? 'Предыдущая версия' : 'Обновление'}</h2><p>Версия v${text(card.from)} → v${text(card.to)}</p>${warnings}<p>Нужен пароль администратора: ${card.password ? 'да' : 'нет'}.</p><p>Переутверждать версии источников не нужно.</p>${engaged || opening ? '<p>Доступно после завершения подготовки.</p>' : ''}<p>Node.js ${card.node.map(text).join(' → ')} · Codex ${card.codex.map(text).join(' → ')} · playwright-core ${card.playwright.map(text).join(' → ')}</p>${card.notes ? `<p>Примечание разработчика</p><pre>${text(card.notes)}</pre>` : ''}${form}</section>`;
  }

  function render(): string {
    const table = renderProtocol(rows(), logEvents?.());
    const form =
      pending === null
        ? onOpen && !engaged && !opening && !applying
          ? `<form method="post" action="${openEndpoint}"><button type="submit">Открыть подготовку</button></form>`
          : ''
        : `<form method="post" action="${endpoint}"><input type="hidden" name="sessionId" value="${escapeAttribute(pending.sessionId)}"><input type="hidden" name="nonce" value="${escapeAttribute(pending.nonce)}"><button type="submit">Вход завершён, продолжить</button></form>`;
    const diagnostics = onLogLevel ? `<a href="${logLevelEndpoint}">Технический журнал</a>` : '';
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Протокол</title></head><body>${table}${form}<p>${escapeAttribute(status)}</p><p>${escapeAttribute(releaseStatus)}</p>${[...releases.values()].map(renderRelease).join('')}${diagnostics}</body></html>`;
  }

  function renderDiagnostics(): string {
    const levels = technicalLogLevels
      .map(
        (level) =>
          `<option value="${level}"${level === logLevel ? ' selected' : ''}>${level}</option>`,
      )
      .join('');
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Технический журнал</title></head><body><form method="post" action="${logLevelEndpoint}"><label>Уровень журнала <select name="level">${levels}</select></label><button type="submit">Установить уровень</button></form><a href="/">Вернуться к протоколу</a></body></html>`;
  }

  function refresh(): void {
    if (closed || showingDiagnostics) return;
    dirty = true;
    if (updating || posting) return;
    updating = true;
    void (async () => {
      while (dirty && !closed && !showingDiagnostics) {
        dirty = false;
        try {
          await page.goto(`${origin}/`);
        } catch {
          /* Window may have closed. */
        }
      }
    })().finally(() => {
      updating = false;
    });
  }

  function close(): void {
    closed = true;
    subscription.unsubscribe?.();
    pending = null;
    releases.clear();
    confirmation.close();
  }

  function begin(value: Pending): void {
    pending = null;
    confirmation.close();
    try {
      if (closed) return;
      const sessionId = Object.getOwnPropertyDescriptor(value, 'sessionId')?.value;
      const nonce = Object.getOwnPropertyDescriptor(value, 'nonce')?.value;
      if (
        typeof sessionId !== 'string' ||
        !sessionId ||
        typeof nonce !== 'string' ||
        !nonce ||
        usedNonces.has(nonce)
      )
        return;
      usedNonces.add(nonce);
      pending = { sessionId, nonce };
      engaged = true;
      status = '';
      confirmation.begin(pending);
    } catch {
      pending = null;
      confirmation.close();
    }
  }

  page.on('close', close);
  page.on('load', () => {
    if (!posting) return;
    posting = false;
    if (dirty) refresh();
  });
  await context.routeWebSocket('**/*', (socket) => {
    try {
      void Promise.resolve(socket.close()).catch(() => {});
    } catch {
      /* Already closed. */
    }
  });
  await context.route('**/*', async (route) => {
    try {
      const request = route.request();
      const url = request.url();
      if (closed || request.frame() !== frame) throw new Error('refused');
      if (request.method() === 'GET' && url === `${origin}/`) {
        showingDiagnostics = false;
        const body = render();
        if (closed) throw new Error('refused');
        await route.fulfill({ status: 200, headers, body });
        return;
      }
      if (
        request.method() === 'GET' &&
        url === `${origin}${logLevelEndpoint}` &&
        onLogLevel &&
        request.isNavigationRequest()
      ) {
        showingDiagnostics = true;
        await route.fulfill({ status: 200, headers, body: renderDiagnostics() });
        return;
      }
      if (
        request.method() === 'POST' &&
        url === `${origin}${logLevelEndpoint}` &&
        onLogLevel &&
        request.isNavigationRequest()
      ) {
        const requestHeaders = await request.allHeaders();
        if (closed || !isOwnerForm(requestHeaders)) throw new Error('refused');
        const buffer = request.postDataBuffer();
        if (!buffer || buffer.length > 'level=debug'.length) throw new Error('refused');
        const body = buffer.toString('utf8');
        const selected = technicalLogLevels.find((level) => body === `level=${level}`);
        if (!selected) throw new Error('refused');
        posting = true;
        onLogLevel(selected);
        logLevel = selected;
        showingDiagnostics = false;
        dirty = false;
        await route.fulfill({ status: 200, headers, body: render() });
        return;
      }
      if (
        request.method() === 'POST' &&
        url === `${origin}${openEndpoint}` &&
        onOpen &&
        !engaged &&
        !opening &&
        !applying
      ) {
        const requestHeaders = await request.allHeaders();
        if (
          closed ||
          engaged ||
          opening ||
          applying ||
          !isOwnerForm(requestHeaders) ||
          (request.postDataBuffer()?.length ?? 0) !== 0
        )
          throw new Error('refused');
        opening = true;
        posting = true;
        status = '';
        try {
          await onOpen();
        } catch {
          if (status === '') status = 'session-unavailable';
        } finally {
          opening = false;
        }
        if (closed) throw new Error('refused');
        dirty = false;
        await route.fulfill({ status: 200, headers, body: render() });
        return;
      }
      if (
        request.method() === 'POST' &&
        url === `${origin}${releaseEndpoint}` &&
        request.isNavigationRequest() &&
        onRelease
      ) {
        const requestHeaders = await request.allHeaders();
        if (
          closed ||
          showingDiagnostics ||
          engaged ||
          opening ||
          applying ||
          !isOwnerForm(requestHeaders)
        )
          throw new Error('refused');
        let matched = false;
        for (const [kind, offer] of releases) {
          const body = parseBody(
            request.postDataBuffer(),
            'sha',
            offer.card.checks === 'changed' || offer.card.boundary,
          );
          if (
            !body ||
            !offer.consume({ method: 'POST', path: releaseEndpoint, frame, origin, body })
          )
            continue;
          releases.delete(kind);
          matched = true;
          applying = true;
          posting = true;
          try {
            if (await onRelease(body.sessionId)) {
              await route.abort().catch(() => {});
              return;
            }
            releaseStatus = 'Переход недоступен. Код update-failed.';
          } finally {
            applying = false;
          }
          break;
        }
        if (!matched || closed) throw new Error('refused');
        dirty = false;
        await route.fulfill({ status: 200, headers, body: render() });
        return;
      }
      if (request.method() === 'POST' && url === `${origin}${endpoint}`) {
        const requestHeaders = await request.allHeaders();
        if (closed || !isOwnerForm(requestHeaders)) throw new Error('refused');
        const body = parseBody(request.postDataBuffer());
        if (
          body === null ||
          pending === null ||
          body.sessionId !== pending.sessionId ||
          body.nonce !== pending.nonce
        )
          throw new Error('refused');
        posting = true;
        pending = null;
        const result = confirmation.handle({ method: 'POST', path: endpoint, frame, origin, body });
        if (result === null || closed) throw new Error('refused');
        dirty = false;
        await route.fulfill({ status: 200, headers, body: render() });
        return;
      }
    } catch {
      posting = false;
      // Any failure refuses the request without passing it to another handler.
    }
    try {
      await route.abort();
    } catch {
      /* The request may already be gone. */
    }
  });
  subscription.unsubscribe = rows.subscribe?.(refresh);
  return {
    begin,
    close,
    refresh,
    cancel() {
      pending = null;
      engaged = false;
      confirmation.close();
      refresh();
    },
    setReleases(cards: readonly ReleaseCard[]) {
      if (closed || !onRelease) return;
      for (const card of cards) {
        if (releases.get(card.kind)?.card === card) continue;
        const nonce = randomUUID();
        const approval = createOwnerLoginConfirmation({
          ownerFrame: frame,
          origin,
          endpoint: releaseEndpoint,
          complete: () => true,
        });
        approval.begin({ sessionId: card.sha, nonce });
        releases.set(card.kind, { card, nonce, consume: approval.handle });
      }
      refresh();
    },
    setReleaseStatus(value: string) {
      releaseStatus = value;
      refresh();
    },
    setStatus(value: string) {
      status = value;
      refresh();
    },
  };
}

exports.attachOwnerWindow = attach;
