const { filterTextSnapshot, filterEventAddress, detectPaintMasks } =
  require('../../domain/snapshot-filter.ts') as typeof import('../../domain/snapshot-filter.ts');
const { createHmac, randomBytes } = require('node:crypto') as typeof import('node:crypto');

type Cdp = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
  on(
    event: 'Runtime.executionContextCreated',
    listener: (event: {
      context: { id: number; name: string; origin: string; auxData?: { frameId?: string } };
    }) => void,
  ): unknown;
  on(
    event: 'Runtime.executionContextDestroyed',
    listener: (event: { executionContextId: number }) => void,
  ): unknown;
  on(event: 'Runtime.executionContextsCleared', listener: () => void): unknown;
  on(
    event: 'Runtime.bindingCalled',
    listener: (event: { name: string; payload: string; executionContextId: number }) => void,
  ): unknown;
  on(
    event: 'Page.frameNavigated',
    listener: (event: { frame: { id: string; url: string } }) => void,
  ): unknown;
  off(
    event: 'Runtime.executionContextCreated',
    listener: (event: {
      context: { id: number; name: string; origin: string; auxData?: { frameId?: string } };
    }) => void,
  ): unknown;
  off(
    event: 'Runtime.executionContextDestroyed',
    listener: (event: { executionContextId: number }) => void,
  ): unknown;
  off(event: 'Runtime.executionContextsCleared', listener: () => void): unknown;
  off(
    event: 'Runtime.bindingCalled',
    listener: (event: { name: string; payload: string; executionContextId: number }) => void,
  ): unknown;
  off(
    event: 'Page.frameNavigated',
    listener: (event: { frame: { id: string; url: string } }) => void,
  ): unknown;
};
type FrameTree = { frame: { id: string; url: string }; childFrames?: FrameTree[] };
type FrameFact = { index: number; host: string; foreign: boolean; unavailable: boolean };
type NodeFact = {
  n: number;
  frame: number;
  parent?: number;
  visible: boolean;
  role: string;
  text: string;
  state?: string;
  field?: 'empty' | 'filled' | 'sealed';
  href?: string;
  attrs?: Record<string, string>;
};
type Secret = { value: string; kind: 'login' | 'password' | 'code' };
type Rect = { x: number; y: number; width: number; height: number };
type PaintStyle = { shadow: string; filter: string; reflection: string; reflectionBox: boolean };
type Pseudo = 'before' | 'after';
type PaintRun = {
  owner: number;
  text: string;
  bounds: Rect[];
  pseudo?: Pseudo;
  style?: PaintStyle;
  backendNodeId?: number;
};
type Shadow = { index: number; backendNodeId: number; bounds: Rect[] | null };
type Geometry = {
  rect: Rect;
  runs: Rect[];
  mask: boolean;
  button: boolean;
  ancestors: number[];
  frameUrl: string | null;
  transformed: boolean;
  style?: PaintStyle;
  svg?: boolean;
};
type Viewport = { x: number; y: number; width: number; height: number };
type Observation = {
  viewport: Viewport;
  geometry: Geometry[];
  width: number;
  height: number;
  revision: number;
  animationIds: string[];
  animationTargets: (number | null)[];
  viewportStable: boolean;
  maskAnimationActive: boolean;
  unsupported: boolean;
  unobservedEmbeds: boolean;
  paint?: PaintRun[];
};
type DocumentFacts = {
  url: string;
  title: string;
  nodes: Omit<NodeFact, 'n' | 'frame' | 'parent'>[];
  parents: (number | null)[];
  identities: number[];
  classes: ('blocked-payment' | 'blocked-change' | null)[];
  semantics: string[];
  secrets: Secret[];
  embeds: { url: string; visible: boolean }[];
  observation: Observation;
};
type ParticipatingWorld = {
  frameId: string;
  parentFrameId: string | null;
  url: string;
  context: number;
  base: number;
  count: number;
  identities: number[];
  observation: Observation;
  projection?: Region;
  shadows?: Shadow[];
};
type Region = { x: number; y: number; clip: Rect };
type Label = { x: number; y: number; number: number };
type Plan = { masks: Rect[]; labels: Label[] };
type WorldPlan = Plan & { maskAnimationActive: boolean };

// This expression is owned by the adapter and runs only in its isolated world.
const hasTransform = `style => style.transform !== 'none' || style.perspective !== 'none' ||
  style.scale !== 'none' || style.rotate !== 'none' || style.translate !== 'none' || style.offsetPath !== 'none'`;
