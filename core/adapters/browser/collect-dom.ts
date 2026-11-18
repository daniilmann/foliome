const { filterTextSnapshot, filterEventAddress } = require('../../domain/snapshot-filter.ts') as typeof import('../../domain/snapshot-filter.ts');
const { createHmac, randomBytes } = require('node:crypto') as typeof import('node:crypto');

type Cdp = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
  on(event: 'Runtime.executionContextCreated', listener: (event: { context: { id: number; name: string; origin: string; auxData?: { frameId?: string } } }) => void): unknown;
  on(event: 'Runtime.executionContextDestroyed', listener: (event: { executionContextId: number }) => void): unknown;
  on(event: 'Runtime.executionContextsCleared', listener: () => void): unknown;
  on(event: 'Runtime.bindingCalled', listener: (event: { name: string; payload: string; executionContextId: number }) => void): unknown;
  on(event: 'Page.frameNavigated', listener: (event: { frame: { id: string; url: string } }) => void): unknown;
  off(event: 'Runtime.executionContextCreated', listener: (event: { context: { id: number; name: string; origin: string; auxData?: { frameId?: string } } }) => void): unknown;
  off(event: 'Runtime.executionContextDestroyed', listener: (event: { executionContextId: number }) => void): unknown;
  off(event: 'Runtime.executionContextsCleared', listener: () => void): unknown;
  off(event: 'Runtime.bindingCalled', listener: (event: { name: string; payload: string; executionContextId: number }) => void): unknown;
  off(event: 'Page.frameNavigated', listener: (event: { frame: { id: string; url: string } }) => void): unknown;
};
type FrameTree = { frame: { id: string; url: string }; childFrames?: FrameTree[] };
type FrameFact = { index: number; host: string; foreign: boolean; unavailable: boolean };
type NodeFact = { n: number; frame: number; parent?: number; visible: boolean; role: string; text: string; state?: string; field?: 'empty' | 'filled' | 'sealed'; href?: string; attrs?: Record<string, string> };
type Secret = { value: string; kind: 'login' | 'password' | 'code' };
type Rect = { x: number; y: number; width: number; height: number };
type Geometry = { rect: Rect; runs: Rect[]; mask: boolean; button: boolean; ancestors: number[] };
type Viewport = { x: number; y: number; width: number; height: number };
type Observation = { viewport: Viewport; geometry: Geometry[]; width: number; height: number; revision: number; animationIds: string[]; animationTargets: (number | null)[]; viewportStable: boolean; maskAnimationActive: boolean; unsupported: boolean };
type DocumentFacts = { url: string; title: string; nodes: Omit<NodeFact, 'n' | 'frame' | 'parent'>[]; parents: (number | null)[]; identities: number[]; classes: ('blocked-payment' | 'blocked-change' | null)[]; semantics: string[]; secrets: Secret[]; embeds: { url: string; visible: boolean }[]; observation: Observation };

