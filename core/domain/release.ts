export type ReleaseCandidateResult =
  | { ok: true; checks: 'pinned' | 'changed' }
  | {
      ok: false;
      code:
        | 'candidate'
        | 'policy'
        | 'manifest'
        | 'tag'
        | 'workflow'
        | 'tree'
        | 'dependency'
        | 'signature';
    };

const requiredCheckPaths = ['.github/workflows/release.yml', 'package.json', 'package-lock.json'];
const requiredReleasePaths = [
  ...requiredCheckPaths,
  'README.md',
  'release/manifest.json',
  'release/notes.en.md',
];

const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const gitShaPattern = /^[a-f0-9]{40}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
// A SHA-512 digest has 64 bytes, so the final base64 digit has four zero padding bits.
const integrityPattern = /^sha512-[A-Za-z0-9+/]{85}[AQgw]==$/;
const repositoryPattern = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

type ReleasePolicy = {
  installedVersion: string;
  repository: string;
  workflowId: number;
  codexArchiveUrlPrefix: string;
  allowedRootFiles: ReadonlySet<string>;
  allowedDirectories: ReadonlySet<string>;
  pinnedCheckBlobs: ReadonlyMap<string, string>;
};

type Manifest = {
  version: string;
  nodeSha256: string;
  codexSha256: string;
  playwrightVersion: string;
  playwrightIntegrity: string;
};

/**
 * Checks normalized release metadata against installed policy and adapter observations.
 * Adapters must read the manifest and dependency metadata from the fetched commit, observe
 * the package publication age independently, enforce byte and size limits, compare root/base
 * changes to the installed tree, and check the rejected-SHA list. Artifact observations require
 * actual verification of publisher, digest, and version. Success covers this metadata contract.
 */
export declare function validateReleaseCandidate(
  candidate: unknown,
  trustedPolicy: unknown,
): ReleaseCandidateResult;

// The package loads .ts files as CommonJS and Node strips the type declaration above.
declare const exports: { validateReleaseCandidate: typeof validateReleaseCandidate };
exports.validateReleaseCandidate = function validateReleaseCandidate(candidate, trustedPolicy) {
  const policy = readPolicy(trustedPolicy);
  if (!policy) return { ok: false, code: 'policy' };

  const input = readRecord(candidate, ['tag', 'manifest', 'run', 'evidence'], false);
  if (!input) return { ok: false, code: 'candidate' };

  const manifest = readManifest(input.manifest, policy.codexArchiveUrlPrefix);
  if (!manifest) return { ok: false, code: 'manifest' };

  const tag = readRecord(input.tag, ['name', 'sha']);
  if (
    !tag ||
    tag.name !== `v${manifest.version}` ||
    !matches(tag.sha, gitShaPattern) ||
    !isNewerVersion(manifest.version, policy.installedVersion)
  ) {
    return { ok: false, code: 'tag' };
  }

  const run = readRecord(input.run, [
    'head_sha',
    'event',
    'head_branch',
    'head_repository',
    'workflow_id',
    'conclusion',
  ]);
  const repository = readRecord(run?.head_repository, ['full_name']);
  if (
    !run ||
    run.head_sha !== tag.sha ||
    run.event !== 'push' ||
    run.head_branch !== tag.name ||
    repository?.full_name !== policy.repository ||
    run.workflow_id !== policy.workflowId ||
    run.conclusion !== 'success'
  ) {
    return { ok: false, code: 'workflow' };
  }

  const evidence = readRecord(
    input.evidence,
    ['commitSha', 'tree', 'runtimeDependencies', 'signatures'],
    false,
  );
  if (!evidence || evidence.commitSha !== tag.sha) return { ok: false, code: 'tree' };

  const tree = readTree(evidence.tree, policy);
  if (!tree || !requiredReleasePaths.every((path) => tree.has(path))) {
    return { ok: false, code: 'tree' };
  }

  if (!matchesDependency(evidence.runtimeDependencies, manifest)) {
    return { ok: false, code: 'dependency' };
  }

  const signatures = readRecord(evidence.signatures, ['node', 'codex', 'playwrightCore']);
  if (
    !signatures ||
    !matchesSignature(signatures.node, 'sha256', manifest.nodeSha256) ||
    !matchesSignature(signatures.codex, 'sha256', manifest.codexSha256) ||
    !matchesSignature(signatures.playwrightCore, 'integrity', manifest.playwrightIntegrity)
  ) {
    return { ok: false, code: 'signature' };
  }

  const checksChanged =
    [...policy.pinnedCheckBlobs].some(([path, sha]) => tree.get(path) !== sha) ||
    [...tree.keys()].some((path) => isCheckPath(path) && !policy.pinnedCheckBlobs.has(path));
  return { ok: true, checks: checksChanged ? 'changed' : 'pinned' };
};