const expression = String.raw`(() => {
  const nodes = [], parents = [], identities = [], classes = [], semantics = [], secrets = [], embeds = [], geometry = [], paint = [];
  const visitedEmbeds = new Set(), hasTransform = ${hasTransform};
  const state = globalThis.__foliomeObservation || (globalThis.__foliomeObservation = (() => {
    const state = { revision: 0, ids: new WeakMap(), next: 1, watched: new WeakSet() };
    state.observer = new MutationObserver(() => { state.revision++; });
    state.observer.observe(document, { subtree: true, attributes: true, childList: true, characterData: true });
    for (const event of ['scroll', 'resize', 'pointerover', 'pointerout', 'focusin', 'transitionstart', 'animationstart', 'selectionchange'])
      addEventListener(event, () => { state.revision++; }, true);
    if (visualViewport) for (const event of ['scroll', 'resize']) visualViewport.addEventListener(event, () => { state.revision++; });
    return state;
  })());
  if (state.observer.takeRecords().length) state.revision++;
  let unsupported = !!CSS.highlights?.size;
  const selection = getSelection();
  const selectionPainted = selection && !selection.isCollapsed;
  let paintSize = 0;
  const pushPaint = (owner, text, bounds, extra) => {
    paintSize += text.length;
    if (paint.length >= 20000 || paintSize > 1024 * 1024 || bounds.length > 20001) {
      unsupported = true;
      return;
    }
    const previous = paint.at(-1);
    if (!extra && previous && previous.owner === owner && !previous.pseudo) {
      if (previous.bounds.length + bounds.length > 20001) { unsupported = true; return; }
      previous.text += text;
      for (const rect of bounds) previous.bounds.push(rect);
    } else {
      paint.push({ owner, text, bounds, ...extra });
    }
  };
  const rectValue = r => ({ x: r.x, y: r.y, width: r.width, height: r.height });
  const forbidden = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);
  const fieldRoles = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);
  const safeAttrs = ['id', 'name', 'class', 'data-testid', 'type', 'autocomplete', 'placeholder', 'aria-label'];
  const html = 'http://www.w3.org/1999/xhtml', svg = 'http://www.w3.org/2000/svg';
  const paintStyle = (style, reflectionBox) => {
    if (style.textTransform !== 'none' || parseFloat(style.webkitTextStrokeWidth) !== 0 ||
        !['1', 'normal'].includes(style.zoom) || style.clipPath !== 'none' ||
        style.clip !== 'auto' || style.maskImage !== 'none') unsupported = true;
    return {
      shadow: style.textShadow, filter: style.filter, reflection: style.webkitBoxReflect,
      reflectionBox,
    };
  };
  const clippedSvg = (element, style) => {
    // Only the outer SVG viewport can prove clipping of the use-instance tree.
    if (style.overflowX !== 'hidden' || style.overflowY !== 'hidden' ||
        element.getClientRects().length !== 1 || !element.parentElement ||
        element.parentElement.namespaceURI !== html) return false;
    const tags = new Set(['defs', 'g', 'text', 'tspan', 'use', 'path', 'rect', 'circle', 'ellipse', 'line', 'polygon', 'polyline', 'title', 'desc']);
    for (const child of element.querySelectorAll('*')) {
      if (child.namespaceURI !== svg || !tags.has(child.localName)) return false;
      if (child.localName !== 'use') continue;
      if (!(child instanceof SVGUseElement)) return false;
      const href = child.href.baseVal;
      if (!href.startsWith('#') || href.length === 1) return false;
      const local = new URL(location.href), reference = new URL(href, child.baseURI);
      local.hash = ''; reference.hash = '';
      if (reference.href !== local.href) return false;
      const target = document.getElementById(href.slice(1));
      if (!target || !element.contains(target) || target.namespaceURI !== svg ||
          !['text', 'path', 'rect', 'circle', 'ellipse', 'line', 'polygon', 'polyline'].includes(target.localName) ||
          child.href.animVal !== href) return false;
    }
    return true;
  };
  const visit = (element, parent, ancestorsVisible, insideSvg = false) => {
    if (nodes.length >= 10000) throw new Error();
    const tag = element.tagName.toUpperCase();
    if (forbidden.has(tag)) return;
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    const svgRoot = element.namespaceURI === svg && !insideSvg;
    if (svgRoot && (element.localName !== 'svg' || !clippedSvg(element, style)) ||
        element.namespaceURI !== html && element.namespaceURI !== svg) unsupported = true;
    const subtreeVisible = ancestorsVisible && style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0 && !element.hasAttribute('hidden') && !element.hasAttribute('inert') && element.getAttribute('aria-hidden') !== 'true';
    const visible = subtreeVisible && rect.width > 0 && rect.height > 0;
    const frame = tag === 'IFRAME' || tag === 'FRAME';
    const embed = frame || tag === 'OBJECT' || tag === 'EMBED';
    const frameUrl = frame && element.src ? element.src : null;
    if (frameUrl) embeds.push({ url: frameUrl, visible });
    if (embed) visitedEmbeds.add(element);
    if (!insideSvg && !svgRoot && !['IMG', 'CANVAS', 'VIDEO'].includes(tag) && !['none', 'normal'].includes(style.content))
      unsupported = true;
    if (!insideSvg && !svgRoot) {
      if (style.display === 'list-item' &&
          (!['none', 'normal'].includes(getComputedStyle(element, '::marker').content) ||
           !['none', 'disc', 'circle', 'square', 'decimal', 'decimal-leading-zero',
             'lower-alpha', 'upper-alpha', 'lower-roman', 'upper-roman'].includes(style.listStyleType)))
        unsupported = true;
      const specialText = selectionPainted ? ['::first-letter', '::first-line', '::selection']
        : ['::first-letter', '::first-line'];
      for (const kind of specialText) {
        const special = getComputedStyle(element, kind);
        const inheritedShadow = kind === '::selection' ? 'none' : style.textShadow;
        if (special.textShadow !== 'none' && special.textShadow !== inheritedShadow ||
            special.filter !== 'none' || special.webkitBoxReflect !== 'none') unsupported = true;
        paintStyle(special, false);
      }
    }
    const appearance = insideSvg ? undefined : paintStyle(style,
      style.webkitBoxReflect === 'none' ||
      (['block', 'inline-block', 'flow-root', 'flex', 'inline-flex', 'grid', 'inline-grid'].includes(style.display) &&
        element.getClientRects().length === 1));
    const observePseudo = (owner, kind) => {
      if (insideSvg || svgRoot) return;
      const pseudo = getComputedStyle(element, '::' + kind);
      if (pseudo.content === 'none' || pseudo.content === 'normal') return;
      if (hasTransform(pseudo) || pseudo.webkitBoxReflect !== 'none' ||
          pseudo.display === 'list-item') unsupported = true;
      pushPaint(owner, pseudo.content, [], { pseudo: kind, style: paintStyle(pseudo, false) });
    };
    const role = (element.getAttribute('role') || tag.toLowerCase()).toLowerCase();
    const closedField = element.isContentEditable || element.hasAttribute('contenteditable') || role === 'slider';
    const type = tag === 'INPUT' ? element.type.toLowerCase() : '';
    const button = tag === 'INPUT' && ['button', 'submit', 'reset'].includes(type);
    const choice = tag === 'INPUT' && ['checkbox', 'radio'].includes(type);
    const field = closedField || tag === 'INPUT' && !button && !choice || tag === 'SELECT' || tag === 'TEXTAREA' || fieldRoles.has(role);
    let text = button ? element.value : '';
    if (!field) for (const child of element.childNodes) if (child.nodeType === 3) text += child.nodeValue || '';
    const fact = { visible, role, text: visible ? text : '' };
    if (field) {
      const type = (element.getAttribute('type') || '').toLowerCase();
      const textual = tag === 'TEXTAREA' || tag === 'INPUT' && ['', 'text', 'password', 'email', 'tel', 'url', 'search'].includes(type);
      const value = !closedField && textual && visible && typeof element.value === 'string' ? element.value : '';
      fact.field = closedField || type === 'password' ? 'sealed' : value ? 'filled' : 'empty';
      if (value) secrets.push({ value, kind: type === 'password' ? 'password' : 'login' });
    }
    const nodeState = [];
    if (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') nodeState.push('disabled');
    if (element.getAttribute('aria-checked') === 'true' || tag === 'INPUT' && element.checked === true) nodeState.push('checked');
    if (nodeState.length) fact.state = nodeState.join(' ');
    if (tag === 'A' && element.hasAttribute('href')) fact.href = element.href;
    const attrs = {};
    for (const key of safeAttrs) if (element.hasAttribute(key)) attrs[key] = element.getAttribute(key);
    if (Object.keys(attrs).length) fact.attrs = attrs;
    if (!state.ids.has(element)) state.ids.set(element, state.next++);
    identities.push(state.ids.get(element));
    const label = [text, element.getAttribute('aria-label') || '', element.getAttribute('title') || '', (tag === 'BUTTON' || button) ? element.value : ''].join(' ').toLowerCase();
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
    const runs = [];
    geometry.push({ rect: rectValue(rect), runs, button, ancestors, frameUrl,
      transformed: !insideSvg && hasTransform(style), mask: field || embed || svgRoot,
      style: appearance, ...(svgRoot ? { svg: true } : {}) });
    observePseudo(index, 'before');
    if (button && !insideSvg && !svgRoot && text && rect.width > 0 && rect.height > 0)
      pushPaint(index, text, [rectValue(rect)]);
    for (const child of element.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (!field) visit(child, visible ? index : parent, subtreeVisible, insideSvg || svgRoot);
        else if (tag !== 'SELECT' && !insideSvg) unsupported = true;
      } else if (!insideSvg && !svgRoot && child.nodeType === Node.TEXT_NODE && child.nodeValue &&
                 (!field || !['INPUT', 'SELECT', 'TEXTAREA'].includes(tag))) {
        const range = document.createRange(); range.selectNodeContents(child);
        const bounds = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0).map(rectValue);
        if (!bounds.length) continue;
        if (field) {
          // The field value is private. Its drawn overflow is protected without reading it into the flow.
          for (const boundsRect of bounds) runs.push(boundsRect);
        } else {
          for (const boundsRect of bounds) runs.push(boundsRect);
          pushPaint(index, child.nodeValue, bounds);
        }
      }
    }
    observePseudo(index, 'after');
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
  const unobservedEmbeds = Array.from(document.querySelectorAll('iframe,frame,object,embed')).some(el => !visitedEmbeds.has(el));
  return { url: location.href, title: document.title, nodes, parents, identities, classes, semantics, secrets, embeds, observation: { viewport: { x: scrollX, y: scrollY, width: innerWidth, height: innerHeight }, geometry, width: innerWidth, height: innerHeight, revision: state.revision, animationIds, animationTargets, viewportStable, maskAnimationActive: false, unsupported, unobservedEmbeds, paint } };
})()`;