// This expression is owned by the adapter and runs only in its isolated world.
const expression = `(() => {
  const nodes = [], parents = [], identities = [], classes = [], semantics = [], secrets = [], embeds = [], geometry = [];
  const state = globalThis.__foliomeObservation || (globalThis.__foliomeObservation = (() => {
    const state = { revision: 0, ids: new WeakMap(), next: 1, watched: new WeakSet() };
    state.observer = new MutationObserver(() => { state.revision++; });
    state.observer.observe(document, { subtree: true, attributes: true, childList: true, characterData: true });
    for (const event of ['scroll', 'resize', 'pointerover', 'pointerout', 'focusin', 'transitionstart', 'animationstart'])
      addEventListener(event, () => { state.revision++; }, true);
    if (visualViewport) for (const event of ['scroll', 'resize']) visualViewport.addEventListener(event, () => { state.revision++; });
    return state;
  })());
  let unsupported = false;
  const rectValue = r => ({ x: r.x, y: r.y, width: r.width, height: r.height });
  const forbidden = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);
  const fieldRoles = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);
  const safeAttrs = ['id', 'name', 'class', 'data-testid', 'type', 'autocomplete', 'placeholder', 'aria-label'];
  const visit = (element, parent, ancestorsVisible) => {
    if (nodes.length >= 10000) throw new Error();
    const tag = element.tagName;
    if (forbidden.has(tag)) return;
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    const subtreeVisible = ancestorsVisible && style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0 && !element.hasAttribute('hidden') && !element.hasAttribute('inert') && element.getAttribute('aria-hidden') !== 'true';
    const visible = subtreeVisible && rect.width > 0 && rect.height > 0;
    if ((tag === 'IFRAME' || tag === 'FRAME') && element.src) embeds.push({ url: element.src, visible });
    for (const pseudo of ['::before', '::after']) {
      const content = getComputedStyle(element, pseudo).content;
      if (content !== 'none' && content !== 'normal') unsupported = true;
    }
    if (style.textShadow !== 'none' || style.filter !== 'none' || style.webkitBoxReflect !== 'none' && style.webkitBoxReflect !== '' ||
        style.transform !== 'none' || style.perspective !== 'none' || style.scale !== 'none' || style.rotate !== 'none' || style.translate !== 'none' ||
        style.offsetPath !== 'none' || style.textTransform !== 'none' || parseFloat(style.webkitTextStrokeWidth || '0') > 0 || (style.zoom !== '1' && style.zoom !== 'normal') || tag === 'USE' || tag === 'SVG') unsupported = true;
    const role = (element.getAttribute('role') || tag.toLowerCase()).toLowerCase();
    const closedField = element.isContentEditable || element.hasAttribute('contenteditable') || role === 'slider';
    const type = tag === 'INPUT' ? element.type.toLowerCase() : '';
    const button = tag === 'INPUT' && ['button', 'submit', 'reset'].includes(type);
    const choice = tag === 'INPUT' && ['checkbox', 'radio'].includes(type);
    const field = closedField || tag === 'INPUT' && !button && !choice || tag === 'SELECT' || tag === 'TEXTAREA' || fieldRoles.has(role);
    let text = button ? element.value : '';
    if (!field) for (const child of element.childNodes) if (child.nodeType === 3) text += child.nodeValue || '';
    const fact = { visible, role, text };
    if (field) {
      const type = (element.getAttribute('type') || '').toLowerCase();
      const textual = tag === 'TEXTAREA' || tag === 'INPUT' && ['', 'text', 'password', 'email', 'tel', 'url', 'search'].includes(type);
      const value = !closedField && textual && visible && typeof element.value === 'string' ? element.value : '';
      fact.field = closedField || type === 'password' ? 'sealed' : value ? 'filled' : 'empty';
      if (value) secrets.push({ value, kind: type === 'password' ? 'password' : 'login' });
    }
    const nodeState = [];
    if (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') nodeState.push('disabled');
    if (element.getAttribute('aria-checked') === 'true' || element.checked === true) nodeState.push('checked');
    if (nodeState.length) fact.state = nodeState.join(' ');
    if (tag === 'A' && element.hasAttribute('href')) fact.href = element.href;
    const attrs = {};
    for (const key of safeAttrs) if (element.hasAttribute(key)) attrs[key] = element.getAttribute(key);
    if (Object.keys(attrs).length) fact.attrs = attrs;
    const runs = [];
    if (!field) for (const child of element.childNodes) if (child.nodeType === 3 && child.nodeValue) {
      const range = document.createRange(); range.selectNodeContents(child);
      for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) runs.push(rectValue(r));
    }
    if (!state.ids.has(element)) state.ids.set(element, state.next++);
    identities.push(state.ids.get(element));
    const label = [text, element.getAttribute('aria-label') || '', element.getAttribute('title') || '', element.value && (tag === 'BUTTON' || tag === 'INPUT' && ['button', 'submit', 'reset'].includes(element.type)) ? element.value : ''].join(' ').toLowerCase();
    semantics.push(JSON.stringify([tag, label, element.getAttribute('type'), element.getAttribute('aria-expanded'), element.getAttribute('aria-haspopup'), element.getAttribute('aria-controls'), element.getAttribute('aria-pressed'), element.getAttribute('autocomplete')]));
    const payment = /(?:pay(?:ment)?|transfer|оплат|плат[её]ж|перевод)/iu.test(label);
    const change = /(?:save|delete|remove|change|сохран|удал|измен)/iu.test(label) || tag === 'INPUT' && ['submit', 'reset'].includes(element.type) || tag === 'BUTTON' && element.type === 'submit';
    classes.push(payment ? 'blocked-payment' : change ? 'blocked-change' : null);
    const index = nodes.length; nodes.push(fact); parents.push(parent);
    const ancestors = [];
    for (let current = element; current; current = current.parentElement) {
      if (!state.ids.has(current)) state.ids.set(current, state.next++);
      ancestors.push(state.ids.get(current));
    }
    geometry.push({ rect: rectValue(rect), runs, button, ancestors, mask: field || tag === 'IFRAME' || tag === 'FRAME' || tag === 'OBJECT' || tag === 'EMBED' });
    if (!field) for (const child of element.children) visit(child, visible ? index : parent, subtreeVisible);
  };
  if (!document.documentElement) throw new Error();
  visit(document.documentElement, null, true);
  const animations = document.getAnimations().filter(a => a.playState === 'running' || a.playState === 'pending');
  const animationIds = animations.map(a => { if (!state.ids.has(a)) state.ids.set(a, state.next++); return String(state.ids.get(a)); }).sort();
  const animationTargets = animations.map(a => {
    const target = a.effect instanceof KeyframeEffect ? a.effect.target : null;
    return target instanceof Element && document.contains(target) && state.ids.has(target) ? state.ids.get(target) : null;
  });
  const viewport = visualViewport;
  const viewportStable = !!viewport && devicePixelRatio === 1 && viewport.scale === 1 && viewport.offsetLeft === 0 && viewport.offsetTop === 0 && viewport.pageLeft === scrollX && viewport.pageTop === scrollY && viewport.width === innerWidth && viewport.height === innerHeight;
  return { url: location.href, title: document.title, nodes, parents, identities, classes, semantics, secrets, embeds, observation: { viewport: { x: scrollX, y: scrollY, width: innerWidth, height: innerHeight }, geometry, width: innerWidth, height: innerHeight, revision: state.revision, animationIds, animationTargets, viewportStable, maskAnimationActive: false, unsupported } };
})()`;

