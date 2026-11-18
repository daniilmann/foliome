const { createOwnerLoginConfirmation } = require('./owner-login-confirmation.ts') as typeof import('./owner-login-confirmation.ts');
const { renderProtocol } = require('./protocol-view.ts') as typeof import('./protocol-view.ts');

type Row = Parameters<typeof renderProtocol>[0][number];
type Pending = Readonly<{ sessionId: string; nonce: string }>;
type Request = {
  url(): string;
  method(): string;
  frame(): object;
  allHeaders(): Promise<Record<string, string>>;
  postDataBuffer(): Buffer | null;
};
type Route = {
  request(): Request;
  abort(): Promise<void>;
  fulfill(options: { status: number; headers: Record<string, string>; body: string }): Promise<void>;
};
type Context = {
  route(url: string, handler: (route: Route) => Promise<void>): Promise<void>;
  routeWebSocket(url: string, handler: (socket: { close(): void | Promise<void> }) => void): Promise<void>;
};
type Page = { mainFrame(): object; on(event: 'close', listener: () => void): unknown };
type Options = Readonly<{
  context: Context;
  page: Page;
  rows: () => readonly Row[];
  onLoginComplete: (sessionId: string) => boolean;
}>;

export declare const attachOwnerWindow: typeof attach;
declare const exports: { attachOwnerWindow: typeof attach };

const origin = 'https://foliome-owner.invalid';
const endpoint = '/preparation/login-complete';
const headers = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}

function parseBody(buffer: Buffer | null): Pending | null {
  if (buffer === null || buffer.length > 8192) return null;
  const body = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  const parts = body.split('&');
  if (parts.length !== 2) return null;
  const values = new Map<string, string>();
  for (const part of parts) {
    const index = part.indexOf('=');
    if (index < 0) return null;
    const decode = (value: string) => decodeURIComponent(value.replace(/\+/g, ' '));
    const key = decode(part.slice(0, index));
    const value = decode(part.slice(index + 1));
    if ((key !== 'sessionId' && key !== 'nonce') || values.has(key) || value.length === 0) return null;
    values.set(key, value);
  }
  const sessionId = values.get('sessionId');
  const nonce = values.get('nonce');
  return sessionId && nonce ? { sessionId, nonce } : null;
}

async function attach({ context, page, rows, onLoginComplete }: Options) {
  const frame = page.mainFrame();
  const confirmation = createOwnerLoginConfirmation({ ownerFrame: frame, origin, endpoint, complete: onLoginComplete });
  const usedNonces = new Set<string>();
  let pending: Pending | null = null;
  let closed = false;

  function close(): void {
    closed = true;
    pending = null;
    confirmation.close();
  }

  function begin(value: Pending): void {
    pending = null;
    confirmation.close();
    try {
      if (closed) return;
      const sessionId = Object.getOwnPropertyDescriptor(value, 'sessionId')?.value;
      const nonce = Object.getOwnPropertyDescriptor(value, 'nonce')?.value;
      if (typeof sessionId !== 'string' || !sessionId || typeof nonce !== 'string' || !nonce || usedNonces.has(nonce)) return;
      usedNonces.add(nonce);
      pending = { sessionId, nonce };
      confirmation.begin(pending);
    } catch {
      pending = null;
      confirmation.close();
    }
  }

  page.on('close', close);
  await context.routeWebSocket('**/*', (socket) => {
    try { void Promise.resolve(socket.close()).catch(() => {}); } catch { /* Already closed. */ }
  });
  await context.route('**/*', async (route) => {
    try {
      const request = route.request();
      const url = request.url();
      if (closed || request.frame() !== frame) throw new Error('refused');
      if (request.method() === 'GET' && url === `${origin}/`) {
        const table = renderProtocol(rows());
        if (closed) throw new Error('refused');
        const form = pending === null ? '' : `<form method="post" action="${endpoint}"><input type="hidden" name="sessionId" value="${escapeAttribute(pending.sessionId)}"><input type="hidden" name="nonce" value="${escapeAttribute(pending.nonce)}"><button type="submit">Вход завершён, продолжить</button></form>`;
        await route.fulfill({ status: 200, headers, body: `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Протокол</title></head><body>${table}${form}</body></html>` });
        return;
      }
      if (request.method() === 'POST' && url === `${origin}${endpoint}`) {
        const requestHeaders = await request.allHeaders();
        if (closed || requestHeaders.origin !== origin || !/^application\/x-www-form-urlencoded(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(requestHeaders['content-type'] ?? '')) throw new Error('refused');
        const body = parseBody(request.postDataBuffer());
        if (body === null || pending === null || body.sessionId !== pending.sessionId || body.nonce !== pending.nonce) throw new Error('refused');
        pending = null;
        const result = confirmation.handle({ method: 'POST', path: endpoint, frame, origin, body });
        if (result === null || closed) throw new Error('refused');
        await route.fulfill({ status: 200, headers, body: '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Вход</title></head><body>Подтверждено</body></html>' });
        return;
      }
    } catch {
      // Any failure refuses the request without passing it to another handler.
    }
    try { await route.abort(); } catch { /* The request may already be gone. */ }
  });
  return { begin, close };
}

exports.attachOwnerWindow = attach;