const worldName = 'foliome-dom-collector';
// Invoked on the frame owner resolved by CDP in the parent's isolated world.
const frameGeometry = `function() {
  if (!(this instanceof HTMLIFrameElement || this instanceof HTMLFrameElement) ||
      !this.isConnected || this.ownerDocument !== document) throw new Error();
  const state = globalThis.__foliomeObservation;
  if (!state || !state.ids.has(this)) throw new Error();
  const hasTransform = ${hasTransform}, transforms = [];
  const style = getComputedStyle(this), bounds = this.getBoundingClientRect();
  for (let el = this; el; el = el.parentElement) {
    if (!state.ids.has(el)) throw new Error();
    if (hasTransform(getComputedStyle(el))) transforms.push(state.ids.get(el));
  }
  const left = parseFloat(style.paddingLeft), top = parseFloat(style.paddingTop);
  return {
    id: state.ids.get(this), src: this.src, transforms,
    rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    content: {
      x: bounds.x + this.clientLeft + left, y: bounds.y + this.clientTop + top,
      width: this.clientWidth - left - parseFloat(style.paddingRight),
      height: this.clientHeight - top - parseFloat(style.paddingBottom),
    },
  };
}`;
// Invoked on the exact CDP-resolved root in the collector's isolated world.
const shadowGeometry = `function() {
  if (!(this instanceof ShadowRoot) || !this.host.isConnected || this.host.ownerDocument !== document) throw new Error();
  const state = globalThis.__foliomeObservation;
  if (!state || !state.ids.has(this.host)) throw new Error();
  if (!state.watched.has(this)) {
    state.observer.observe(this, { subtree: true, attributes: true, childList: true, characterData: true });
    state.watched.add(this);
  }
  const hostId = state.ids.get(this.host), mode = this.mode;
  try {
    if (this.host.getAnimations({ subtree: true }).some(a => a.playState === 'running' || a.playState === 'pending')) throw new Error();
    const hasTransform = ${hasTransform};
    const bounds = [], add = r => {
      if (bounds.length >= 20001) throw new Error();
      bounds.push({ x: r.x, y: r.y, width: r.width, height: r.height });
    };
    add(this.host.getBoundingClientRect());
    let count = 0;
    const visit = node => {
      if (++count > 10000) throw new Error();
      if (node.nodeType === Node.COMMENT_NODE) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const range = document.createRange(); range.selectNodeContents(node);
        for (const rect of range.getClientRects()) add(rect);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) throw new Error();
      const el = node, style = getComputedStyle(el);
      if (el.getAnimations().some(a => a.playState === 'running' || a.playState === 'pending') ||
          el.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
          !['DIV', 'SPAN', 'P', 'B', 'I', 'STRONG', 'EM', 'SMALL', 'BR'].includes(el.tagName) || el.shadowRoot ||
          style.textShadow !== 'none' || style.boxShadow !== 'none' || style.filter !== 'none' ||
          style.webkitBoxReflect !== 'none' || hasTransform(style) ||
          style.textTransform !== 'none' || parseFloat(style.webkitTextStrokeWidth) !== 0 ||
          !['1', 'normal'].includes(style.zoom) || style.clipPath !== 'none' || style.clip !== 'auto' ||
          style.maskImage !== 'none' || style.overflowX !== 'visible' || style.overflowY !== 'visible' ||
          style.outlineStyle !== 'none') throw new Error();
      for (const pseudo of ['::before', '::after']) {
        const content = getComputedStyle(el, pseudo).content;
        if (content !== 'none' && content !== 'normal') throw new Error();
      }
      for (const pseudo of ['::first-letter', '::first-line', '::selection']) {
        const special = getComputedStyle(el, pseudo);
        if (special.textShadow !== 'none' || special.filter !== 'none' ||
            special.webkitBoxReflect !== 'none' || special.textTransform !== 'none' ||
            parseFloat(special.webkitTextStrokeWidth) !== 0) throw new Error();
      }
      add(el.getBoundingClientRect());
      for (const child of el.childNodes) visit(child);
    };
    for (const child of this.childNodes) visit(child);
    return { hostId, mode, bounds };
  } catch {
    return { hostId, mode, bounds: null };
  }
}`;
const pseudoHostIdentity = `function() {
  const state = globalThis.__foliomeObservation;
  if (!(this instanceof Element) || this.ownerDocument !== document || !this.isConnected || !state)
    throw new Error();
  return { id: state.ids.get(this) ?? null };
}`;
const documentObservation = `(() => {
  const state = globalThis.__foliomeObservation;
  if (!state || !document.documentElement) throw new Error();
  if (state.observer.takeRecords().length) state.revision++;
  return { url: location.href, revision: state.revision,
    viewport: { x: scrollX, y: scrollY, width: innerWidth, height: innerHeight } };
})()`;
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
    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          clearTimeout(timer);
          reject(new Error('internal'));
        },
      );
  });
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function rect(value: unknown): value is Rect {
  return record(value) && [value.x, value.y, value.width, value.height].every(Number.isFinite);
}
function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
function intersection(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x,
    height = Math.min(a.y + a.height, b.y + b.height) - y;
  if (width > 0 && height > 0) return { x, y, width, height };
}
type Offset = { x: number; y: number; blur: number };
type Effects = {
  shadows: Offset[];
  filters: Offset[];
  reflection?: { direction: string; gap: number };
};

function cssParts(css: string, separator: ' ' | ','): string[] {
  if (css.length > 4096) throw new Error();
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const char = css[i];
    if (char === '(') depth++;
    if (char === ')') {
      depth--;
      if (depth < 0) throw new Error();
    }
    if (depth === 0 && char === separator) {
      const part = css.slice(start, i).trim();
      if (part) parts.push(part);
      else if (separator === ',') throw new Error();
      start = i + 1;
    }
  }
  const last = css.slice(start).trim();
  if (depth || !last) throw new Error();
  parts.push(last);
  return parts;
}

function cssPixels(css: string): number {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)px$/.test(css)) throw new Error();
  const value = Number(css.slice(0, -2));
  if (!Number.isFinite(value) || Math.abs(value) > 65536) throw new Error();
  return value;
}

function shadowOffset(css: string): Offset {
  const parts = cssParts(css, ' ');
  // Chromium serializes computed colors as functions, and normally puts the color first.
  const color = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([a-z0-9 .,/%+-]+\)$/i;
  if (color.test(parts[0])) parts.shift();
  else if (color.test(parts.at(-1) ?? '')) parts.pop();
  if (parts.length < 2 || parts.length > 3) throw new Error();
  const [x, y, blur = 0] = parts.map(cssPixels);
  if (blur < 0) throw new Error();
  return { x, y, blur };
}

function paintEffects(style?: PaintStyle): Effects {
  if (!style) return { shadows: [], filters: [] };
  const shadows = style.shadow === 'none' ? [] : cssParts(style.shadow, ',').map(shadowOffset);
  const filters =
    style.filter === 'none'
      ? []
      : cssParts(style.filter, ' ').map((filter) => {
          if (!filter.startsWith('drop-shadow(') || !filter.endsWith(')')) throw new Error();
          return shadowOffset(filter.slice(12, -1));
        });
  if (shadows.length > 16 || filters.length > 8) throw new Error();
  if (style.reflection === 'none' || style.reflection === '') return { shadows, filters };
  const [direction, gap, mask, ...extra] = cssParts(style.reflection, ' ');
  if (
    !style.reflectionBox ||
    !['above', 'below', 'left', 'right'].includes(direction) ||
    mask !== 'none' ||
    extra.length
  )
    throw new Error();
  return { shadows, filters, reflection: { direction, gap: cssPixels(gap) } };
}

function padded(bounds: Rect, padding: number): Rect {
  return {
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: bounds.width + padding * 2,
    height: bounds.height + padding * 2,
  };
}

function shadowBounds(bounds: Rect, { x, y, blur }: Offset): Rect {
  // Four blur radii overcover Chromium's finite Gaussian support. Round out before rasterization.
  return padded({ ...bounds, x: bounds.x + x, y: bounds.y + y }, Math.ceil(4 * blur));
}

function reflectBounds(
  bounds: Rect,
  box: Rect,
  { direction, gap }: NonNullable<Effects['reflection']>,
): Rect {
  if (direction === 'above' || direction === 'below') {
    const axis = direction === 'above' ? 2 * box.y - gap : 2 * (box.y + box.height) + gap;
    return { ...bounds, y: axis - bounds.y - bounds.height };
  }
  const axis = direction === 'left' ? 2 * box.x - gap : 2 * (box.x + box.width) + gap;
  return { ...bounds, x: axis - bounds.x - bounds.width };
}

function withFilter(bounds: Rect[], filters: Offset[]): Rect[] {
  for (const filter of filters) {
    if (bounds.length > 256) throw new Error();
    bounds = [...bounds, ...bounds.map((area) => shadowBounds(area, filter))];
  }
  return bounds;
}