function readPolicy(value: unknown): ReleasePolicy | undefined {
  const policy = readRecord(value, [
    'installedVersion',
    'repository',
    'workflowId',
    'codexArchiveUrlPrefix',
    'allowedRootFiles',
    'allowedDirectories',
    'pinnedCheckBlobs',
  ]);
  if (!policy) return;

  const { installedVersion, repository, workflowId, codexArchiveUrlPrefix } = policy;
  if (
    !matches(installedVersion, versionPattern) ||
    !matches(repository, repositoryPattern) ||
    !repository.split('/').every(isPathComponent) ||
    typeof workflowId !== 'number' ||
    !Number.isSafeInteger(workflowId) ||
    workflowId <= 0 ||
    !isArchivePrefix(codexArchiveUrlPrefix)
  ) {
    return;
  }

  const rootNames = new Set<string>();
  const allowedRootFiles = readRootNames(policy.allowedRootFiles, rootNames);
  const allowedDirectories = readRootNames(policy.allowedDirectories, rootNames);
  const pins = readRecord(policy.pinnedCheckBlobs);
  if (!allowedRootFiles || !allowedDirectories || !pins) return;

  const seenPaths = new Map<string, TreePath>();
  const pinnedCheckBlobs = new Map<string, string>();
  for (const [path, sha] of Object.entries(pins)) {
    if (
      !matches(sha, gitShaPattern) ||
      !registerPath(path, allowedRootFiles, allowedDirectories, seenPaths)
    ) {
      return;
    }
    pinnedCheckBlobs.set(path, sha);
  }
  if (!requiredCheckPaths.every((path) => pinnedCheckBlobs.has(path))) return;

  return {
    installedVersion,
    repository,
    workflowId,
    codexArchiveUrlPrefix,
    allowedRootFiles,
    allowedDirectories,
    pinnedCheckBlobs,
  };
}

function readManifest(value: unknown, codexPrefix: string): Manifest | undefined {
  const manifest = readRecord(value, [
    'schema',
    'version',
    'node',
    'codex',
    'playwrightCore',
    'securityFix',
    'securityNarrowing',
    'rootChange',
    'baseChange',
    'notesRu',
  ]);
  if (!manifest) return;

  const { version, securityNarrowing } = manifest;
  // The input contract has no independent advisory finding, so the exception is unavailable.
  if (
    manifest.schema !== 'foliome-release/1' ||
    !matches(version, versionPattern) ||
    manifest.securityFix !== null ||
    typeof manifest.rootChange !== 'boolean' ||
    typeof manifest.baseChange !== 'boolean' ||
    !isReleaseText(manifest.notesRu) ||
    (securityNarrowing !== null &&
      !isReleaseText(readRecord(securityNarrowing, ['reasonRu'])?.reasonRu))
  ) {
    return;
  }

  const node = readRecord(manifest.node, ['version', 'sha256']);
  const codex = readRecord(manifest.codex, ['version', 'sha256', 'url']);
  const playwright = readRecord(manifest.playwrightCore, ['version', 'integrity']);
  if (
    !node ||
    !matches(node.version, versionPattern) ||
    !node.version.startsWith('26.13.') ||
    !matches(node.sha256, sha256Pattern) ||
    !codex ||
    !matches(codex.version, versionPattern) ||
    !matches(codex.sha256, sha256Pattern) ||
    typeof codex.url !== 'string' ||
    !codex.url.startsWith(codexPrefix) ||
    !codex.url.slice(codexPrefix.length).split('/').every(isArchiveComponent) ||
    !playwright ||
    !matches(playwright.version, versionPattern) ||
    !playwright.version.startsWith('1.64.') ||
    !matches(playwright.integrity, integrityPattern)
  ) {
    return;
  }

  return {
    version,
    nodeSha256: node.sha256,
    codexSha256: codex.sha256,
    playwrightVersion: playwright.version,
    playwrightIntegrity: playwright.integrity,
  };
}

function matchesDependency(value: unknown, manifest: Manifest): boolean {
  const dependencies = readArray(value);
  if (dependencies?.length !== 1) return false;

  const dependency = readRecord(dependencies[0], [
    'name',
    'version',
    'integrity',
    'hasInstallScript',
    'publishedAgeDays',
  ]);
  return (
    dependency !== undefined &&
    dependency.name === 'playwright-core' &&
    dependency.version === manifest.playwrightVersion &&
    dependency.integrity === manifest.playwrightIntegrity &&
    dependency.hasInstallScript === false &&
    typeof dependency.publishedAgeDays === 'number' &&
    Number.isFinite(dependency.publishedAgeDays) &&
    dependency.publishedAgeDays >= 30
  );
}

function matchesSignature(
  value: unknown,
  field: 'sha256' | 'integrity',
  expected: string,
): boolean {
  const signature = readRecord(value, ['status', field]);
  return signature?.status === 'verified' && signature[field] === expected;
}

type TreePath = { path: string; isFile: boolean };

