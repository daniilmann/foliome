const assert = require('node:assert/strict');
const test = require('node:test');

test('показывает вердикт и причину независимо от лога и отображает подпись как текст', async () => {
  const { renderProtocol } = await import('../../../core/adapters/ui/protocol-view.ts');
  const label = `Пример <узел> "текст" 'слово' & символ`;
  const rows = [
    {
      atMs: 1700000000000,
      sourceId: 'source-a',
      accessId: 'access-a',
      actor: 'agent',
      method: 'readText',
      snapshotNumber: 12,
      nodeNumber: 34,
      label,
      decision: 'allowed',
      reason: 'allowed',
      outcome: 'ok',
    },
    {
      atMs: 1700000001000,
      sourceId: 'source-b',
      accessId: 'access-b',
      actor: 'agent',
      method: 'other',
      snapshotNumber: 56,
      nodeNumber: null,
      label: '',
      decision: 'blocked',
      reason: 'unsupported',
      outcome: null,
    },
    {
      atMs: 1700000002000,
      sourceId: 'source-c',
      accessId: 'access-c',
      actor: 'agent',
      method: 'readText',
      snapshotNumber: 78,
      nodeNumber: 90,
      decision: 'allowed',
      reason: 'allowed',
      outcome: 'internal',
    },
  ] as const;

  const html: string = renderProtocol(rows);
  assert.equal(typeof html, 'string');
  assert.match(html, /<table(?:\s[^>]*)?>/i);
  assert.match(html, /<\/table\s*>/i);
  // Допускаются только элементы таблицы и безопасные атрибуты оформления.
  for (const tag of html.match(/<[^>]*>/g) ?? []) {
    assert.match(
      tag,
      /^<\/?(?:table|thead|tbody|tfoot|tr|th|td)(?:\s+(?:class|scope)=(?:"[\w -]*"|'[\w -]*'))*\s*>$/i,
    );
  }
  assert.doesNotMatch(html, /<(?!\/?(?:table|thead|tbody|tfoot|tr|th|td)(?:\s|>))/i);

  const decode = (value: string) =>
    value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_: string, entity: string) => {
      const named: Record<string, string> = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
        nbsp: ' ',
      };
      if (entity[0] === '#')
        return String.fromCodePoint(
          entity[1].toLowerCase() === 'x'
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10),
        );
      return named[entity.toLowerCase()];
    });
  const tableRows = html.match(/<tr(?:\s[^>]*)?>[\s\S]*?<\/tr\s*>/gi) ?? [];
  const visibleRow = (source: string) => {
    const matches = tableRows.filter((row: string) =>
      decode(row.replace(/<[^>]*>/g, ' ')).includes(source),
    );
    assert.equal(matches.length, 1, `одна строка для ${source}`);
    return decode(matches[0].replace(/<[^>]*>/g, ' '));
  };
  const first = visibleRow('source-a');
  const second = visibleRow('source-b');
  const third = visibleRow('source-c');
  for (const [text, expected] of [
    [
      first,
      [
        '2023-11-14T22:13:20',
        'access-a',
        'agent',
        'readText',
        '12',
        '34',
        'разрешено',
        'allowed',
        'ok',
        label,
      ],
    ],
    [
      second,
      ['2023-11-14T22:13:21', 'access-b', 'agent', 'other', '56', 'заблокировано', 'unsupported'],
    ],
    [
      third,
      [
        '2023-11-14T22:13:22',
        'access-c',
        'agent',
        'readText',
        '78',
        '90',
        'разрешено',
        'allowed',
        'internal',
      ],
    ],
  ] as const) {
    for (const value of expected) assert.ok(text.includes(value), `в строке отсутствует ${value}`);
  }
  assert.doesNotMatch(html, /<узел>/);
  assert.doesNotMatch(second + third, /\b(?:null|undefined)\b/);
});