function withComposition(bounds: Rect[], effects: Effects, box: Rect): Rect[] {
  const { reflection, filters } = effects;
  if (!reflection) return withFilter(bounds, filters);
  if (box.width <= 0 || box.height <= 0 || bounds.length > 256) throw new Error();
  const original = [...bounds, box];
  const reflect = (area: Rect) => reflectBounds(area, box, reflection);
  const filtered = withFilter([...original, ...original.map(reflect)], filters);
  // Cover both orderings when the box is itself also filtered.
  return filters.length ? [...filtered, ...withFilter(original, filters).map(reflect)] : filtered;
}

function pseudoText(content: string): string {
  let text = '';
  let i = 0;
  while (i < content.length) {
    while (/\s/.test(content[i] ?? '')) i++;
    const quote = content[i++];
    if (quote !== '"' && quote !== "'") throw new Error();
    while (i < content.length && content[i] !== quote) {
      const char = content[i++];
      if (char !== '\\') {
        if (char === '\n' || char === '\r' || char === '\f') throw new Error();
        text += char;
        continue;
      }
      if (i === content.length) throw new Error();
      const hex = /^[\da-f]{1,6}/i.exec(content.slice(i, i + 6))?.[0];
      if (hex) {
        const code = parseInt(hex, 16);
        text +=
          code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
            ? '\ufffd'
            : String.fromCodePoint(code);
        i += hex.length;
        if (/[ \t\n\r\f]/.test(content[i] ?? '')) i++;
      } else {
        const escaped = content[i++];
        if (escaped === '\n' || escaped === '\r' || escaped === '\f') throw new Error();
        text += escaped;
      }
    }
    if (content[i++] !== quote) throw new Error();
  }
  return text;
}

function observedGeometry(world: ParticipatingWorld): boolean {
  const { observation, count, identities } = world;
  if (
    observation.unsupported !== false ||
    observation.unobservedEmbeds === true ||
    !Array.isArray(observation.geometry) ||
    observation.geometry.length !== count ||
    !Number.isSafeInteger(observation.width) ||
    !Number.isSafeInteger(observation.height) ||
    observation.width < 1 ||
    observation.height < 1
  )
    return false;
  if (observation.viewport === undefined) return world.parentFrameId === null;
  return (
    rect(observation.viewport) &&
    observation.unobservedEmbeds === false &&
    Array.isArray(observation.animationTargets) &&
    observation.animationTargets.every((target) => target === null || positiveId(target)) &&
    Array.isArray(identities) &&
    identities.length === count &&
    identities.every(positiveId) &&
    observation.geometry.every(
      (geometry, index) =>
        typeof geometry.transformed === 'boolean' &&
        typeof geometry.button === 'boolean' &&
        (geometry.frameUrl === null || typeof geometry.frameUrl === 'string') &&
        Array.isArray(geometry.ancestors) &&
        geometry.ancestors[0] === identities[index] &&
        geometry.ancestors.every(positiveId),
    )
  );
}
async function inspectNode(
  cdp: Cdp,
  backendNodeId: number,
  executionContextId: number,
  functionDeclaration: string,
): Promise<Record<string, unknown>> {
  const resolved = await bounded(() =>
    cdp.send('DOM.resolveNode', { backendNodeId, executionContextId }),
  );
  if (!record(resolved) || !record(resolved.object) || typeof resolved.object.objectId !== 'string')
    throw new Error();
  const objectId = resolved.object.objectId;
  try {
    const result = await bounded(() =>
      cdp.send('Runtime.callFunctionOn', { objectId, functionDeclaration, returnByValue: true }),
    );
    if (
      !record(result) ||
      result.exceptionDetails ||
      !record(result.result) ||
      !record(result.result.value)
    )
      throw new Error();
    return result.result.value;
  } finally {
    await bounded(() => cdp.send('Runtime.releaseObject', { objectId }));
  }
}
async function verifyWorld(cdp: Cdp, world: ParticipatingWorld): Promise<void> {
  const response = await bounded(() =>
    cdp.send('Runtime.evaluate', {
      expression: documentObservation,
      contextId: world.context,
      returnByValue: true,
    }),
  );
  const value =
    record(response) && !response.exceptionDetails && record(response.result)
      ? response.result.value
      : undefined;
  if (
    !record(value) ||
    value.url !== world.url ||
    value.revision !== world.observation.revision ||
    !rect(value.viewport) ||
    !sameRect(value.viewport, world.observation.viewport)
  )
    throw new Error();
}

async function observeShadows(cdp: Cdp, worlds: ParticipatingWorld[], nodes: NodeFact[]) {
  const dom = await bounded(() => cdp.send('DOM.getDocument', { depth: -1, pierce: true }));
  if (!record(dom) || !record(dom.root)) throw new Error();
  const byFrame = new Map(worlds.map((world) => [world.frameId, world]));
  const roots: {
    world: ParticipatingWorld;
    backend: number;
    mode: 'open' | 'closed';
    nested: boolean;
  }[] = [];
  const seen = new Set<ParticipatingWorld>();
  const visit = (
    value: unknown,
    world: ParticipatingWorld,
    insideShadow?: (typeof roots)[number],
  ) => {
    if (!record(value)) throw new Error();
    if (
      value.nodeType === 9 &&
      Array.isArray(value.children) &&
      value.children.some((child: unknown) => record(child) && child.frameId === world.frameId)
    )
      seen.add(world);
    for (const child of Array.isArray(value.children) ? value.children : [])
      visit(child, world, insideShadow);
    for (const shadow of Array.isArray(value.shadowRoots) ? value.shadowRoots : []) {
      if (!record(shadow)) throw new Error();
      const { backendNodeId: backend, shadowRootType: mode } = shadow;
      if (mode === 'user-agent') continue;
      if (insideShadow) {
        insideShadow.nested = true;
        continue;
      }
      if (!positiveId(backend) || (mode !== 'open' && mode !== 'closed') || roots.length >= 256)
        throw new Error();
      const root: (typeof roots)[number] = { world, backend, mode, nested: false };
      roots.push(root);
      visit(shadow, world, root);
    }
    if (!value.contentDocument || insideShadow) return;
    const child = typeof value.frameId === 'string' && byFrame.get(value.frameId);
    if (child && child.parentFrameId === world.frameId) visit(value.contentDocument, child);
  };
  visit(dom.root, worlds[0]);
  for (const world of worlds)
    if (world.observation.viewport && !seen.has(world)) world.observation.unsupported = true;
  const touched = new Set<ParticipatingWorld>();
  for (const { world, backend, mode, nested } of roots) {
    try {
      const value = await inspectNode(cdp, backend, world.context, shadowGeometry);
      if (!positiveId(value.hostId) || value.mode !== mode) throw new Error();
      const index = world.identities.indexOf(value.hostId);
      if (index < 0 || world.identities.lastIndexOf(value.hostId) !== index) throw new Error();
      if (mode === 'closed') {
        const node = nodes[world.base + index];
        node.state = node.state ? node.state + ' unavailable' : 'unavailable';
      }
      const bounds = nested ? null : value.bounds;
      if (
        bounds !== null &&
        (!Array.isArray(bounds) || bounds.length > 20001 || !bounds.every(rect))
      )
        throw new Error();
      world.shadows ??= [];
      world.shadows.push({ index, backendNodeId: backend, bounds });
      touched.add(world);
    } catch {
      world.observation.unsupported = true;
    }
  }
  for (const world of touched) {
    try {
      await verifyWorld(cdp, world);
    } catch {
      world.observation.unsupported = true;
    }
  }
}

const pseudoStyles = [
  'content',
  'text-shadow',
  'filter',
  '-webkit-box-reflect',
  'clip-path',
  'clip',
  'mask-image',
];

