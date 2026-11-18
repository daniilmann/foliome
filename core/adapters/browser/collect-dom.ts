type Cdp = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
};
type FrameTree = { frame: { id: string; url: string }; childFrames?: FrameTree[] };
type FrameFact = { index: number; host: string; foreign: boolean; unavailable: boolean };
type NodeFact = { n: number; frame: number; parent?: number; visible: boolean; role: string; text: string; state?: string; field?: 'empty' | 'filled' | 'sealed'; href?: string; attrs?: Record<string, string> };
type Secret = { value: string; kind: 'login' | 'password' | 'code' };
type DocumentFacts = { url: string; title: string; nodes: Omit<NodeFact, 'n' | 'frame' | 'parent'>[]; parents: (number | null)[]; secrets: Secret[]; embeds: { url: string; visible: boolean }[] };

// This expression is owned by the adapter and runs only in its isolated world.
const expression = `(() => {
  const nodes = [], parents = [], secrets = [], embeds = [];
  const forbidden = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);
  const fieldRoles = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);
  const safeAttrs = ['title', 'alt', 'aria-label', 'placeholder', 'name', 'type'];
  const visit = (element, parent, ancestorsVisible) => {
    if (nodes.length >= 10000) throw new Error();
    const tag = element.tagName;
    if (forbidden.has(tag)) return;
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    const subtreeVisible = ancestorsVisible && style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0 && !element.hasAttribute('hidden') && !element.hasAttribute('inert') && element.getAttribute('aria-hidden') !== 'true';
    const visible = subtreeVisible && rect.width > 0 && rect.height > 0;
    if ((tag === 'IFRAME' || tag === 'FRAME') && element.src) embeds.push({ url: element.src, visible });
    const role = (element.getAttribute('role') || tag.toLowerCase()).toLowerCase();
    const closedField = element.isContentEditable || element.hasAttribute('contenteditable') || role === 'slider';
    const field = closedField || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || fieldRoles.has(role);
    let text = '';
    if (!field) for (const child of element.childNodes) if (child.nodeType === 3) text += child.nodeValue || '';
    const fact = { visible, role, text };
    if (field) {
      const value = !closedField && typeof element.value === 'string' ? element.value : '';
      const type = (element.getAttribute('type') || '').toLowerCase();
      fact.field = closedField || type === 'password' ? 'sealed' : value ? 'filled' : 'empty';
      if (value) secrets.push({ value, kind: type === 'password' ? 'password' : 'login' });
    }
    const state = [];
    if (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') state.push('disabled');
    if (element.getAttribute('aria-checked') === 'true' || element.checked === true) state.push('checked');
    if (state.length) fact.state = state.join(' ');
    if (tag === 'A' && element.hasAttribute('href')) fact.href = element.href;
    const attrs = {};
    for (const key of safeAttrs) if (element.hasAttribute(key)) attrs[key] = element.getAttribute(key);
    if (Object.keys(attrs).length) fact.attrs = attrs;
    const index = nodes.length; nodes.push(fact); parents.push(parent);
    if (!field) for (const child of element.children) visit(child, visible ? index : parent, subtreeVisible);
  };
  if (!document.documentElement) throw new Error();
  visit(document.documentElement, null, true);
  return { url: location.href, title: document.title, nodes, parents, secrets, embeds };
})()`;

