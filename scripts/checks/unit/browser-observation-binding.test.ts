const assert = require('node:assert/strict');
const test = require('node:test');

class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T) => void;
  constructor() {
    this.promise = new Promise<T>(resolve => { this.resolve = resolve; });
  }
}

const url = 'https://source.example/home';
const rect = (x: number) => ({ x, y: 20, width: 10, height: 10 });
const samples = [
  {
    context: 101,
    data: {
      url, title: 'First',
      nodes: [{ visible: true, role: 'textbox', text: '', field: 'sealed' }],
      parents: [null], secrets: [], embeds: [],
      observation: { geometry: [{ rect: rect(10), runs: [], mask: true }], width: 200, height: 100, revision: 11, animationIds: ['first'], viewportStable: true, maskAnimationActive: false, unsupported: false },
    },
  },
  {
    context: 202,
    data: {
      url, title: 'Second',
      nodes: [{ visible: true, role: 'text', text: 'Second' }, { visible: true, role: 'textbox', text: '', field: 'sealed' }],
      parents: [null, 0], secrets: [], embeds: [],
      observation: { geometry: [{ rect: rect(50), runs: [], mask: false }, { rect: rect(70), runs: [], mask: true }], width: 200, height: 100, revision: 22, animationIds: ['second'], viewportStable: false, maskAnimationActive: true, unsupported: false },
    },
  },
];

function port() {
  const entered = new Deferred<void>();
  const document = new Deferred<unknown>();
  let worlds = 0;
  let documents = 0;
  return {
    entered, document,
    async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
      switch (method) {
        case 'Page.enable': return {};
        case 'Page.addScriptToEvaluateOnNewDocument': return { identifier: 'script' };
        case 'Page.removeScriptToEvaluateOnNewDocument': return {};
        case 'Page.getFrameTree': return { frameTree: { frame: { id: 'root', url } } };
        case 'Page.createIsolatedWorld': return { executionContextId: samples[worlds++].context };
        case 'Runtime.evaluate': {
          const sample = samples.find(item => item.context === params?.contextId);
          assert.ok(sample);
          return { result: { value: sample.data } };
        }
        case 'DOM.getDocument':
          if (documents++ === 0) { entered.resolve(); return document.promise; }
          return { root: {} };
        default: throw new Error(`unexpected CDP method: ${method}`);
      }
    },
    async detach() {},
  };
}

function checkFrame(frame: any, index: number) {
  const sample = samples[index];
  assert.deepEqual({
    title: frame.facts.page.title,
    count: frame.facts.nodes.length,
    masks: frame.plan?.masks,
    revision: frame.revision,
    animationIds: frame.animationIds,
    viewportStable: frame.viewportStable,
    maskAnimationActive: frame.maskAnimationActive,
  }, {
    title: sample.data.title,
    count: sample.data.nodes.length,
    masks: [{ x: index === 0 ? 6 : 66, y: 16, width: 18, height: 18 }],
    revision: sample.data.observation.revision,
    animationIds: [`document:${sample.context}`, ...sample.data.observation.animationIds],
    viewportStable: sample.data.observation.viewportStable,
    maskAnimationActive: sample.data.observation.maskAnimationActive,
  });
}

for (const secondKind of ['frame', 'text'] as const) {
  test(`параллельный сбор ${secondKind} не подменяет наблюдение первого кадра`, async () => {
    const { prepareDomCollector } = await import('../../../core/adapters/browser/collect-dom.ts');
    const cdp = port();
    const collector = await prepareDomCollector(cdp, { sourceHost: 'source.example' });
    const first = collector.collectFrame(1);
    await cdp.entered.promise;
    try {
      if (secondKind === 'frame') {
        const second = await collector.collectFrame(2);
        checkFrame(second, 1);
      } else {
        const second = await collector.collectText(2) as any;
        assert.equal(second.page.title, samples[1].data.title);
        assert.equal(second.nodes.length, samples[1].data.nodes.length);
      }
      cdp.document.resolve({ root: {} });
      checkFrame(await first, 0);
    } finally {
      cdp.document.resolve({ root: {} });
      await first.catch(() => {});
      await collector.close();
    }
  });
}

test('закрытие во время подтверждения DOM не возвращает кадр или текст', async () => {
  const { prepareDomCollector } = await import('../../../core/adapters/browser/collect-dom.ts');
  const cdp = port();
  const collector = await prepareDomCollector(cdp, { sourceHost: 'source.example' });
  const pending = collector.collectFrame(1);
  await cdp.entered.promise;
  try {
    await collector.close();
    cdp.document.resolve({ root: {} });
    await assert.rejects(collector.collectText(2));
    await assert.rejects(pending);
  } finally {
    cdp.document.resolve({ root: {} });
    await pending.catch(() => {});
    await collector.close();
  }
});
