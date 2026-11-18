const assert = require('node:assert/strict');
const test = require('node:test');

const base = () => ({
  snapshot: 1,
  page: { url: 'https://source.example/home', title: 'Обзор' },
  frames: [{ index: 0, host: 'source.example', foreign: false, unavailable: false }],
  nodes: [] as object[],
  secrets: [] as object[],
});
const node = (n: number, text: string, extra: object = {}) =>
  ({ n, frame: 0, visible: true, role: 'text', text, ...extra });

test('сохраняет обычный текст и маскирует поля скрытое адреса карточные метки и известные секреты', async () => {
  const { filterTextSnapshot } = await import('../../../core/domain/snapshot-filter.ts');
  const facts = base();
  facts.page = { url: 'https://source.example/account/8f3a9c2e7b1d4f60aa?sid=synthetic-session#private-fragment', title: 'Обзор Novem' };
  facts.frames.push({ index: 1, host: 'foreign.example', foreign: true, unavailable: false });
  facts.secrets = [{ value: 'Novem', kind: 'login' }, { value: '654987', kind: 'code' }];
  facts.nodes = [
    node(1, 'Ｏбычный\u200b текст November и nOvEm', {
      name: 'Привет Novem', attrs: { id: 'ordinary', 'aria-label': 'Novem', title: 'forbidden-attribute' },
      href: 'https://source.example/account/8f3a9c2e7b1d4f60aa?sid=synthetic-session#private-fragment',
    }),
    node(2, 'field-leak', { role: 'textbox', field: 'filled', value: 'field-value-leak' }),
    node(3, 'hidden-leak', { visible: false }),
    node(4, 'foreign-leak', { frame: 1 }),
    ...['4111', '1111', '1111', '1111'].map((part, i) => node(5 + i, part)),
    node(9, 'CVV 739'),
    ...'654987'.split('').map((digit, i) => node(10 + i, digit)),
    node(16, '5555 5555 5555 5556'),
    node(17, '12.03.2026 | 1 250,00'),
  ];
  const result = filterTextSnapshot(facts);
  assert.equal(result.ok, true);
  const snapshot = result.snapshot;
  const json = JSON.stringify(snapshot);
  assert.equal(snapshot.snapshot, 1);
  assert.equal(snapshot.page.host, 'source.example');
  assert.equal(snapshot.truncated, false);
  assert.equal(snapshot.frames.length, 2);
  assert.ok(snapshot.frames.some((frame: { host: string; foreign: boolean }) => frame.host === 'foreign.example' && frame.foreign));
  assert.deepEqual(snapshot.elements.map((element: { n: number }) => element.n), [1, 2, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  const first = snapshot.elements.find((element: { n: number }) => element.n === 1);
  assert.match(first.text, /Oбычный текст November/);
  assert.match(first.text, /\[секрет\]/);
  assert.match(first.name, /\[секрет\]/);
  assert.match(first.attrs['aria-label'], /\[секрет\]/);
  assert.equal(first.attrs.id, 'ordinary');
  assert.equal('title' in first.attrs, false);
  assert.equal(snapshot.elements.find((element: { n: number }) => element.n === 2).field, 'filled');
  for (const forbidden of ['field-leak', 'field-value-leak', 'hidden-leak', 'foreign-leak', 'synthetic-session', 'private-fragment', '8f3a9c2e7b1d4f60aa', '739', '654987', '4111', 'Novem"', 'nOvEm']) {
    assert.equal(json.includes(forbidden), false, `утечка: ${forbidden}`);
  }
  const card = snapshot.elements.filter((element: { n: number }) => element.n >= 5 && element.n <= 8)
    .map((element: { text: string }) => element.text).join('');
  assert.doesNotMatch(card, /4111/);
  assert.match(card, /1111$/);
  for (const element of snapshot.elements.filter((item: { n: number }) => item.n >= 10 && item.n <= 15)) {
    assert.doesNotMatch(element.text, /[654987]/);
  }
  assert.match(json, /5555 5555 5555 5556/);
  assert.match(json, /12\.03\.2026 \| 1 250,00/);
});

test('отказывает при некорректных наблюдениях без возврата сырых полей', async () => {
  const { filterTextSnapshot } = await import('../../../core/domain/snapshot-filter.ts');
  const valid = base();
  for (const facts of [
    null, undefined, [], 'raw-marker',
    { ...valid, snapshot: 0 }, { ...valid, snapshot: '1' },
    { ...valid, page: { url: null, title: 'raw-marker' } },
    { ...valid, frames: null }, { ...valid, nodes: null }, { ...valid, secrets: null },
    { ...valid, nodes: [node(1, 'raw-marker'), node(1, 'duplicate')] },
    { ...valid, nodes: [node(1, 'raw-marker', { frame: 9 })] },
    { ...valid, nodes: [node(1, 'raw-marker', { visible: 'yes' })] },
    { ...valid, secrets: [{ value: 'raw-marker', kind: 'unknown' }] },
  ]) assert.deepEqual(filterTextSnapshot(facts), { ok: false, code: 'internal' });
});

test('ограничивает строки число элементов и размер снимка с признаком усечения', async () => {
  const { filterTextSnapshot } = await import('../../../core/domain/snapshot-filter.ts');
  const long = base();
  long.nodes = [node(1, 'я'.repeat(700))];
  const one = filterTextSnapshot(long);
  assert.equal(one.ok, true);
  assert.ok(one.snapshot.elements[0].text.length <= 500);
  assert.equal(one.snapshot.truncated, true);

  const many = base();
  many.nodes = Array.from({ length: 3001 }, (_, i) => node(i + 1, 'x'));
  const count = filterTextSnapshot(many);
  assert.equal(count.ok, true);
  assert.ok(count.snapshot.elements.length <= 3000);
  assert.equal(count.snapshot.truncated, true);

  const large = base();
  large.nodes = Array.from({ length: 1000 }, (_, i) => node(i + 1, 'я'.repeat(400)));
  const size = filterTextSnapshot(large);
  assert.equal(size.ok, true);
  assert.ok(Buffer.byteLength(JSON.stringify(size.snapshot), 'utf8') <= 256 * 1024);
  assert.equal(size.snapshot.truncated, true);
});