const worldName = 'foliome-dom-collector';
const deadline = 5000;
class NavigationError extends Error {}
function bounded<T>(operation: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('internal')), deadline);
    Promise.resolve().then(operation).then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); reject(new Error('internal')); });
  });
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function tree(value: unknown): FrameTree {
  if (!record(value) || !record(value.frame) || typeof value.frame.id !== 'string' || typeof value.frame.url !== 'string' || (value.childFrames !== undefined && !Array.isArray(value.childFrames))) throw new Error('internal');
  return { frame: { id: value.frame.id, url: value.frame.url }, childFrames: (value.childFrames ?? []).map(tree) };
}
function host(url: string): string { try { return new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { return ''; } }
function configuredHost(value: unknown): string {
  if (typeof value !== 'string' || !value || /[\s/@?#\\:]/.test(value)) throw new Error('internal');
  const parsed = new URL('https://' + value);
  if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.port || parsed.username || parsed.password) throw new Error('internal');
  const normalized = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!normalized || normalized.endsWith('.')) throw new Error('internal');
  return normalized;
}
function trustedUrl(value: string, sourceHost: string, approvedHosts: ReadonlySet<string>): boolean {
  try {
    const parsed = new URL(value);
    const authority = value.match(/^https:\/\/([^/?#]*)/i)?.[1];
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return !!authority && !authority.includes('@') && parsed.protocol === 'https:' && !parsed.port && !parsed.username && !parsed.password &&
      (hostname === sourceHost || hostname.endsWith('.' + sourceHost) || approvedHosts.has(hostname));
  } catch { return false; }
}

async function prepare(cdp: Cdp, config: { sourceHost: string; approvedHosts?: readonly string[] }) {
  let closed = false;
  let scriptId: string | undefined;
  try {
    if (!config || !Array.isArray(config.approvedHosts ?? [])) throw new Error();
    const sourceHost = configuredHost(config.sourceHost);
    const approvedHosts = new Set((config.approvedHosts ?? []).map(configuredHost));
    await bounded(() => cdp.send('Page.enable'));
    const registered = await bounded(() => cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'void 0', worldName }));
    if (!record(registered) || typeof registered.identifier !== 'string') throw new Error();
    scriptId = registered.identifier;
    return {
    async collectText(snapshot: number): Promise<unknown> {
      if (closed || !Number.isSafeInteger(snapshot) || snapshot < 1) throw new Error('internal');
      try {
        const expires = performance.now() + deadline;
        const send = (method: string, params?: Record<string, unknown>) => {
          if (closed || performance.now() >= expires) throw new Error();
          return cdp.send(method, params);
        };
        const result = await bounded(async () => {
          const response = await send('Page.getFrameTree');
          if (!record(response)) throw new Error();
          const root = tree(response.frameTree);
          const rootHost = host(root.frame.url);
          if (!rootHost || !trustedUrl(root.frame.url, sourceHost, approvedHosts)) throw new Error();
          const frames: FrameFact[] = [], nodes: NodeFact[] = [], secrets: Secret[] = [];
          let page: { url: string; title: string } | undefined;
          const embeds: { url: string; visible: boolean }[] = [];
          const visit = async (frame: FrameTree, foreignAncestor: boolean, parentAccessible: boolean): Promise<void> => {
            if (frames.length >= 256) throw new Error();
            const frameHost = host(frame.frame.url);
            const foreign = foreignAncestor || !trustedUrl(frame.frame.url, sourceHost, approvedHosts);
            const index = frames.length;
            const fact: FrameFact = { index, host: frameHost, foreign, unavailable: false };
            frames.push(fact);
            if (!foreign && parentAccessible) {
              const base = nodes.length, secretBase = secrets.length, embedBase = embeds.length;
              try {
                const world = await send('Page.createIsolatedWorld', { frameId: frame.frame.id, worldName });
                if (!record(world) || !Number.isSafeInteger(world.executionContextId)) throw new Error();
                const evaluation = await send('Runtime.evaluate', { expression, contextId: world.executionContextId, returnByValue: true });
                if (!record(evaluation) || evaluation.exceptionDetails || !record(evaluation.result) || !record(evaluation.result.value)) throw new Error();
                const data = evaluation.result.value as unknown as DocumentFacts;
                if (typeof data.url !== 'string' || typeof data.title !== 'string' || !Array.isArray(data.nodes) || !Array.isArray(data.parents) || data.nodes.length !== data.parents.length || !Array.isArray(data.secrets) || !Array.isArray(data.embeds)) throw new Error();
                if (!trustedUrl(data.url, sourceHost, approvedHosts) || new URL(data.url).href !== new URL(frame.frame.url).href || host(data.url) !== frameHost) throw new NavigationError();
                if (index === 0) page = { url: data.url, title: data.title };
                for (let i = 0; i < data.nodes.length; i++) {
                  const parent = data.parents[i];
                  if (parent !== null && (!Number.isSafeInteger(parent) || parent < 0 || parent >= i)) throw new Error();
                  nodes.push({ ...data.nodes[i], n: base + i + 1, frame: index, ...(parent === null ? {} : { parent: base + parent + 1 }) });
                }
                secrets.push(...data.secrets);
                embeds.push(...data.embeds);
              } catch (error) {
                nodes.length = base; secrets.length = secretBase; embeds.length = embedBase;
                if (index === 0 || error instanceof NavigationError) throw new Error();
                fact.unavailable = true;
              }
            } else if (!foreign) fact.unavailable = true;
            for (const child of frame.childFrames ?? []) {
              const matches = embeds.filter(e => e.url === child.frame.url);
              await visit(child, foreign, parentAccessible && !fact.unavailable && matches.length === 1 && matches[0].visible);
            }
          };
          await visit(root, false, true);
          for (const embed of embeds) {
            const embedHost = host(embed.url);
            if (embedHost && !trustedUrl(embed.url, sourceHost, approvedHosts) && !frames.some(f => f.host === embedHost && f.foreign)) {
              if (frames.length >= 256) throw new Error();
              frames.push({ index: frames.length, host: embedHost, foreign: true, unavailable: true });
            }
          }
          const verify = await send('Page.getFrameTree');
          if (!record(verify) || JSON.stringify(tree(verify.frameTree)) !== JSON.stringify(root) || !page || closed) throw new Error();
          return { snapshot, page, frames, nodes, secrets };
        });
        if (closed) throw new Error();
        return result;
      } catch { throw new Error('internal'); }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      let failed = false;
      try { if (scriptId) await bounded(() => cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId })); } catch { failed = true; }
      try { await bounded(() => cdp.detach()); } catch { failed = true; }
      if (failed) throw new Error('internal');
    },
    };
  } catch { try { await bounded(() => cdp.detach()); } catch {} throw new Error('internal'); }
}

export declare const prepareDomCollector: typeof prepare;
declare const exports: { prepareDomCollector: typeof prepare };
exports.prepareDomCollector = prepare;