const worldName = 'foliome-dom-collector';
// Invoked on the exact CDP-resolved root in the collector's isolated world.
const shadowGeometry = `function() {
  if (!(this instanceof ShadowRoot) || !this.host.isConnected || this.host.ownerDocument !== document) throw new Error();
  const state = globalThis.__foliomeObservation;
  if (!state || !state.ids.has(this.host)) throw new Error();
  if (!state.watched.has(this)) {
    state.observer.observe(this, { subtree: true, attributes: true, childList: true, characterData: true });
    state.watched.add(this);
  }
  if (this.host.getAnimations({ subtree: true }).some(a => a.playState === 'running' || a.playState === 'pending')) throw new Error();
  const rects = [], add = r => {
    if (rects.length >= 20001) throw new Error();
    rects.push({ x: r.x, y: r.y, width: r.width, height: r.height });
  };
  add(this.host.getBoundingClientRect());
  let count = 0;
  const visit = node => {
    if (++count > 10000) throw new Error();
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.data) { const range = document.createRange(); range.selectNodeContents(node); for (const rect of range.getClientRects()) add(rect); }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) throw new Error();
    const el = node, style = getComputedStyle(el);
    if (!['DIV', 'SPAN', 'P', 'B', 'I', 'STRONG', 'EM', 'SMALL', 'BR'].includes(el.tagName) || el.shadowRoot ||
        style.textShadow !== 'none' || style.boxShadow !== 'none' || style.filter !== 'none' ||
        (style.webkitBoxReflect !== 'none' && style.webkitBoxReflect !== '') || style.transform !== 'none' || style.perspective !== 'none' ||
        style.scale !== 'none' || style.rotate !== 'none' || style.translate !== 'none' || style.offsetPath !== 'none' ||
        style.textTransform !== 'none' || parseFloat(style.webkitTextStrokeWidth || '0') > 0 ||
        (style.zoom !== '1' && style.zoom !== 'normal') || style.clipPath !== 'none' || style.clip !== 'auto' ||
        style.overflowX !== 'visible' || style.overflowY !== 'visible' || style.outlineStyle !== 'none') throw new Error();
    for (const pseudo of ['::before', '::after']) { const content = getComputedStyle(el, pseudo).content; if (content !== 'none' && content !== 'normal') throw new Error(); }
    add(el.getBoundingClientRect());
    for (const child of el.childNodes) visit(child);
  };
  for (const child of this.childNodes) visit(child);
  return { hostId: state.ids.get(this.host), rects };
}`;
const bindingName = '__foliomeLoginObservation';
// Only this adapter-owned script can call the binding in the named isolated world.
function observationScript(sourceHost: string, approvedHosts: ReadonlySet<string>): string {
  return `(() => {
    if (globalThis.__foliomeLoginInstalled) return;
    const allowed = ${JSON.stringify([sourceHost, ...approvedHosts])};
    const source = allowed[0];
    let url; try { url = new URL(location.href); } catch { return; }
    const hostname = url.hostname.toLowerCase().replace(/\\.$/, '');
    if (url.protocol !== 'https:' || url.port || url.username || url.password ||
        !(hostname === source || hostname.endsWith('.' + source) || allowed.includes(hostname))) return;
    globalThis.__foliomeLoginInstalled = true;
    const field = el => el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement &&
      ['text', 'password', 'email', 'tel', 'url', 'search'].includes(el.type);
    const send = (el, manual) => {
      if (!field(el)) return;
      if (!el.getClientRects().length) return;
      for (let node = el; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.hidden || node.inert || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) <= 0) return;
      }
      const type = el.type === 'password' ? 'password' : el.autocomplete === 'one-time-code' ? 'code' : 'login';
      globalThis.${bindingName}(JSON.stringify({ manual, value: el.value, kind: type }));
    };
    const scan = () => { for (const el of document.querySelectorAll('input,textarea')) send(el, false); };
    let manualSent = false;
    for (const type of ['beforeinput', 'input', 'change', 'paste', 'keydown', 'pointerdown'])
      addEventListener(type, event => { if (!event.isTrusted) return; if (!manualSent) { manualSent = true; globalThis.${bindingName}(JSON.stringify({ manual: true, value: '', kind: 'login' })); } send(event.target, true); if (type === 'keydown' && event.key === 'Enter') scan(); }, true);
    for (const type of ['submit', 'click', 'pagehide'])
      addEventListener(type, event => { if (event.isTrusted) scan(); }, true);
  })()`;
}
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
  const descriptorKey = randomBytes(32);
  let closed = false;
  let scriptId: string | undefined;
  const contexts = new Map<number, { frameId: string; origin: string }>();
  const frameUrls = new Map<string, string>();
  const history = new Map<string, Secret>();
  let historySize = 0, overflow = false, manualInputSeen = false, observationFinished = false;
  let sourceHost = '';
  let approvedHosts = new Set<string>();
  const remember = (secret: Secret) => {
    if (observationFinished || !secret.value) return;
    const key = secret.kind + '\0' + secret.value;
    if (history.has(key)) return;
    if (history.size >= 4096 || historySize + secret.value.length > 1024 * 1024) { overflow = true; return; }
    history.set(key, secret);
    historySize += secret.value.length;
  };
  const contextCreated = ({ context }: { context: { id: number; name: string; origin: string; auxData?: { frameId?: string } } }) => {
    if (context.name === worldName && context.auxData?.frameId && trustedUrl(context.origin, sourceHost, approvedHosts)) contexts.set(context.id, { frameId: context.auxData.frameId, origin: context.origin });
  };
  const contextDestroyed = ({ executionContextId }: { executionContextId: number }) => { contexts.delete(executionContextId); };
  const contextsCleared = () => { contexts.clear(); };
  const frameNavigated = ({ frame }: { frame: { id: string; url: string } }) => { frameUrls.set(frame.id, frame.url); };
  const bindingCalled = (event: { name: string; payload: string; executionContextId: number }) => {
    if (closed || event.name !== bindingName) return;
    const context = contexts.get(event.executionContextId);
    const url = context && frameUrls.get(context.frameId);
    if (!context || !url || !trustedUrl(url, sourceHost, approvedHosts) || new URL(url).origin !== context.origin) return;
    try {
      const data: unknown = JSON.parse(event.payload);
      if (!record(data) || typeof data.manual !== 'boolean' || typeof data.value !== 'string' || !['login', 'password', 'code'].includes(String(data.kind))) { overflow = true; return; }
      manualInputSeen ||= data.manual;
      remember({ value: data.value, kind: data.kind as Secret['kind'] });
    } catch { overflow = true; }
  };
  const removeListeners = () => {
    if (typeof cdp.off !== 'function') return;
    cdp.off('Runtime.executionContextCreated', contextCreated); cdp.off('Runtime.executionContextDestroyed', contextDestroyed);
    cdp.off('Runtime.executionContextsCleared', contextsCleared); cdp.off('Runtime.bindingCalled', bindingCalled); cdp.off('Page.frameNavigated', frameNavigated);
  };
  try {
    if (!config || !Array.isArray(config.approvedHosts ?? [])) throw new Error();
    sourceHost = configuredHost(config.sourceHost);
    approvedHosts = new Set((config.approvedHosts ?? []).map(configuredHost));
    cdp.on('Runtime.executionContextCreated', contextCreated); cdp.on('Runtime.executionContextDestroyed', contextDestroyed);
    cdp.on('Runtime.executionContextsCleared', contextsCleared); cdp.on('Runtime.bindingCalled', bindingCalled); cdp.on('Page.frameNavigated', frameNavigated);
    await bounded(() => cdp.send('Page.enable'));
    const initial = await bounded(() => cdp.send('Page.getFrameTree'));
    if (!record(initial)) throw new Error();
    const rememberFrames = (frame: FrameTree) => { frameUrls.set(frame.frame.id, frame.frame.url); for (const child of frame.childFrames ?? []) rememberFrames(child); };
    rememberFrames(tree(initial.frameTree));
    await bounded(() => cdp.send('Runtime.enable'));
    await bounded(() => cdp.send('Runtime.addBinding', { name: bindingName, executionContextName: worldName }));
    const script = observationScript(sourceHost, approvedHosts);
    const registered = await bounded(() => cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: script, worldName, runImmediately: true }));
    if (!record(registered) || typeof registered.identifier !== 'string') throw new Error();
    scriptId = registered.identifier;
    async function collect(snapshot: number) {
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
          let observation: Observation | undefined;
          let rootNodeCount = 0;
          let rootContext = 0;
          let rootIdentities: number[] = [], rootClasses: DocumentFacts['classes'] = [];
          let rootSemantics: string[] = [];
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
                if (index === 0) { page = { url: data.url, title: data.title }; observation = data.observation; rootNodeCount = data.nodes.length; rootContext = world.executionContextId as number; rootIdentities = data.identities; rootClasses = data.classes; rootSemantics = data.semantics; }
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
          return { facts: { snapshot, page, frames, nodes, secrets }, observation, rootNodeCount, rootContext, rootIdentities, rootClasses, rootSemantics };
        });
        if (closed) throw new Error();
        if (overflow) throw new Error();
        result.facts.secrets.push(...history.values());
        return result;
      } catch { throw new Error('internal'); }
    }
    function projectTargets(result: Awaited<ReturnType<typeof collect>>) {
      const { facts, rootNodeCount, rootContext, rootIdentities, rootClasses, rootSemantics } = result;
      const filtered = filterTextSnapshot(facts);
      if (!filtered.ok || closed || !Array.isArray(rootIdentities) || rootIdentities.length !== rootNodeCount || !rootIdentities.every(id => Number.isSafeInteger(id) && id > 0) || !Array.isArray(rootClasses) || rootClasses.length !== rootNodeCount || !rootClasses.every(value => value === null || value === 'blocked-payment' || value === 'blocked-change') || !Array.isArray(rootSemantics) || rootSemantics.length !== rootNodeCount || !rootSemantics.every(value => typeof value === 'string')) throw new Error('internal');
      const elements = new Map(filtered.snapshot.elements.map(element => [element.n, element]));
      const documentDescriptor = createHmac('sha256', descriptorKey).update(JSON.stringify({ page: facts.page, frames: facts.frames, nodes: facts.nodes, classes: rootClasses, semantics: rootSemantics })).digest('hex');
      const candidates = facts.nodes.slice(0, rootNodeCount).map((node, index) => {
        const element = elements.get(node.n);
        return { nodeNumber: node.n, identity: `${rootContext}:${rootIdentities[index]}`, descriptor: `${documentDescriptor}:${node.n}`, visible: node.visible && !!element, enabled: !node.state?.split(' ').includes('disabled'), sourceFrame: node.frame === 0, secretField: !!node.field, prohibited: rootClasses[index], text: element?.text ?? '' };
      });
      return { candidates, elements };
    }
    return {
    eventAddress(raw: string) {
      if (closed || overflow) throw new Error('internal');
      return filterEventAddress(raw, [...history.values()]);
    },
    loginObservations() {
      if (closed) throw new Error('internal');
      return { manualInputSeen, hasKnownSecret: history.size > 0 || overflow };
    },
    finishLoginObservation() {
      if (closed) throw new Error('internal');
      observationFinished = true;
    },
    async collectText(snapshot: number): Promise<unknown> {
      const { facts } = await collect(snapshot);
      if (closed) throw new Error('internal');
      return facts;
    },
    async observeTargets(snapshot: number) {
      const result = await collect(snapshot);
      return { snapshotNumber: snapshot, candidates: projectTargets(result).candidates };
    },
    async readObservedTarget(snapshot: number, nodeNumber: number, proof: { identity: string; descriptor: string }, deep = false): Promise<{ ok: true; text: string } | { ok: false; code: 'stale' | 'internal' }> {
      try {
        const result = await collect(snapshot);
        const { candidates, elements } = projectTargets(result);
        const matches = candidates.filter(candidate => candidate.nodeNumber === nodeNumber);
        const target = matches[0];
        if (matches.length !== 1 || !proof || target.identity !== proof.identity || target.descriptor !== proof.descriptor || !target.visible || !target.enabled || !target.sourceFrame || target.secretField || target.prohibited !== null) return { ok: false, code: 'stale' };
        const included = new Set([nodeNumber]);
        const texts: string[] = [];
        for (const node of result.facts.nodes.slice(0, result.rootNodeCount)) {
          if (deep && node.parent !== undefined && included.has(node.parent)) included.add(node.n);
          if (included.has(node.n)) {
            const element = elements.get(node.n);
            if (element?.text) texts.push(element.text);
          }
        }
        return { ok: true, text: texts.join(' ') };
      } catch { return { ok: false, code: 'internal' }; }
    },
    async collectFrame(snapshot: number) {
      const collected = await collect(snapshot);
      const { facts, observation: observed, rootNodeCount, rootContext } = collected;
      const binding = { snapshotNumber: snapshot, candidates: projectTargets(collected).candidates };
      if (closed) throw new Error('internal');
      const filtered = filterTextSnapshot(facts);
      if (!observed || !filtered.ok) throw new Error('internal');
      let plan: { masks: Rect[]; labels: { x: number; y: number; number: number }[] } | null = null;
      try {
        // CDP exposes closed shadow roots without executing page-owned code.
        const dom = await bounded(() => cdp.send('DOM.getDocument', { depth: -1, pierce: true }));
        if (closed) throw new Error('internal');
        const shadowRoots: number[] = [];
        const findShadowHosts = (value: unknown): void => {
          if (Array.isArray(value)) { for (const child of value) findShadowHosts(child); return; }
          if (!record(value)) return;
          if (Array.isArray(value.shadowRoots) && value.shadowRoots.some(root => !record(root) || root.shadowRootType !== 'user-agent')) {
            for (const root of value.shadowRoots) {
              if (!record(root)) throw new Error();
              if (root.shadowRootType === 'user-agent') continue;
              if (!Number.isSafeInteger(root.backendNodeId)) throw new Error();
              shadowRoots.push(root.backendNodeId as number);
              findShadowHosts(root);
            }
          }
          for (const key of ['children', 'contentDocument']) if (value[key]) findShadowHosts(value[key]);
        };
        if (!record(dom) || !record(dom.root)) throw new Error();
        findShadowHosts(dom.root);
        if (shadowRoots.length > 256) throw new Error();
        if (observed.unsupported || observed.geometry.length !== rootNodeCount ||
            !Number.isSafeInteger(observed.width) || !Number.isSafeInteger(observed.height) || observed.width < 1 || observed.height < 1) throw new Error();
        const masks: Rect[] = [], labels: { x: number; y: number; number: number }[] = [];
        const elements = new Map(filtered.snapshot.elements.map(element => [element.n, element]));
        const add = (r: Rect, padding = 4) => {
          if (![r.x, r.y, r.width, r.height].every(Number.isFinite)) throw new Error();
          if (r.width <= 0 || r.height <= 0) return;
          const x = Math.max(0, Math.floor(r.x - padding)), y = Math.max(0, Math.floor(r.y - padding));
          const right = Math.min(observed.width, Math.ceil(r.x + r.width + padding));
          const bottom = Math.min(observed.height, Math.ceil(r.y + r.height + padding));
          if (right > x && bottom > y) masks.push({ x, y, width: right - x, height: bottom - y });
        };
        const protectedNodes = new Set<number>();
        for (const backendNodeId of shadowRoots) {
          const resolved = await bounded(() => cdp.send('DOM.resolveNode', { backendNodeId, executionContextId: rootContext }));
          if (!record(resolved) || !record(resolved.object) || typeof resolved.object.objectId !== 'string') throw new Error();
          const objectId = resolved.object.objectId;
          let result: unknown;
          try { result = await bounded(() => cdp.send('Runtime.callFunctionOn', { objectId, functionDeclaration: shadowGeometry, returnByValue: true })); }
          finally { await bounded(() => cdp.send('Runtime.releaseObject', { objectId })); }
          if (!record(result) || result.exceptionDetails || !record(result.result) || !record(result.result.value)) throw new Error();
          const value = result.result.value;
          if (!Number.isSafeInteger(value.hostId) || !Array.isArray(value.rects) || value.rects.length > 20001) throw new Error();
          const index = collected.rootIdentities.indexOf(value.hostId as number);
          if (index < 0) throw new Error();
          protectedNodes.add(index);
          for (const rect of value.rects) { if (!record(rect)) throw new Error(); add(rect as unknown as Rect); }
        }
        for (let i = 0; i < rootNodeCount; i++) {
          const node = facts.nodes[i], geometry = observed.geometry[i], element = elements.get(node.n);
          if (geometry.mask) { add(geometry.rect, node.role === 'input' && node.field && observed.viewport ? 0 : 4); protectedNodes.add(i); }
          // Comparing with the domain result also covers split secrets across nodes.
          const normalized = node.text.normalize('NFKC').replace(/\p{White_Space}/gu, ' ').replace(/[\p{Cf}\p{Cc}]/gu, '').replace(/ +/g, ' ');
          if (!element || element.text !== normalized) {
            if (geometry.button) { add(geometry.rect); protectedNodes.add(i); }
            else if (geometry.runs.length) { for (const run of geometry.runs) add(run); protectedNodes.add(i); }
          }
          const r = geometry.rect;
          if (element && r.width > 0 && r.height > 0 && r.x < observed.width && r.y < observed.height && r.x + r.width > 0 && r.y + r.height > 0)
            labels.push({ x: Math.max(0, Math.floor(r.x)), y: Math.max(0, Math.floor(r.y)), number: element.n });
        }
        observed.maskAnimationActive = !Array.isArray(observed.animationTargets) || observed.animationTargets.some(target =>
          target === null || [...protectedNodes].some(index => observed.geometry[index].ancestors.includes(target)));
        plan = { masks, labels };
      } catch { plan = null; }
      if (closed) throw new Error('internal');
      return { facts, plan, binding, viewport: observed.viewport ?? { x: NaN, y: NaN, width: NaN, height: NaN }, revision: observed.revision, animationIds: [`document:${rootContext}`, ...observed.animationIds], viewportStable: observed.viewportStable, maskAnimationActive: observed.maskAnimationActive };
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      removeListeners(); contexts.clear(); frameUrls.clear(); history.clear(); historySize = 0;
      let failed = false;
      try { if (scriptId) await bounded(() => cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId })); } catch { failed = true; }
      try { await bounded(() => cdp.detach()); } catch { failed = true; }
      if (failed) throw new Error('internal');
    },
    };
  } catch { closed = true; removeListeners(); contexts.clear(); frameUrls.clear(); history.clear(); try { await bounded(() => cdp.detach()); } catch {} throw new Error('internal'); }
}

export declare const prepareDomCollector: typeof prepare;
declare const exports: { prepareDomCollector: typeof prepare };
exports.prepareDomCollector = prepare;