async function observePseudos(cdp: Cdp, worlds: ParticipatingWorld[]): Promise<void> {
  const candidates = worlds.filter(
    (world) => !world.observation.unsupported && world.observation.paint?.some((run) => run.pseudo),
  );
  if (!candidates.length) return;
  try {
    const snapshot = await bounded(() =>
      cdp.send('DOMSnapshot.captureSnapshot', {
        computedStyles: pseudoStyles,
        includeDOMRects: true,
      }),
    );
    if (!record(snapshot) || !Array.isArray(snapshot.documents) || !Array.isArray(snapshot.strings))
      throw new Error();
    const strings: unknown[] = snapshot.strings;
    for (const world of candidates) {
      try {
        const documents = snapshot.documents.filter(
          (doc: unknown) =>
            record(doc) &&
            typeof doc.frameId === 'number' &&
            strings[doc.frameId] === world.frameId,
        );
        if (documents.length !== 1) throw new Error();
        await measurePseudos(cdp, world, documents[0], strings);
        await verifyWorld(cdp, world);
      } catch {
        world.observation.unsupported = true;
      }
    }
  } catch {
    for (const world of candidates) world.observation.unsupported = true;
  }
}

async function measurePseudos(
  cdp: Cdp,
  world: ParticipatingWorld,
  doc: unknown,
  strings: readonly unknown[],
): Promise<void> {
  const { viewport, paint } = world.observation;
  if (
    !record(doc) ||
    typeof doc.documentURL !== 'number' ||
    strings[doc.documentURL] !== world.url ||
    doc.scrollOffsetX !== viewport.x ||
    doc.scrollOffsetY !== viewport.y ||
    !record(doc.nodes) ||
    !record(doc.layout) ||
    !paint
  )
    throw new Error();
  const { parentIndex, backendNodeId, pseudoType, nodeName } = doc.nodes;
  const { nodeIndex, styles, text, bounds } = doc.layout;
  if (
    !Array.isArray(parentIndex) ||
    !Array.isArray(backendNodeId) ||
    !Array.isArray(nodeName) ||
    parentIndex.length > 20000 ||
    parentIndex.length !== backendNodeId.length ||
    parentIndex.length !== nodeName.length ||
    !record(pseudoType) ||
    !Array.isArray(pseudoType.index) ||
    !Array.isArray(pseudoType.value) ||
    pseudoType.index.length !== pseudoType.value.length ||
    pseudoType.index.length > 256 ||
    !Array.isArray(nodeIndex) ||
    !Array.isArray(styles) ||
    !Array.isArray(text) ||
    !Array.isArray(bounds) ||
    nodeIndex.length > 40000 ||
    nodeIndex.length !== bounds.length ||
    nodeIndex.length !== styles.length ||
    nodeIndex.length !== text.length
  )
    throw new Error();
  const expected = new Map<string, PaintRun>();
  for (const run of paint) {
    if (!run.pseudo) continue;
    const key = world.identities[run.owner] + ':' + run.pseudo;
    if (expected.has(key)) throw new Error();
    expected.set(key, run);
  }
  const matches = new Map<number, { run: PaintRun; computed: string[]; rendered: string[] }>();
  const hostIds = new Map<number, number | null>();
  for (let i = 0; i < pseudoType.index.length; i++) {
    const kind = strings[pseudoType.value[i]];
    if (kind !== 'before' && kind !== 'after') continue;
    const index: number = pseudoType.index[i];
    const backend = backendNodeId[parentIndex[index]];
    const pseudoBackend = backendNodeId[index];
    if (!positiveId(backend) || !positiveId(pseudoBackend)) throw new Error();
    let id = hostIds.get(backend);
    if (id === undefined) {
      const value = await inspectNode(cdp, backend, world.context, pseudoHostIdentity);
      if (value.id !== null && !positiveId(value.id)) throw new Error();
      id = value.id;
      hostIds.set(backend, id);
    }
    const key = id + ':' + kind;
    const run = expected.get(key);
    if (!run) continue;
    expected.delete(key);
    if (!run.style) throw new Error();
    const { shadow, filter, reflection } = run.style;
    const computed = [run.text, shadow, filter, reflection, 'none', 'auto', 'none'];
    run.text = pseudoText(run.text);
    run.backendNodeId = pseudoBackend;
    matches.set(index, { run, computed, rendered: [] });
  }
  if (expected.size) throw new Error();
  for (let i = 0; i < nodeIndex.length; i++) {
    const index: number = nodeIndex[i];
    const isText = strings[nodeName[index]] === '#text';
    const match = matches.get(isText ? parentIndex[index] : index);
    if (!match) continue;
    const style = styles[i];
    const box = bounds[i];
    if (
      !Array.isArray(style) ||
      !match.computed.every((value, j) => strings[style[j]] === value) ||
      !Array.isArray(box) ||
      box.length !== 4 ||
      !box.every(Number.isFinite) ||
      box[2] < 0 ||
      box[3] < 0
    )
      throw new Error();
    const [x, y, width, height] = box;
    if (width > 0 && height > 0)
      match.run.bounds.push({ x: x - viewport.x, y: y - viewport.y, width, height });
    if (text[i] !== -1) {
      const rendered = strings[text[i]];
      if (typeof rendered !== 'string') throw new Error();
      if (!match.rendered.includes(rendered)) match.rendered.push(rendered);
    }
  }
  for (const { run, rendered } of matches.values()) {
    // Chromium may expose the anonymous text as a second layout row on the pseudo node.
    const whitespace = (value: string) => value.replace(/\s+/g, ' ').trim();
    if (
      run.bounds.length &&
      whitespace(run.text) &&
      !rendered.some((value) => whitespace(value) === whitespace(run.text)) &&
      whitespace(rendered.join('')) !== whitespace(run.text)
    )
      throw new Error();
  }
}

