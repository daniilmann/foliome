import type { ActionFacts } from '../../domain/action-verdict.ts';

const { filterTextSnapshot, filterEventAddress, detectPaintMasks } =
  require('../../domain/snapshot-filter.ts') as typeof import('../../domain/snapshot-filter.ts');
const { createHmac, randomBytes } = require('node:crypto') as typeof import('node:crypto');

const readLimit = 32 * 1024;
const readTruncation = ' «обрезано»';

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
  label?: string;
  labelRefs?: number[];
  snapshotOnly?: boolean;
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
  classes?: ('blocked-payment' | 'blocked-change' | null)[];
  actionFacts?: ActionFacts[];
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
const expression = String.raw`((collectActionFacts) => {
  const nodes = [], parents = [], identities = [], actionFacts = [], semantics = [], secrets = [], embeds = [], geometry = [], paint = [];
  const visitedElements = new WeakMap(), labelReferences = [];
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
  state.measuredRoots = new WeakSet();
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
  const choiceRoles = new Set(['checkbox', 'radio', 'switch', 'listbox', 'combobox']);
  const safeAttrs = ['id', 'name', 'class', 'data-testid', 'type', 'autocomplete', 'placeholder'];
  const html = 'http://www.w3.org/1999/xhtml', svg = 'http://www.w3.org/2000/svg';
  const normal = (value, limit = 256) => {
    if (!value) return '';
    const text = value.slice(0, limit).trim().replace(/\s+/gu, ' ').toLowerCase();
    return value.length > limit ? text.slice(0, limit - 1) + '…' : text;
  };
  const path = (value, base) => {
    try {
      const url = new URL(value, base);
      return (url.protocol === 'https:' || url.protocol === 'http:') && url.pathname.length <= 2048 ? url.pathname : '';
    } catch { return ''; }
  };
  // The private facts follow the same node order as the observed identities.
  const currentPath = collectActionFacts ? path(location.href) : '';
  const actionControl = 'a[href],area[href],button,input[type=button],input[type=submit],input[type=reset],[role=button],[role=link]';
  const observedLabels = new WeakMap(), forms = new WeakMap();
  const ariaReferenceText = new WeakMap();
  const textLabel = root => {
    const previous = observedLabels.get(root);
    if (previous !== undefined) return previous;
    const privateField = node => forbidden.has(node.tagName) || ['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName) ||
      node.isContentEditable || fieldRoles.has(normal(node.getAttribute('role'), 64));
    if (privateField(root)) return '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, node => {
      if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      return privateField(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    });
    let text = '', visited = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (++visited > 128) { text += '…'; break; }
      if (node.nodeType === Node.TEXT_NODE) {
        const available = 256 - text.length;
        const chunk = node.nodeValue || '';
        text += chunk.slice(0, available);
        if (chunk.length > available) { text = text.slice(0, 255) + '…'; break; }
      }
    }
    text = normal(text);
    observedLabels.set(root, text);
    return text;
  };
  const referencedLabel = element => {
    const previous = ariaReferenceText.get(element);
    if (previous !== undefined) return previous;
    const raw = element.getAttribute('aria-labelledby');
    if (!raw || raw.length > 1024) return '';
    const ids = raw.trim().split(/\s+/u);
    if (ids.length > 8) return '';
    const root = element.getRootNode();
    const text = normal(ids.map(id => {
      const reference = root.getElementById?.(id);
      return reference && (reference === element || !reference.contains(element)) ? textLabel(reference) : '';
    }).join(' '));
    ariaReferenceText.set(element, text);
    return text;
  };
  const paymentKind = value => {
    const kind = normal(value, 64).replace(/[-_]+/g, ' ');
    if (kind === 'amount' || kind === 'сумма') return 'amount';
    if (kind === 'recipient' || kind === 'получатель') return 'recipient';
    if (kind === 'transfer details' || kind === 'реквизиты перевода') return 'transfer details';
    return '';
  };
  const fieldKind = (element, role, type) => {
    if (type === 'password') return 'password';
    for (const key of ['type', 'name', 'id', 'aria-label']) {
      const kind = paymentKind(element.getAttribute(key));
      if (kind) return kind;
    }
    const referenceKind = paymentKind(referencedLabel(element));
    if (referenceKind) return referenceKind;
    const labels = element.labels;
    if (labels) for (let i = 0; i < Math.min(4, labels.length); i++) {
      const kind = paymentKind(textLabel(labels[i]));
      if (kind) return kind;
    }
    if (element.tagName === 'INPUT') {
      if (['date', 'datetime-local', 'month', 'week', 'time'].includes(type)) return 'date';
      return ['checkbox', 'radio'].includes(type) ? 'choice' : 'unknown';
    }
    if (element.tagName === 'SELECT' || element.tagName !== 'TEXTAREA' && !element.isContentEditable && choiceRoles.has(role)) return 'choice';
    return 'unknown';
  };
  const formState = form => {
    let info = forms.get(form);
    if (info) return info;
    info = { fields: new Set(), confirmation: ['id', 'name'].some(key =>
      ['confirm', 'confirmation'].includes(normal(form.getAttribute(key), 64))) };
    forms.set(form, info);
    const controls = Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'elements').get.call(form);
    if (controls.length > 256) info.fields.add('unknown');
    for (let i = 0; i < Math.min(controls.length, 256); i++) {
      const control = controls[i];
      const tag = control.tagName;
      if (['BUTTON', 'FIELDSET', 'OUTPUT'].includes(tag) || tag === 'INPUT' && ['button', 'submit', 'reset', 'image'].includes(control.type)) continue;
      info.fields.add(fieldKind(control, normal(control.getAttribute('role'), 64), control.type));
    }
    return info;
  };
  const observeAction = (element, role, type, field, semanticText) => {
    const tag = element.localName.toLowerCase();
    const control = element.closest(actionControl);
    const link = element.closest('a[href],area[href]');
    const owner = control || element;
    const form = element instanceof HTMLFormElement ? element : 'form' in owner ? owner.form : owner.closest('form');
    const info = form instanceof HTMLFormElement ? formState(form) : null;
    const isField = field || choiceRoles.has(role) || ['checkbox', 'radio'].includes(type);
    const inputKind = isField ? fieldKind(element, role, type) : '';
    if (info && isField && !['input', 'select', 'textarea'].includes(tag)) info.fields.add(inputKind);
    const submitter = (control?.localName === 'button' || control?.localName === 'input') && control.type === 'submit' ? control :
      tag === 'input' && type === 'image' ? element : null;
    const formAction = !info ? '' : submitter?.hasAttribute('formaction') ? path(submitter.formAction) :
      path(Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'action').get.call(form));
    const displayLabel = !control ? semanticText : control.localName === 'input' ? control.getAttribute('value') : textLabel(control);
    const labels = new Set([
      normal(displayLabel), normal(element.getAttribute('aria-label')), normal(element.getAttribute('title')),
      referencedLabel(element), control ? normal(control.getAttribute('aria-label')) : '',
      control ? referencedLabel(control) : '', control ? normal(control.getAttribute('title')) : '',
    ]);
    labels.delete('');
    const [label = '', ...alternateLabels] = labels;
    const autocomplete = normal(element.getAttribute('autocomplete')).split(' ')
      .filter(token => /^(?:cc-[a-z-]{1,24}|current-password|new-password|one-time-code)$/.test(token)).join(' ');
    actionFacts.push({ tag: normal(tag, 64), role: normal(role, 64), controlType: normal(type, 64), label, alternateLabels,
      inputKind, autocomplete, currentPath, href: link ? path(link.getAttribute('href'), link.baseURI) : '',
      formAction,
      confirmationForm: info?.confirmation ?? false, formFields: info?.fields });
  };
  const scrollingElement = document.scrollingElement;
  const scrollStyle = getComputedStyle(scrollingElement || document.documentElement);
  const normalDocumentOrigin = scrollStyle.direction === 'ltr' && scrollStyle.writingMode === 'horizontal-tb';
  const inDocument = (rect, element) => {
    if (!normalDocumentOrigin || (rect.right + scrollX > 0 && rect.bottom + scrollY > 0)) return true;
    // Nested scroll offsets can move recoverable text across the document origin.
    for (let el = element; el; el = el.assignedSlot || el.parentElement || el.getRootNode().host) {
      if (el !== scrollingElement && (el.scrollLeft || el.scrollTop)) return true;
    }
    return false;
  };
  const px = '(-?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+))px';
  const legacyClip = new RegExp('^rect\\(' + [px, px, px, px].join(',\\s*') + '\\)$');
  const emptyClip = (style, bounds, untransformed) => {
    if (style.clip !== 'auto' && ['absolute', 'fixed'].includes(style.position)) {
      const legacy = legacyClip.exec(style.clip);
      if (legacy && (Number(legacy[2]) <= Number(legacy[4]) || Number(legacy[3]) <= Number(legacy[1]))) return true;
    }
    const inset = /^inset\(([^()]+)\)$/.exec(style.clipPath);
    if (!inset || style.display === 'contents' || bounds.width <= 0 || bounds.height <= 0) return false;
    const sides = inset[1].trim().split(/\s+/);
    if (sides.length > 4 || !sides.every(side => /^-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:px|%)$/.test(side))) return false;
    const [top, right = top, bottom = top, left = right] = sides;
    const fills = (a, b, size) => {
      if (a.endsWith('%') && b.endsWith('%')) return parseFloat(a) + parseFloat(b) >= 100;
      const pixels = side => parseFloat(side) * (side.endsWith('%') ? size / 100 : 1);
      return untransformed && pixels(a) + pixels(b) >= size;
    };
    return fills(top, bottom, bounds.height) || fills(left, right, bounds.width);
  };
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
  let visits = 1;
  const visit = (element, parent, ancestorsVisible, parentGeometry, insideSvg = false, snapshotOnly = false, unclipped = true, untransformed = true) => {
    if (nodes.length >= 10000) throw new Error();
    const tag = element.tagName.toUpperCase();
    if (forbidden.has(tag)) return;
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    const svgRoot = element.namespaceURI === svg && !insideSvg;
    if (svgRoot && (element.localName !== 'svg' || !clippedSvg(element, style)) ||
        element.namespaceURI !== html && element.namespaceURI !== svg) unsupported = true;
    const subtreeVisible = ancestorsVisible && style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0 && !element.hasAttribute('hidden') && !element.hasAttribute('inert') && element.getAttribute('aria-hidden') !== 'true';
    const transformed = !insideSvg && hasTransform(style);
    untransformed = untransformed && !transformed && ['1', 'normal'].includes(style.zoom);
    unclipped = unclipped && (element.namespaceURI !== html || !emptyClip(style, rect, untransformed));
    const visibleBox = subtreeVisible && rect.width > 0 && rect.height > 0;
    const frame = tag === 'IFRAME' || tag === 'FRAME';
    const embed = frame || tag === 'OBJECT' || tag === 'EMBED';
    const frameUrl = frame && element.src ? element.src : null;
    if (frameUrl && !snapshotOnly) embeds.push({ url: frameUrl, visible: visibleBox });
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
    const root = element.shadowRoot;
    if (root && !field) state.measuredRoots.add(root);
    if (root && !state.watched.has(root)) {
      state.observer.observe(root, { subtree: true, attributes: true, childList: true, characterData: true });
      root.addEventListener('slotchange', () => { state.revision++; });
      state.watched.add(root);
    }
    const slot = element instanceof HTMLSlotElement && element.getRootNode() instanceof ShadowRoot;
    const assigned = slot ? element.assignedNodes() : null;
    const children = root ? root.childNodes : assigned?.length ? assigned : element.childNodes;
    visits += children.length;
    if (visits > 20000) throw new Error();
    const ranges = new Map();
    const textVisible = subtreeVisible && unclipped && parseFloat(style.fontSize) >= 2;
    const buttonText = button ? element.value : '';
    let text = button && textVisible && inDocument(rect, element) ? buttonText : '';
    let semanticText = buttonText;
    for (const child of children) {
      if (child.nodeType !== Node.TEXT_NODE || field && ['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) continue;
      const range = document.createRange(); range.selectNodeContents(child);
      const clientRects = range.getClientRects();
      if (clientRects.length > 20001) { unsupported = true; continue; }
      const boxes = Array.from(clientRects).filter(r => r.width > 0 && r.height > 0);
      if (!boxes.length) continue;
      if (!insideSvg && !svgRoot) ranges.set(child, boxes.map(rectValue));
      if (field) continue;
      semanticText += child.nodeValue || '';
      if (textVisible && boxes.some(box => inDocument(box, element))) text += child.nodeValue || '';
    }
    const visible = visibleBox || slot && !!text;
    const fact = { visible, role, text: visible ? text : '' };
    const ariaLabel = element.getAttribute('aria-label');
    if (!field && text && ariaLabel) fact.label = ariaLabel;
    // The composed snapshot does not extend the nodes or text admitted by readText.
    if (snapshotOnly || root && text) fact.snapshotOnly = true;
    if (field) {
      const type = (element.getAttribute('type') || '').toLowerCase();
      const textual = tag === 'TEXTAREA' || tag === 'INPUT' && ['', 'text', 'password', 'email', 'tel', 'url', 'search'].includes(type);
      const value = !closedField && textual && visibleBox && typeof element.value === 'string' ? element.value : '';
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
    const label = [semanticText, ariaLabel || '', element.getAttribute('title') || ''].join(' ').toLowerCase();
    semantics.push(JSON.stringify([tag, label, element.getAttribute('type'), element.getAttribute('aria-expanded'), element.getAttribute('aria-haspopup'), element.getAttribute('aria-controls'), element.getAttribute('aria-pressed'), element.getAttribute('autocomplete')]));
    if (collectActionFacts) observeAction(element, role, tag === 'BUTTON' ? element.type : type, field, semanticText);
    const index = nodes.length; nodes.push(fact); parents.push(parent);
    visitedElements.set(element, index);
    const referenceIds = !field && visible ? element.getAttribute('aria-labelledby') : null;
    if (referenceIds && referenceIds.length <= 4096) {
      const tokens = referenceIds.trim().split(/\s+/u);
      const tree = element.getRootNode();
      if (tokens.length <= 16 && (tree instanceof Document || tree instanceof ShadowRoot))
        labelReferences.push({ fact, tree, tokens });
    }
    const ancestors = [state.ids.get(element), ...(parentGeometry?.ancestors ?? [])];
    const runs = [];
    const measured = { rect: rectValue(rect), runs, button, ancestors, frameUrl,
      transformed, mask: field || embed || svgRoot, style: appearance, ...(svgRoot ? { svg: true } : {}) };
    geometry.push(measured);
    observePseudo(index, 'before');
    if (button && !insideSvg && !svgRoot && buttonText && rect.width > 0 && rect.height > 0)
      pushPaint(index, buttonText, [rectValue(rect)]);
    for (const child of children) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (!field) visit(child, visible ? index : parent, subtreeVisible, measured, insideSvg || svgRoot,
          snapshotOnly || !!root, unclipped, untransformed);
        else if (tag !== 'SELECT' && !insideSvg) unsupported = true;
      } else if (ranges.has(child)) {
        const bounds = ranges.get(child);
        for (const boundsRect of bounds) runs.push(boundsRect);
        if (!field && child.nodeValue) pushPaint(index, child.nodeValue, bounds);
      }
    }
    observePseudo(index, 'after');
  };
  if (!document.documentElement) throw new Error();
  visit(document.documentElement, null, true);
  for (const { fact, tree, tokens } of labelReferences) {
    const references = tokens
      .map(token => visitedElements.get(tree.getElementById(token)))
      .filter(index => Number.isSafeInteger(index));
    if (references.length) fact.labelRefs = references;
  }
  const animations = document.getAnimations().filter(a => a.playState === 'running' || a.playState === 'pending');
  const animationIds = animations.map(a => { if (!state.ids.has(a)) state.ids.set(a, state.next++); return String(state.ids.get(a)); }).sort();
  const animationTargets = animations.map(a => {
    const target = a.effect instanceof KeyframeEffect ? a.effect.target : null;
    return target instanceof Element && target.isConnected && target.ownerDocument === document && state.ids.has(target) ? state.ids.get(target) : null;
  });
  const viewport = visualViewport;
  const viewportStable = !!viewport && devicePixelRatio === 1 && viewport.scale === 1 && viewport.offsetLeft === 0 && viewport.offsetTop === 0 && viewport.pageLeft === scrollX && viewport.pageTop === scrollY && viewport.width === innerWidth && viewport.height === innerHeight;
  const unobservedEmbeds = Array.from(document.querySelectorAll('iframe,frame,object,embed')).some(el => !visitedEmbeds.has(el));
  return { url: location.href, title: document.title, nodes, parents, identities,
    actionFacts: actionFacts.map(({ formFields, ...facts }) => ({ ...facts, formFieldKinds: formFields ? [...formFields].sort() : [] })),
    semantics, secrets, embeds, observation: { viewport: { x: scrollX, y: scrollY, width: innerWidth, height: innerHeight }, geometry, width: innerWidth, height: innerHeight, revision: state.revision, animationIds, animationTargets, viewportStable, maskAnimationActive: false, unsupported, unobservedEmbeds, paint } };
})`;

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
  if (mode === "open" && state.measuredRoots?.has(this)) return { hostId, mode, composed: true };
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
function observationScript(origin: string): string {
  return `(() => {
    if (location.protocol !== 'https:' || location.origin !== ${JSON.stringify(origin)} ||
        globalThis.__foliomeLogin) return;
    try {
      for (let frame = window; frame !== top; frame = frame.parent)
        if (frame.parent.location.origin !== location.origin) return;
    } catch { return; }
    const report = facts => globalThis.${bindingName}(JSON.stringify(facts));
    const control = el => el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement &&
      ['text', 'password', 'email', 'tel', 'url', 'search', 'number'].includes(el.type);
    let previous = new WeakMap();
    let stopped = false, valid = true, manualSent = false;
    let root;
    const events = ['beforeinput', 'input', 'change', 'paste', 'keydown', 'pointerdown', 'submit', 'click'];
    const observe = el => {
      const editable = el.isContentEditable && !el.parentElement?.isContentEditable;
      if (!editable && !control(el)) return;
      const value = editable ? el.textContent : el.value;
      const kind = el.type === 'password' ? 'password' :
        el.autocomplete === 'one-time-code' ? 'code' : 'login';
      const last = previous.get(el);
      if (last?.value === value && last?.kind === kind) return;
      previous.set(el, { value, kind });
      if (!value) return;
      if (value.length > 16384) throw new Error();
      report({ type: 'field', value, kind });
    };
    const scan = () => {
      if (stopped || !valid) return false;
      try {
        if (root !== document.documentElement && document.documentElement) {
          root = document.documentElement;
          for (const type of events) addEventListener(type, handle, true);
          addEventListener('pagehide', hide, true);
          addEventListener('pageshow', show, true);
        }
        const scopes = [document];
        let visited = 0;
        for (let i = 0; i < scopes.length; i++) {
          const walker = document.createTreeWalker(scopes[i], NodeFilter.SHOW_ELEMENT);
          for (let el = walker.nextNode(); el; el = walker.nextNode()) {
            if (++visited > 20000) throw new Error();
            if (el.shadowRoot) scopes.push(el.shadowRoot);
            observe(el);
          }
        }
        return true;
      } catch {
        valid = false;
        report({ type: 'unknown' });
        return false;
      }
    };
    function handle(event) {
      const type = event.type;
      if (event.isTrusted && !manualSent && !['click', 'submit'].includes(type)) {
        manualSent = true;
        report({ type: 'manual' });
      }
      if (type === 'submit' || type === 'click' || type === 'keydown' && event.key === 'Enter') {
        checkpoint();
        queueMicrotask(checkpoint);
      } else if (['beforeinput', 'input', 'change', 'paste'].includes(type)) {
        scan();
        queueMicrotask(scan);
      }
    }
    function checkpoint() {
      if (!scan()) return false;
      report({ type: 'checkpoint' });
      return true;
    }
    function hide() {
      checkpoint();
    }
    function show() {
      report({ type: 'resumed' });
      scan();
    }
    const observer = new MutationObserver(scan);
    observer.observe(document, { subtree: true, childList: true, attributes: true });
    const timer = setInterval(scan, 100);
    globalThis.__foliomeLogin = {
      checkpoint,
      finish() {
        if (!document.documentElement || !scan()) return false;
        stopped = true;
        previous = new WeakMap();
        clearInterval(timer);
        observer.disconnect();
        for (const type of events) removeEventListener(type, handle, true);
        removeEventListener('pagehide', hide, true);
        removeEventListener('pageshow', show, true);
        return true;
      },
    };
    report({ type: 'started' });
    scan();
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
  let visits = 0;
  const visit = (
    value: unknown,
    world: ParticipatingWorld,
    insideShadow?: (typeof roots)[number],
  ) => {
    if (++visits > 20000 || !record(value)) throw new Error();
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
        if (insideShadow.mode === 'closed') continue;
      }
      if (!positiveId(backend) || (mode !== 'open' && mode !== 'closed') || roots.length >= 256)
        throw new Error();
      const root: (typeof roots)[number] = { world, backend, mode, nested: !!insideShadow };
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
  const closedHosts = new Map<ParticipatingWorld, Set<number>>();
  for (const { world, backend, mode, nested } of roots) {
    try {
      const value = await inspectNode(cdp, backend, world.context, shadowGeometry);
      if (!positiveId(value.hostId) || value.mode !== mode) throw new Error();
      const index = world.identities.indexOf(value.hostId);
      if (index < 0 || world.identities.lastIndexOf(value.hostId) !== index) throw new Error();
      touched.add(world);
      if (mode === 'open' && value.composed === true) continue;
      if (mode === 'closed') {
        const node = nodes[world.base + index];
        node.state = node.state ? node.state + ' unavailable' : 'unavailable';
        const hosts = closedHosts.get(world) ?? new Set<number>();
        hosts.add(value.hostId);
        closedHosts.set(world, hosts);
      }
      const bounds = nested ? null : value.bounds;
      if (
        bounds !== null &&
        (!Array.isArray(bounds) || bounds.length > 20001 || !bounds.every(rect))
      )
        throw new Error();
      world.shadows ??= [];
      world.shadows.push({ index, backendNodeId: backend, bounds });
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
  for (const [world, hosts] of closedHosts) {
    for (const [index, geometry] of world.observation.geometry.entries()) {
      if (!geometry.ancestors.some((id) => hosts.has(id))) continue;
      const node = nodes[world.base + index];
      node.text = '';
      delete node.label;
      if (!hosts.has(geometry.ancestors[0])) node.visible = false;
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
  config: { sourceHost: string; sourceOrigin?: string; approvedHosts?: readonly string[] },
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
  let sourceOrigin = '';
  const loginDocuments = new Map<number, boolean>();
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
    if (context.name === worldName && context.auxData?.frameId && trustedPage(context.origin))
      contexts.set(context.id, { frameId: context.auxData.frameId, origin: context.origin });
  };
  const forgetDocument = (id: number) => {
    if (!observationFinished && loginDocuments.get(id) === false) overflow = true;
    loginDocuments.delete(id);
  };
  const contextDestroyed = ({ executionContextId }: { executionContextId: number }) => {
    forgetDocument(executionContextId);
    contexts.delete(executionContextId);
  };
  const contextsCleared = () => {
    for (const id of loginDocuments.keys()) forgetDocument(id);
    contexts.clear();
  };
  const trustedPage = (raw: string): boolean => {
    try {
      const address = new URL(raw);
      return config.sourceOrigin !== undefined
        ? address.protocol === 'https:' &&
            address.origin === sourceOrigin &&
            !address.username &&
            !address.password
        : trustedUrl(raw, sourceHost, approvedHosts);
    } catch {
      return false;
    }
  };
  const frameNavigated = ({ frame }: { frame: { id: string; url: string } }) => {
    frameUrls.set(frame.id, frame.url);
  };
  const bindingCalled = (event: { name: string; payload: string; executionContextId: number }) => {
    if (closed || observationFinished || event.name !== bindingName) return;
    const id = event.executionContextId;
    const context = contexts.get(id);
    if (!context || context.origin !== sourceOrigin) return;
    const url = frameUrls.get(context.frameId);
    if (!url || new URL(url).origin !== sourceOrigin) {
      overflow = true;
      return;
    }
    try {
      const data: unknown = JSON.parse(event.payload);
      if (!record(data)) throw new Error();
      if (data.type === 'started' || data.type === 'resumed') loginDocuments.set(id, false);
      else if (data.type === 'checkpoint') loginDocuments.set(id, true);
      else if (data.type === 'manual') manualInputSeen = true;
      else if (
        data.type === 'field' &&
        typeof data.value === 'string' &&
        (data.kind === 'login' || data.kind === 'password' || data.kind === 'code')
      ) {
        loginDocuments.set(id, false);
        remember({ value: data.value, kind: data.kind });
      } else overflow = true;
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
    sourceOrigin = config.sourceOrigin ?? new URL('https://' + sourceHost).origin;
    const source = new URL(sourceOrigin);
    if (
      source.protocol !== 'https:' ||
      source.origin !== sourceOrigin ||
      source.hostname.replace(/\.$/, '') !== sourceHost
    )
      throw new Error();
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
    const script = observationScript(sourceOrigin);
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
          if (!rootHost || !trustedPage(root.frame.url)) throw new Error();
          const frames: FrameFact[] = [],
            nodes: NodeFact[] = [],
            secrets: Secret[] = [];
          let page: { url: string; title: string } | undefined;
          let observation: Observation | undefined;
          let rootNodeCount = 0;
          let rootContext = 0;
          let rootIdentities: number[] = [],
            rootClasses: DocumentFacts['classes'],
            rootActionFacts: DocumentFacts['actionFacts'];
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
            const foreign = foreignAncestor || !trustedPage(frame.frame.url);
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
                  expression: `${expression}(${index === 0})`,
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
                  !trustedPage(data.url) ||
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
                  rootActionFacts = data.actionFacts;
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
                  const { labelRefs, ...node } = data.nodes[i];
                  if (
                    labelRefs !== undefined &&
                    (!Array.isArray(labelRefs) ||
                      labelRefs.length > 16 ||
                      labelRefs.some(
                        (ref) => !Number.isSafeInteger(ref) || ref < 0 || ref >= data.nodes.length,
                      ))
                  )
                    throw new Error();
                  nodes.push({
                    ...node,
                    ...(labelRefs ? { labelRefs: labelRefs.map((ref) => base + ref + 1) } : {}),
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
              !trustedPage(embed.url) &&
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
            rootActionFacts,
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
    function projectTargets(
      result: Awaited<ReturnType<typeof collect>>,
      filtered = filterTextSnapshot(result.facts),
    ) {
      const {
        facts,
        rootNodeCount,
        rootContext,
        rootIdentities,
        rootClasses,
        rootActionFacts,
        rootSemantics,
      } = result;
      if (
        !filtered.ok ||
        closed ||
        !Array.isArray(rootIdentities) ||
        rootIdentities.length !== rootNodeCount ||
        !rootIdentities.every((id) => Number.isSafeInteger(id) && id > 0) ||
        (rootActionFacts !== undefined
          ? !Array.isArray(rootActionFacts) ||
            rootActionFacts.length !== rootNodeCount ||
            !rootActionFacts.every(record)
          : !Array.isArray(rootClasses) ||
            rootClasses.length !== rootNodeCount ||
            !rootClasses.every(
              (value) =>
                value === null || value === 'blocked-payment' || value === 'blocked-change',
            )) ||
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
            actionFacts: rootActionFacts,
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
          visible: node.visible && !node.snapshotOnly && !!element,
          enabled: !node.state?.split(' ').includes('disabled'),
          sourceFrame: node.frame === 0,
          secretField: !!node.field,
          prohibited: rootClasses?.[index] ?? null,
          ...(rootActionFacts ? { facts: rootActionFacts[index] } : {}),
          text: element?.text ?? '',
        };
      });
      return { candidates };
    }
    async function verifyLogin(finish: boolean) {
      try {
        await bounded(async () => {
          const response = await cdp.send('Page.getFrameTree');
          if (!record(response)) throw new Error();
          const initial = tree(response.frameTree);
          if (!finish && initial.frame.url === 'about:blank' && !loginDocuments.size) return;
          if (!trustedPage(initial.frame.url) || new URL(initial.frame.url).origin !== sourceOrigin)
            throw new Error();
          let count = 0;
          const visited = new Map<number, string>();
          const verify = async (frame: FrameTree): Promise<void> => {
            if (closed || overflow || ++count > 256) throw new Error();
            const url = new URL(frame.frame.url);
            if (url.protocol !== 'https:' || url.origin !== sourceOrigin) return;
            const entries = [...contexts].filter(
              ([id, known]) => known.frameId === frame.frame.id && loginDocuments.has(id),
            );
            if (entries.length !== 1) throw new Error();
            const [contextId] = entries[0];
            const method = finish ? 'finish' : 'checkpoint';
            const checked = await cdp.send('Runtime.evaluate', {
              expression: `location.href === ${JSON.stringify(url.href)} && globalThis.__foliomeLogin?.${method}() === true`,
              contextId,
              returnByValue: true,
            });
            if (
              !record(checked) ||
              checked.exceptionDetails ||
              !record(checked.result) ||
              checked.result.value !== true
            )
              throw new Error();
            visited.set(contextId, frame.frame.id);
            for (const child of frame.childFrames ?? []) await verify(child);
          };
          await verify(initial);
          const frames = new Set(visited.values());
          const dom = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
          if (!record(dom) || !record(dom.root)) throw new Error();
          const pending: unknown[] = [dom.root];
          let nodes = 0;
          while (pending.length) {
            const node = pending.pop();
            if (!record(node) || ++nodes > 20000 || node.shadowRootType === 'closed')
              throw new Error();
            for (const child of Array.isArray(node.children) ? node.children : [])
              pending.push(child);
            for (const root of Array.isArray(node.shadowRoots) ? node.shadowRoots : []) {
              if (!record(root) || root.shadowRootType !== 'user-agent') pending.push(root);
            }
            if (
              typeof node.frameId === 'string' &&
              frames.has(node.frameId) &&
              node.contentDocument
            )
              pending.push(node.contentDocument);
          }
          if (finish) {
            if (scriptId)
              await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId });
            scriptId = undefined;
            await cdp.send('Runtime.removeBinding', { name: bindingName });
          }
          const check = await cdp.send('Page.getFrameTree');
          if (
            closed ||
            overflow ||
            !record(check) ||
            JSON.stringify(tree(check.frameTree)) !== JSON.stringify(initial) ||
            [...visited].some(([id, frameId]) => contexts.get(id)?.frameId !== frameId)
          )
            throw new Error();
          // The binding reports from each verified document precede its evaluation reply.
        });
      } catch {
        overflow = true;
        throw new Error('internal');
      }
    }
    return {
      eventAddress(raw: string, configuredEntry = false) {
        if (closed || overflow) throw new Error('internal');
        const address = new URL(raw);
        if (!observationFinished && !configuredEntry) {
          if (address.origin !== sourceOrigin) return { host: '…', path: '/…' };
          address.pathname = '/…';
        }
        return filterEventAddress(address.href, [...history.values()]);
      },
      loginObservations() {
        if (closed) throw new Error('internal');
        return { manualInputSeen, hasKnownSecret: history.size > 0 || overflow };
      },
      async checkpointLogin() {
        if (closed || overflow) throw new Error('internal');
        if (!observationFinished) await verifyLogin(false);
      },
      async finishLoginObservation() {
        if (closed || overflow || observationFinished) throw new Error('internal');
        await verifyLogin(true);
        observationFinished = true;
        removeListeners();
        loginDocuments.clear();
        contexts.clear();
        frameUrls.clear();
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
          const included = new Set<number>();
          for (const node of result.facts.nodes.slice(0, result.rootNodeCount)) {
            if (node.snapshotOnly) continue;
            if (
              node.n === nodeNumber ||
              (deep && node.parent !== undefined && included.has(node.parent))
            )
              included.add(node.n);
          }
          const bytes = Buffer.alloc(readLimit);
          let size = 0;
          let truncated = false;
          const filtered = filterTextSnapshot(result.facts, (number, text) => {
            if (truncated || !included.has(number) || !text) return;
            const chunk = (size ? ' ' : '') + text;
            const written = bytes.write(chunk, size, 'utf8');
            size += written;
            truncated = written < Buffer.byteLength(chunk);
          });
          const { candidates } = projectTargets(result, filtered);
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
          if (truncated) {
            let end = Math.min(size, readLimit - Buffer.byteLength(readTruncation));
            while ((bytes[end] & 0b1100_0000) === 0b1000_0000) end--;
            return { ok: true, text: bytes.toString('utf8', 0, end) + readTruncation };
          }
          return { ok: true, text: bytes.toString('utf8', 0, size) };
        } catch {
          return { ok: false, code: 'internal' };
        }
      },
      async collectFrame(
        snapshot: number,
        reportText?: (frame: {
          facts: unknown;
          binding: {
            snapshotNumber: number;
            candidates: ReturnType<typeof projectTargets>['candidates'];
          };
        }) => void,
      ) {
        const collected = await collect(snapshot);
        const { facts, observation: observed, rootContext, participatingWorlds } = collected;
        const filtered = filterTextSnapshot(facts);
        const binding = {
          snapshotNumber: snapshot,
          candidates: projectTargets(collected, filtered).candidates,
        };
        if (closed) throw new Error('internal');
        if (!observed || !filtered.ok) throw new Error('internal');
        reportText?.({ facts, binding });
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
                  protect(i, [r]);
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
        loginDocuments.clear();
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
    loginDocuments.clear();
    try {
      await bounded(() => cdp.detach());
    } catch {}
    throw new Error('internal');
  }
}

export declare const prepareDomCollector: typeof prepare;
declare const exports: { prepareDomCollector: typeof prepare };
exports.prepareDomCollector = prepare;
