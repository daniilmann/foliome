function exact<Key extends string>(
  value: unknown,
  keys: readonly Key[],
): value is Record<Key, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

const sourceFields = ['url', 'sessionId', 'sourceId', 'accessId', 'instruction'] as const;
type Source = Record<(typeof sourceFields)[number], string>;

function isSource(value: unknown): value is Source {
  return (
    exact(value, sourceFields) &&
    Object.values(value).every(
      (v) =>
        typeof v === 'string' &&
        v.length > 0 &&
        v.length <= 4096 &&
        !/[\u0000-\u001f\u007f]/.test(v),
    )
  );
}

function parseSource(value: unknown): Source {
  if (!isSource(value)) throw Error('owner-config');
  const url = new URL(value.url);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash)
    throw Error('owner-config');
  return value;
}

function parse(value: unknown): { source: Source; executorUid: number } {
  if (
    !exact(value, ['source', 'executorUid']) ||
    typeof value.executorUid !== 'number' ||
    !Number.isSafeInteger(value.executorUid) ||
    value.executorUid <= 0
  )
    throw Error('owner-config');
  return { source: parseSource(value.source), executorUid: value.executorUid };
}

export declare const parseInstalledConfig: typeof parse;
export declare const parseInstalledSource: typeof parseSource;
declare const exports: {
  parseInstalledConfig: typeof parse;
  parseInstalledSource: typeof parseSource;
};
exports.parseInstalledConfig = parse;
exports.parseInstalledSource = parseSource;