async function frameOwner(cdp: Cdp, child: ParticipatingWorld, parent: ParticipatingWorld) {
  const owner = await bounded(() => cdp.send('DOM.getFrameOwner', { frameId: child.frameId }));
  if (!record(owner) || !positiveId(owner.backendNodeId)) throw new Error();
  const { backendNodeId } = owner;
  const value = await inspectNode(cdp, backendNodeId, parent.context, frameGeometry);
  if (
    !positiveId(value.id) ||
    value.src !== child.url ||
    !rect(value.rect) ||
    !Array.isArray(value.transforms) ||
    !value.transforms.every(positiveId)
  )
    throw new Error();
  const index = parent.identities.indexOf(value.id);
  const geometry = parent.observation.geometry[index];
  if (
    index < 0 ||
    index !== parent.identities.lastIndexOf(value.id) ||
    !geometry ||
    geometry.frameUrl !== value.src ||
    geometry.mask !== true ||
    !sameRect(value.rect, geometry.rect) ||
    !Array.isArray(geometry.ancestors)
  )
    throw new Error();
  return {
    backendNodeId,
    index,
    bounds: value.rect,
    content: value.content,
    transforms: value.transforms,
  };
}
async function childRegion(
  cdp: Cdp,
  child: ParticipatingWorld,
  owner: Awaited<ReturnType<typeof frameOwner>>,
  parent: Region,
): Promise<Region | undefined> {
  const { observation } = child;
  const { content } = owner;
  if (
    !observedGeometry(child) ||
    observation.viewportStable !== true ||
    !rect(content) ||
    content.width !== observation.width ||
    content.height !== observation.height ||
    content.width !== observation.viewport.width ||
    content.height !== observation.viewport.height ||
    content.x < owner.bounds.x ||
    content.y < owner.bounds.y ||
    content.x + content.width > owner.bounds.x + owner.bounds.width ||
    content.y + content.height > owner.bounds.y + owner.bounds.height
  )
    return;
  const global = { ...content, x: parent.x + content.x, y: parent.y + content.y };
  const clip = intersection(global, parent.clip);
  if (!clip) return;
  // The CDP quad is already in the top viewport. Require it to match the local measurements.
  const model = await bounded(() =>
    cdp.send('DOM.getBoxModel', { backendNodeId: owner.backendNodeId }),
  );
  const { x, y, width, height } = global;
  const quad = [x, y, x + width, y, x + width, y + height, x, y + height];
  const measured = record(model) && record(model.model) ? model.model.content : undefined;
  if (
    !Array.isArray(measured) ||
    measured.length !== quad.length ||
    !quad.every((coordinate, index) => coordinate === measured[index])
  )
    return;
  return { x, y, clip };
}
function tree(value: unknown): FrameTree {
  if (
    !record(value) ||
    !record(value.frame) ||
    typeof value.frame.id !== 'string' ||
    typeof value.frame.url !== 'string' ||
    (value.childFrames !== undefined && !Array.isArray(value.childFrames))
  )
    throw new Error('internal');
  return {
    frame: { id: value.frame.id, url: value.frame.url },
    childFrames: (value.childFrames ?? []).map(tree),
  };
}
function host(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}
function configuredHost(value: unknown): string {
  if (typeof value !== 'string' || !value || /[\s/@?#\\:]/.test(value)) throw new Error('internal');
  const parsed = new URL('https://' + value);
  if (
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.port ||
    parsed.username ||
    parsed.password
  )
    throw new Error('internal');
  const normalized = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!normalized || normalized.endsWith('.')) throw new Error('internal');
  return normalized;
}
function trustedUrl(
  value: string,
  sourceHost: string,
  approvedHosts: ReadonlySet<string>,
): boolean {
  try {
    const parsed = new URL(value);
    const authority = value.match(/^https:\/\/([^/?#]*)/i)?.[1];
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return (
      !!authority &&
      !authority.includes('@') &&
      parsed.protocol === 'https:' &&
      !parsed.port &&
      !parsed.username &&
      !parsed.password &&
      (hostname === sourceHost ||
        hostname.endsWith('.' + sourceHost) ||
        approvedHosts.has(hostname))
    );
  } catch {
    return false;
  }
}

async function prepare(
  cdp: Cdp,
  config: { sourceHost: string; approvedHosts?: readonly string[] },
) {
  const descriptorKey = randomBytes(32);
  let closed = false;
  let scriptId: string | undefined;
  const contexts = new Map<number, { frameId: string; origin: string }>();
  const frameUrls = new Map<string, string>();
  const history = new Map<string, Secret>();
  let historySize = 0,
    overflow = false,
    manualInputSeen = false,
    observationFinished = false;
  let sourceHost = '';
  let approvedHosts = new Set<string>();
  const remember = (secret: Secret) => {
    if (observationFinished || !secret.value) return;
    const key = secret.kind + '\0' + secret.value;
    if (history.has(key)) return;
    if (history.size >= 4096 || historySize + secret.value.length > 1024 * 1024) {
      overflow = true;
      return;
    }
    history.set(key, secret);
    historySize += secret.value.length;
  };
  const contextCreated = ({
    context,
  }: {
    context: { id: number; name: string; origin: string; auxData?: { frameId?: string } };
  }) => {
    if (
      context.name === worldName &&
      context.auxData?.frameId &&
      trustedUrl(context.origin, sourceHost, approvedHosts)
    )
      contexts.set(context.id, { frameId: context.auxData.frameId, origin: context.origin });
  };
  const contextDestroyed = ({ executionContextId }: { executionContextId: number }) => {
    contexts.delete(executionContextId);
  };
  const contextsCleared = () => {
    contexts.clear();
  };
  const frameNavigated = ({ frame }: { frame: { id: string; url: string } }) => {
    frameUrls.set(frame.id, frame.url);
  };
  const bindingCalled = (event: { name: string; payload: string; executionContextId: number }) => {
    if (closed || event.name !== bindingName) return;
    const context = contexts.get(event.executionContextId);
    const url = context && frameUrls.get(context.frameId);
    if (
      !context ||
      !url ||
      !trustedUrl(url, sourceHost, approvedHosts) ||
      new URL(url).origin !== context.origin
    )
      return;
    try {
      const data: unknown = JSON.parse(event.payload);
      if (
        !record(data) ||
        typeof data.manual !== 'boolean' ||
        typeof data.value !== 'string' ||
        !['login', 'password', 'code'].includes(String(data.kind))
      ) {
        overflow = true;
        return;
      }
      manualInputSeen ||= data.manual;
      remember({ value: data.value, kind: data.kind as Secret['kind'] });
    } catch {
      overflow = true;
    }
  };
  const removeListeners = () => {
    if (typeof cdp.off !== 'function') return;
    cdp.off('Runtime.executionContextCreated', contextCreated);
    cdp.off('Runtime.executionContextDestroyed', contextDestroyed);
    cdp.off('Runtime.executionContextsCleared', contextsCleared);
    cdp.off('Runtime.bindingCalled', bindingCalled);
    cdp.off('Page.frameNavigated', frameNavigated);
  };
  try {
    if (!config || !Array.isArray(config.approvedHosts ?? [])) throw new Error();
    sourceHost = configuredHost(config.sourceHost);
    approvedHosts = new Set((config.approvedHosts ?? []).map(configuredHost));
    cdp.on('Runtime.executionContextCreated', contextCreated);
    cdp.on('Runtime.executionContextDestroyed', contextDestroyed);
    cdp.on('Runtime.executionContextsCleared', contextsCleared);
    cdp.on('Runtime.bindingCalled', bindingCalled);
    cdp.on('Page.frameNavigated', frameNavigated);
    await bounded(() => cdp.send('Page.enable'));
    const initial = await bounded(() => cdp.send('Page.getFrameTree'));
    if (!record(initial)) throw new Error();
    const rememberFrames = (frame: FrameTree) => {
      frameUrls.set(frame.frame.id, frame.frame.url);
      for (const child of frame.childFrames ?? []) rememberFrames(child);
    };
    rememberFrames(tree(initial.frameTree));
    await bounded(() => cdp.send('Runtime.enable'));
    await bounded(() =>
      cdp.send('Runtime.addBinding', { name: bindingName, executionContextName: worldName }),
    );
    const script = observationScript(sourceHost, approvedHosts);
    const registered = await bounded(() =>
      cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: script,
        worldName,
        runImmediately: true,
      }),
    );
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
          if (!rootHost || !trustedUrl(root.frame.url, sourceHost, approvedHosts))
            throw new Error();
          const frames: FrameFact[] = [],
            nodes: NodeFact[] = [],
            secrets: Secret[] = [];
          let page: { url: string; title: string } | undefined;
          let observation: Observation | undefined;
          let rootNodeCount = 0;
          let rootContext = 0;
          let rootIdentities: number[] = [],
            rootClasses: DocumentFacts['classes'] = [];
          let rootSemantics: string[] = [];
          const embeds: { url: string; visible: boolean }[] = [];
          const participatingWorlds: ParticipatingWorld[] = [];
          const visit = async (
            frame: FrameTree,
            foreignAncestor: boolean,
            parentAccessible: boolean,
            parentFrameId: string | null,
          ): Promise<void> => {
            if (frames.length >= 256) throw new Error();
            const frameHost = host(frame.frame.url);
            const foreign =
              foreignAncestor || !trustedUrl(frame.frame.url, sourceHost, approvedHosts);
            const index = frames.length;
            const fact: FrameFact = { index, host: frameHost, foreign, unavailable: false };
            frames.push(fact);
            if (!foreign && parentAccessible) {
              const base = nodes.length,
                secretBase = secrets.length,
                embedBase = embeds.length;
              try {
                const world = await send('Page.createIsolatedWorld', {
                  frameId: frame.frame.id,
                  worldName,
                });
                if (!record(world) || !Number.isSafeInteger(world.executionContextId))
                  throw new Error();
                const evaluation = await send('Runtime.evaluate', {
                  expression,
                  contextId: world.executionContextId,
                  returnByValue: true,
                });
                if (
                  !record(evaluation) ||
                  evaluation.exceptionDetails ||
                  !record(evaluation.result) ||
                  !record(evaluation.result.value)
                )
                  throw new Error();
                const data = evaluation.result.value as unknown as DocumentFacts;
                if (
                  typeof data.url !== 'string' ||
                  typeof data.title !== 'string' ||
                  !Array.isArray(data.nodes) ||
                  !Array.isArray(data.parents) ||
                  data.nodes.length !== data.parents.length ||
                  !Array.isArray(data.secrets) ||
                  !Array.isArray(data.embeds)
                )
                  throw new Error();
                if (
                  !trustedUrl(data.url, sourceHost, approvedHosts) ||
                  new URL(data.url).href !== new URL(frame.frame.url).href ||
                  host(data.url) !== frameHost
                )
                  throw new NavigationError();
                if (index === 0) {
                  page = { url: data.url, title: data.title };
                  observation = data.observation;
                  rootNodeCount = data.nodes.length;
                  rootContext = world.executionContextId as number;
                  rootIdentities = data.identities;
                  rootClasses = data.classes;
                  rootSemantics = data.semantics;
                }
                if (!data.observation || !Number.isSafeInteger(data.observation.revision))
                  throw new Error();
                for (let i = 0; i < data.nodes.length; i++) {
                  const parent = data.parents[i];
                  if (
                    parent !== null &&
                    (!Number.isSafeInteger(parent) || parent < 0 || parent >= i)
                  )
                    throw new Error();
                  nodes.push({
                    ...data.nodes[i],
                    n: base + i + 1,
                    frame: index,
                    ...(parent === null ? {} : { parent: base + parent + 1 }),
                  });
                }
                secrets.push(...data.secrets);
                embeds.push(...data.embeds);
                participatingWorlds.push({
                  frameId: frame.frame.id,
                  parentFrameId,
                  url: data.url,
                  context: world.executionContextId as number,
                  base,
                  count: data.nodes.length,
                  identities: data.identities,
                  observation: data.observation,
                });
              } catch (error) {
                nodes.length = base;
                secrets.length = secretBase;
                embeds.length = embedBase;
                if (index === 0 || error instanceof NavigationError) throw new Error();
                fact.unavailable = true;
              }
            } else if (!foreign) fact.unavailable = true;
            for (const child of frame.childFrames ?? []) {
              const matches = embeds.filter((e) => e.url === child.frame.url);
              await visit(
                child,
                foreign,
                parentAccessible && !fact.unavailable && matches.length === 1 && matches[0].visible,
                frame.frame.id,
              );
            }
          };
          await visit(root, false, true, null);
          for (const embed of embeds) {
            const embedHost = host(embed.url);
            if (
              embedHost &&
              !trustedUrl(embed.url, sourceHost, approvedHosts) &&
              !frames.some((f) => f.host === embedHost && f.foreign)
            ) {
              if (frames.length >= 256) throw new Error();
              frames.push({
                index: frames.length,
                host: embedHost,
                foreign: true,
                unavailable: true,
              });
            }
          }
          try {
            await observeShadows(cdp, participatingWorlds, nodes);
          } catch {
            if (observation) observation.unsupported = true;
          }
          const verify = await send('Page.getFrameTree');
          if (
            !record(verify) ||
            JSON.stringify(tree(verify.frameTree)) !== JSON.stringify(root) ||
            !page ||
            closed
          )
            throw new Error();
          return {
            facts: { snapshot, page, frames, nodes, secrets },
            observation,
            rootNodeCount,
            rootContext,
            rootIdentities,
            rootClasses,
            rootSemantics,
            participatingWorlds,
          };
        });
        if (closed) throw new Error();
        if (overflow) throw new Error();
        result.facts.secrets.push(...history.values());
        return result;
      } catch {
        throw new Error('internal');
      }
    }
    function projectTargets(result: Awaited<ReturnType<typeof collect>>) {
      const { facts, rootNodeCount, rootContext, rootIdentities, rootClasses, rootSemantics } =
        result;
      const filtered = filterTextSnapshot(facts);
      if (
        !filtered.ok ||
        closed ||
        !Array.isArray(rootIdentities) ||
        rootIdentities.length !== rootNodeCount ||
        !rootIdentities.every((id) => Number.isSafeInteger(id) && id > 0) ||
        !Array.isArray(rootClasses) ||
        rootClasses.length !== rootNodeCount ||
        !rootClasses.every(
          (value) => value === null || value === 'blocked-payment' || value === 'blocked-change',
        ) ||
        !Array.isArray(rootSemantics) ||
        rootSemantics.length !== rootNodeCount ||
        !rootSemantics.every((value) => typeof value === 'string')
      )
        throw new Error('internal');
      const elements = new Map(filtered.snapshot.elements.map((element) => [element.n, element]));
      const documentDescriptor = createHmac('sha256', descriptorKey)
        .update(
          JSON.stringify({
            page: facts.page,
            frames: facts.frames,
            nodes: facts.nodes,
            classes: rootClasses,
            semantics: rootSemantics,
          }),
        )
        .digest('hex');
      const candidates = facts.nodes.slice(0, rootNodeCount).map((node, index) => {
        const element = elements.get(node.n);
        return {
          nodeNumber: node.n,
          identity: `${rootContext}:${rootIdentities[index]}`,
          descriptor: `${documentDescriptor}:${node.n}`,
          visible: node.visible && !!element,
          enabled: !node.state?.split(' ').includes('disabled'),
          sourceFrame: node.frame === 0,
          secretField: !!node.field,
          prohibited: rootClasses[index],
          text: element?.text ?? '',
        };
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
      async readObservedTarget(
        snapshot: number,
        nodeNumber: number,
        proof: { identity: string; descriptor: string },
        deep = false,
      ): Promise<{ ok: true; text: string } | { ok: false; code: 'stale' | 'internal' }> {
        try {
          const result = await collect(snapshot);
          const { candidates, elements } = projectTargets(result);
          const matches = candidates.filter((candidate) => candidate.nodeNumber === nodeNumber);
          const target = matches[0];
          if (
            matches.length !== 1 ||
            !proof ||
            target.identity !== proof.identity ||
            target.descriptor !== proof.descriptor ||
            !target.visible ||
            !target.enabled ||
            !target.sourceFrame ||
            target.secretField ||
            target.prohibited !== null
          )
            return { ok: false, code: 'stale' };
          const included = new Set([nodeNumber]);
          const texts: string[] = [];
          for (const node of result.facts.nodes.slice(0, result.rootNodeCount)) {
            if (deep && node.parent !== undefined && included.has(node.parent))
              included.add(node.n);
            if (included.has(node.n)) {
              const element = elements.get(node.n);
              if (element?.text) texts.push(element.text);
            }
          }
          return { ok: true, text: texts.join(' ') };
        } catch {
          return { ok: false, code: 'internal' };
        }
      },
      async collectFrame(snapshot: number) {
        const collected = await collect(snapshot);
        const { facts, observation: observed, rootContext, participatingWorlds } = collected;
        const binding = {
          snapshotNumber: snapshot,
          candidates: projectTargets(collected).candidates,
        };
        if (closed) throw new Error('internal');
        const filtered = filterTextSnapshot(facts);
        if (!observed || !filtered.ok) throw new Error('internal');
        let plan: Plan | null = null;
        try {
          await observePseudos(cdp, participatingWorlds);
          const [root] = participatingWorlds;
          if (!root || !observedGeometry(root)) throw new Error();
          const elements = new Map(
            filtered.snapshot.elements.map((element) => [element.n, element]),
          );
          const children = new Map<string, ParticipatingWorld[]>();
          for (const world of participatingWorlds) {
            if (world.parentFrameId === null) continue;
            const siblings = children.get(world.parentFrameId) ?? [];
            siblings.push(world);
            children.set(world.parentFrameId, siblings);
          }
          const buildPlan = async (
            world: ParticipatingWorld,
            region: Region,
          ): Promise<WorldPlan> => {
            const { observation, base, identities } = world;
            const masks: Rect[] = [],
              labels: Label[] = [];
            const maskKeys = new Set<string>();
            const translate = (r: Rect, padding: number) => ({
              x: region.x + r.x - padding,
              y: region.y + r.y - padding,
              width: r.width + padding * 2,
              height: r.height + padding * 2,
            });
            const add = (r: Rect, padding = 4) => {
              if (!rect(r)) throw new Error();
              if (r.width <= 0 || r.height <= 0) return;
              const clipped = intersection(translate(r, padding), region.clip);
              if (!clipped) return;
              const x = Math.floor(clipped.x),
                y = Math.floor(clipped.y);
              const width = Math.ceil(clipped.x + clipped.width) - x;
              const height = Math.ceil(clipped.y + clipped.height) - y;
              const key = [x, y, width, height].join(':');
              if (maskKeys.has(key)) return;
              if (masks.length >= 100000) throw new Error();
              maskKeys.add(key);
              masks.push({ x, y, width, height });
            };
            const protectedNodes = new Set<number>();
            if (!observedGeometry(world)) throw new Error();
            const effects = observation.geometry.map((geometry) => paintEffects(geometry.style));
            const byId = new Map(identities.map((id, index) => [id, index]));
            const hasComposition = ({ filters, reflection }: Effects) =>
              filters.length || reflection;
            const paintAncestors = (index: number) =>
              (observation.geometry[index].ancestors ?? []).map((id) => {
                const ancestor = byId.get(id);
                if (ancestor === undefined) throw new Error();
                return ancestor;
              });
            const protect = (index: number, original: Rect[], padding = 4, pseudo?: Effects) => {
              const ancestors = paintAncestors(index);
              const own = pseudo ?? effects[index];
              for (const box of original) {
                if (!rect(box)) throw new Error();
                if (box.width <= 0 || box.height <= 0) continue;
                let bounds = [box, ...own.shadows.map((shadow) => shadowBounds(box, shadow))];
                const extendsPaint =
                  bounds.length > 1 ||
                  Boolean(pseudo && hasComposition(pseudo)) ||
                  ancestors.some((ancestor) => hasComposition(effects[ancestor]));
                if (
                  extendsPaint &&
                  ancestors.some((ancestor) => observation.geometry[ancestor].transformed)
                )
                  throw new Error();
                if (pseudo) bounds = withFilter(bounds, pseudo.filters);
                for (const ancestor of ancestors) {
                  if (bounds.length > 512) throw new Error();
                  bounds = withComposition(
                    bounds,
                    effects[ancestor],
                    observation.geometry[ancestor].rect,
                  );
                }
                for (const area of bounds) add(area, extendsPaint ? 4 : padding);
              }
              protectedNodes.add(index);
            };
            for (const shadow of world.shadows ?? []) {
              if (shadow.bounds === null) throw new Error();
              protect(shadow.index, shadow.bounds);
            }

            const transformIds = new Set<number>();
            for (const [index, geometry] of observation.geometry.entries())
              if (geometry.transformed) transformIds.add(identities[index]);

            const owners = new Set<number>();
            const transformedOwners = new Set<number>();
            const coveredTransforms = new Set<number>();
            const partial = new Map<number, WorldPlan>();
            for (const child of children.get(world.frameId) ?? []) {
              let owner;
              try {
                owner = await frameOwner(cdp, child, world);
              } catch {
                continue;
              }
              const geometry = observation.geometry[owner.index];
              const transforms = geometry.ancestors.filter((id) => transformIds.has(id));
              if (
                !facts.nodes[base + owner.index].visible ||
                transforms.length !== owner.transforms.length ||
                !transforms.every((id, index) => id === owner.transforms[index])
              )
                continue;
              if (owners.has(owner.index)) throw new Error();
              owners.add(owner.index);
              if (transforms.length) {
                transformedOwners.add(owner.index);
                for (const id of transforms) coveredTransforms.add(id);
                continue;
              }
              if (paintAncestors(owner.index).some((index) => hasComposition(effects[index])))
                continue;
              try {
                const projected = await childRegion(cdp, child, owner, region);
                if (projected) {
                  partial.set(owner.index, await buildPlan(child, projected));
                  child.projection = projected;
                }
              } catch {
                // Keep the full owner mask if the child plan cannot be established.
              }
            }
            if (transformIds.size !== coveredTransforms.size) throw new Error();

            const paint = observation.paint;
            if (paint) {
              const spans = paint.map((run) => {
                const geometry = observation.geometry[run.owner];
                if (
                  !geometry ||
                  !Array.isArray(run.bounds) ||
                  !run.bounds.every(rect) ||
                  typeof run.text !== 'string' ||
                  (run.pseudo && !positiveId(run.backendNodeId))
                )
                  throw new Error();
                return { text: run.text, ancestors: geometry.ancestors };
              });
              const masked = detectPaintMasks(spans, facts.secrets);
              for (const [index, run] of paint.entries()) {
                const pseudo = run.pseudo ? paintEffects(run.style) : undefined;
                if (masked[index] && run.bounds.length) protect(run.owner, run.bounds, 4, pseudo);
              }
            }

            for (const [i, geometry] of observation.geometry.entries()) {
              const node = facts.nodes[base + i],
                element = elements.get(node.n);
              const r = geometry.rect;
              if (
                !rect(r) ||
                typeof geometry.mask !== 'boolean' ||
                (node.field && !geometry.mask) ||
                !Array.isArray(geometry.runs)
              )
                throw new Error();
              const transformedOwner = transformedOwners.has(i);
              if (geometry.mask) {
                if (!partial.has(i)) {
                  const exactBounds =
                    transformedOwner ||
                    (node.role === 'input' && node.field && observation.viewport);
                  protect(i, [r], exactBounds ? 0 : 4);
                  if (node.field && geometry.runs.length) protect(i, geometry.runs);
                }
                protectedNodes.add(i);
              }
              // Preserve masks established by the visible flow as well as the drawn flow.
              const normalized = node.text
                .normalize('NFKC')
                .replace(/\p{White_Space}/gu, ' ')
                .replace(/[\p{Cf}\p{Cc}]/gu, '')
                .replace(/ +/g, ' ');
              if (element ? element.text !== normalized : !paint) {
                if (geometry.button) protect(i, [r]);
                else if (geometry.runs.length) protect(i, geometry.runs);
              }
              const clipped = intersection(translate(r, 0), region.clip);
              if (element && clipped) {
                const labelClip = transformedOwner ? clipped : world === root ? null : region.clip;
                const round = labelClip ? Math.ceil : Math.floor;
                const x = round(clipped.x),
                  y = round(clipped.y);
                if (
                  !labelClip ||
                  (x + 4 * String(element.n).length + 1 <= labelClip.x + labelClip.width &&
                    y + 7 <= labelClip.y + labelClip.height)
                )
                  labels.push({ x, y, number: element.n });
              }
            }
            const protectedIds = new Set<number>();
            for (const index of protectedNodes) {
              const ancestors = observation.geometry[index].ancestors;
              if (
                coveredTransforms.size &&
                ancestors.some((id) => coveredTransforms.has(id)) &&
                !transformedOwners.has(index)
              )
                throw new Error();
              for (const id of ancestors ?? []) protectedIds.add(id);
            }
            let maskAnimationActive =
              !Array.isArray(observation.animationTargets) ||
              observation.animationTargets.some(
                (target) => target === null || protectedIds.has(target),
              );
            for (const child of partial.values()) {
              for (const mask of child.masks) masks.push(mask);
              for (const label of child.labels) labels.push(label);
              maskAnimationActive ||= child.maskAnimationActive;
            }
            return { masks, labels, maskAnimationActive };
          };
          const { masks, labels, maskAnimationActive } = await buildPlan(root, {
            x: 0,
            y: 0,
            clip: { x: 0, y: 0, width: observed.width, height: observed.height },
          });
          observed.maskAnimationActive = maskAnimationActive;
          plan = { masks, labels };
        } catch {
          plan = null;
        }
        if (closed) throw new Error('internal');
        return {
          facts,
          plan,
          binding,
          viewport: observed.viewport ?? { x: NaN, y: NaN, width: NaN, height: NaN },
          revision: observed.revision,
          animationIds: [`document:${rootContext}`, ...observed.animationIds],
          viewportStable: observed.viewportStable,
          maskAnimationActive: observed.maskAnimationActive,
          participatingWorlds,
        };
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        removeListeners();
        contexts.clear();
        frameUrls.clear();
        history.clear();
        historySize = 0;
        let failed = false;
        try {
          if (scriptId)
            await bounded(() =>
              cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }),
            );
        } catch {
          failed = true;
        }
        try {
          await bounded(() => cdp.detach());
        } catch {
          failed = true;
        }
        if (failed) throw new Error('internal');
      },
    };
  } catch {
    closed = true;
    removeListeners();
    contexts.clear();
    frameUrls.clear();
    history.clear();
    try {
      await bounded(() => cdp.detach());
    } catch {}
    throw new Error('internal');
  }
}

export declare const prepareDomCollector: typeof prepare;
declare const exports: { prepareDomCollector: typeof prepare };
exports.prepareDomCollector = prepare;