function readTree(value: unknown, policy: ReleasePolicy): ReadonlyMap<string, string> | undefined {
  const entries = readArray(value);
  if (!entries) return;

  const seenPaths = new Map<string, TreePath>();
  const blobs = new Map<string, string>();
  for (const value of entries) {
    const entry = readRecord(value, ['path', 'blobSha', 'mode']);
    // The policy input has no executable file allowlist.
    if (
      !entry ||
      entry.mode !== '100644' ||
      typeof entry.path !== 'string' ||
      !matches(entry.blobSha, gitShaPattern) ||
      !registerPath(entry.path, policy.allowedRootFiles, policy.allowedDirectories, seenPaths)
    ) {
      return;
    }
    blobs.set(entry.path, entry.blobSha);
  }
  return blobs;
}

function registerPath(
  path: string,
  rootFiles: ReadonlySet<string>,
  directories: ReadonlySet<string>,
  seen: Map<string, TreePath>,
): boolean {
  const parts = path.split('/');
  if (
    !parts.every(isPathComponent) ||
    path.toLowerCase().endsWith('.node') ||
    !(parts.length === 1 ? rootFiles.has(path) : directories.has(parts[0] ?? ''))
  ) {
    return false;
  }

  let prefix = '';
  for (const part of parts) {
    prefix = prefix === '' ? part : `${prefix}/${part}`;
    const key = prefix.toLowerCase();
    const isFile = prefix === path;
    const previous = seen.get(key);
    if (previous && (previous.path !== prefix || previous.isFile || isFile)) return false;
    seen.set(key, { path: prefix, isFile });
  }
  return true;
}

function isPathComponent(value: string): boolean {
  return (
    /^[A-Za-z0-9._-]+$/.test(value) &&
    value !== '.' &&
    value !== '..' &&
    value.toLowerCase() !== '.git'
  );
}

function readRootNames(value: unknown, seen: Set<string>): ReadonlySet<string> | undefined {
  const names = readArray(value);
  if (!names) return;

  const result = new Set<string>();
  for (const name of names) {
    if (typeof name !== 'string' || !isPathComponent(name)) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.add(name);
  }
  return result;
}

function isCheckPath(path: string): boolean {
  const name = path.toLowerCase();
  if (name.includes('/')) {
    return ['.github/', 'scripts/checks/', 'test/attacks/', 'test/stand/'].some((prefix) =>
      name.startsWith(prefix),
    );
  }
  return (
    [
      '.npmrc',
      'package.json',
      'package-lock.json',
      '.node-version',
      '.nvmrc',
      '.prettierignore',
    ].includes(name) ||
    /^tsconfig[^/]*\.json$/.test(name) ||
    ['eslint.config.', 'prettier.config.', '.prettierrc'].some((prefix) => name.startsWith(prefix))
  );
}

function isArchivePrefix(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('https://') || !value.endsWith('/')) {
    return false;
  }
  const [host, ...path] = value.slice('https://'.length, -1).split('/');
  const labels = host?.split('.');
  return (
    labels !== undefined &&
    labels.length > 1 &&
    labels.every(
      (label) => /^[a-z0-9-]+$/.test(label) && !label.startsWith('-') && !label.endsWith('-'),
    ) &&
    path.every(isArchiveComponent)
  );
}

function isArchiveComponent(value: string): boolean {
  return /^[A-Za-z0-9._~-]+$/.test(value) && value !== '.' && value !== '..';
}

function isReleaseText(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length <= 4_000 &&
    !value.includes('\0') &&
    [...value].length <= 2_000
  );
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}

function isNewerVersion(candidate: string, installed: string): boolean {
  const installedParts = installed.split('.');
  for (const [index, part] of candidate.split('.').entries()) {
    const current = installedParts[index] ?? '';
    if (part.length !== current.length) return part.length > current.length;
    if (part !== current) return part > current;
  }
  return false;
}

function readRecord<const Key extends string = string>(
  input: unknown,
  keys?: readonly Key[],
  requireAll = true,
): Record<Key, unknown> | undefined {
  if (typeof input !== 'object' || input === null) return;
  try {
    const prototype: unknown = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return;

    const descriptors = Object.getOwnPropertyDescriptors(input);
    const fields = Reflect.ownKeys(descriptors);
    if (keys && requireAll && fields.length !== keys.length) return;

    const record: Record<string, unknown> = Object.create(null);
    for (const field of fields) {
      if (typeof field !== 'string' || (keys && !keys.some((key) => key === field))) return;
      const descriptor = descriptors[field];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return;
      record[field] = descriptor.value;
    }
    return record as Record<Key, unknown>;
  } catch {
    return;
  }
}

function readArray(input: unknown): readonly unknown[] | undefined {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return;
    const length: unknown = Object.getOwnPropertyDescriptor(input, 'length')?.value;
    if (typeof length !== 'number' || Reflect.ownKeys(input).length !== length + 1) return;

    const items: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(input, index);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return;
      items.push(descriptor.value);
    }
    return items;
  } catch {
    return;
  }
}
