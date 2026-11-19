'use strict';

const { readFileSync, realpathSync } = require('node:fs');
const { isBuiltin, registerHooks } = require('node:module');
const { dirname, extname, isAbsolute, join, relative, resolve } = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');

// Release CI only. Keep this policy in the pinned check set and update it with direct test imports.
const publicEntries = new Set([
  'base/install-root.js',
  'base/launcher.js',
  'base/release-materialization.js',
  'base/release-observation.js',
  'base/release-origin.js',
  'base/release-pipeline.js',
  'base/system-install-layout.js',
  'core/adapters/browser/capture-snapshot.ts',
  'core/adapters/browser/chrome-start.ts',
  'core/adapters/browser/collect-dom.ts',
  'core/adapters/browser/png.ts',
  'core/adapters/channel/admission.ts',
  'core/adapters/channel/preparation-mcp.ts',
  'core/adapters/executor/start.ts',
  'core/adapters/store/action-protocol.ts',
  'core/adapters/store/text-snapshot-store.ts',
  'core/adapters/system-observation.ts',
  'core/adapters/system/darwin.ts',
  'core/adapters/technical-log.ts',
  'core/adapters/ui/owner-login-confirmation.ts',
  'core/adapters/ui/owner-window.ts',
  'core/adapters/ui/protocol-view.ts',
  'core/adapters/update/install.ts',
  'core/domain/action-verdict.ts',
  'core/domain/filtered-selector.ts',
  'core/domain/png-gate.ts',
  'core/domain/release.ts',
  'core/domain/snapshot-filter.ts',
  'core/main.ts',
  'core/system-entrypoint.ts',
  'core/use-cases/controlled-read.ts',
  'core/use-cases/preparation.ts',
]);
const resolvedProductFiles = new Set();

// These are the closed check paths from the release contract, independent of candidate code.
const checkDirectories = ['.github/', 'scripts/checks/', 'test/attacks/', 'test/stand/'];
const checkFiles = new Set([
  '.npmrc',
  'package.json',
  'package-lock.json',
  '.node-version',
  '.nvmrc',
  '.prettierignore',
]);
const checkConfig =
  /^(?:tsconfig[^/]*\.json|(?:eslint|prettier)\.config\.[^/]*|\.prettierrc[^/]*)$/;
const root = realpathSync(resolve(__dirname, '../..'));
const lockPath = join(root, 'package-lock.json');
if (realpathSync(lockPath) !== lockPath) deny('package-lock.json');
const { packages } = JSON.parse(readFileSync(lockPath, 'utf8'));

// npm ci verifies the package bytes. The hook checks package ownership and lock locations.
const packageNamePattern = '(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*';
const packageRequest = new RegExp(`^(${packageNamePattern})(?:/|$)`);
const packageLocation = new RegExp(
  `^node_modules/${packageNamePattern}(?:/node_modules/${packageNamePattern})*$`,
);
const locked = new Map(
  Object.entries(packages).filter(
    ([location, entry]) => packageLocation.test(location) && !entry.link && entry.integrity,
  ),
);
const fileScheme = /^file:/i;

// Node gives the migration stand's inherited `fork('-e', ...)` a virtual CommonJS parent.
const evalParent =
  realpathSync(process.cwd()) === root &&
  process.execArgv.some((arg) => /^(-e|--eval)(=|$)/.test(arg))
    ? pathToFileURL(join(root, '[eval]')).href
    : undefined;

function filePath(url) {
  if (!url || !fileScheme.test(url)) return;
  try {
    return fileURLToPath(url);
  } catch {
    return undefined;
  }
}

function repositoryFile(url) {
  const path = filePath(url);
  if (!path) return;
  const file = relative(root, path);
  if (!file || isAbsolute(file) || file === '..' || file.startsWith('../')) return;
  try {
    if (realpathSync(path) === path) return file;
  } catch {
    return undefined;
  }
}

function scope(file) {
  if (!file) return;
  const parts = file.split('/');
  const modules = parts.lastIndexOf('node_modules');
  if (modules !== -1) {
    const end = modules + (parts[modules + 1]?.startsWith('@') ? 3 : 2);
    const location = parts.slice(0, end).join('/');
    if (locked.has(location) && parts.length > end) return location;
    return;
  }
  if (file.startsWith('core/') || file.startsWith('base/')) return 'product';
  if (
    checkFiles.has(file) ||
    checkConfig.test(file) ||
    checkDirectories.some((dir) => file.startsWith(dir))
  ) {
    return 'check';
  }
}

function localRequest(specifier, parentURL) {
  if (fileScheme.test(specifier)) return filePath(specifier);
  if (isAbsolute(specifier)) return resolve(specifier);
  if (/^\.{1,2}(?:\/|$)/.test(specifier)) {
    const parent = filePath(parentURL);
    return resolve(parent ? dirname(parent) : process.cwd(), specifier);
  }
}

function matchesLocalRequest(request, file) {
  const path = join(root, file);
  return (
    path === request || path.startsWith(`${request}/`) || path === `${request}${extname(path)}`
  );
}

function allowsPackage(specifier, request, from, parentScope, destination) {
  const name = packageRequest.exec(specifier)?.[1];
  if (parentScope === destination) {
    return Boolean(
      request ||
      specifier.startsWith('#') ||
      (name && `/${destination}`.endsWith(`/node_modules/${name}`)),
    );
  }
  if (!name || !parentScope) return false;

  const parent = locked.get(parentScope) ?? packages[''];
  const fields = ['dependencies', 'optionalDependencies', 'peerDependencies'];
  if (parentScope === 'check') fields.push('devDependencies');
  if (!fields.some((field) => Object.hasOwn(parent[field] ?? {}, name))) return false;

  // Node searches from the importer outward. Require the corresponding exact lock location.
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    const location = join(dir, 'node_modules', name);
    if (locked.has(location) || dir === '.') return location === destination;
  }
}

function deny(file) {
  process.exitCode = 1;
  throw Object.assign(
    new Error(`Release check import denied: ${file ?? 'unapproved module path or URL'}`),
    {
      code: 'ERR_RELEASE_CHECK_IMPORT',
    },
  );
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      /^[a-z][a-z\d+.-]*:/i.test(specifier) &&
      !fileScheme.test(specifier) &&
      !isBuiltin(specifier)
    ) {
      deny();
    }
    const result = nextResolve(specifier, context);
    if (isBuiltin(result.url)) return result;

    const file = repositoryFile(result.url);
    const destination = scope(file);
    const { parentURL } = context;
    const isEntry = parentURL === undefined;
    const isEval = !isEntry && parentURL === evalParent;
    const from = isEval ? '[eval]' : repositoryFile(parentURL);
    const parent = isEval ? 'check' : scope(from);
    const request = localRequest(specifier, parentURL);
    if (!destination || (request && !matchesLocalRequest(request, file))) deny(file);
    if (parent === 'product' && !resolvedProductFiles.has(from)) deny(file);

    if (destination === 'check' && (isEntry || parent === 'check')) return result;
    if (destination === 'product') {
      if (parent === 'product' || ((isEntry || parent === 'check') && publicEntries.has(file))) {
        resolvedProductFiles.add(file);
        return result;
      }
    } else if (
      destination !== 'check' &&
      allowsPackage(specifier, request, from, parent, destination)
    ) {
      return result;
    }
    deny(file);
  },
});
