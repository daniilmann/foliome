'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { productionRepository } = require('./release-origin.js');
const { requireAcl, rootParents } = require('./install-platform.js');
const systemRoot = '/Library/Application Support/Foliome';
const { readReleaseCheckPins, isReleaseNewer } = require(
  __dirname === path.join(systemRoot, 'base') ? './release-policy.ts' : '../core/domain/release.ts',
);

const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const version = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const guid = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/;
const limit = 131072;
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const matches = (re, value) => typeof value === 'string' && re.test(value);
const exact = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const allowedRootFiles = [
  '.claudeignore',
  '.env.template',
  '.gitignore',
  '.node-version',
  '.npmrc',
  '.nvmrc',
  '.prettierignore',
  '.prettierrc.json',
  'AGENTS.md',
  'LICENSE',
  'README.md',
  'eslint.config.mjs',
  'package-lock.json',
  'package.json',
  'setup',
  'tsconfig.json',
];
const allowedDirectories = [
  '.claude',
  '.github',
  'agents',
  'assets',
  'base',
  'config-templates',
  'connectors',
  'core',
  'dashboard',
  'docs',
  'readers',
  'release',
  'scripts',
  'sync-engine',
  'test',
];

function releasePolicy(installedVersion, baseline) {
  return {
    installedVersion,
    repository: productionRepository,
    codexArchiveUrlPrefix: 'https://github.com/openai/codex/releases/download/',
    allowedRootFiles: [...allowedRootFiles],
    allowedDirectories: [...allowedDirectories],
    ...(baseline && {
      workflowId: baseline.initialWorkflow.id,
      pinnedCheckBlobs: { ...baseline.pinnedCheckBlobs },
    }),
  };
}

function parseInstallationRelease(value) {
  if (
    !exact(value, [
      'sha',
      'initialSha',
      'version',
      'ownerUid',
      'executorUid',
      'executorGuid',
      'pfRules',
      'pfDigest',
      'initialWorkflow',
      'pinnedCheckBlobs',
      'keySetSha256',
      ...(value?.runtime === undefined ? [] : ['runtime']),
    ]) ||
    !matches(sha, value.sha) ||
    !matches(sha, value.initialSha) ||
    !matches(version, value.version) ||
    !positive(value.ownerUid) ||
    !positive(value.executorUid) ||
    value.executorUid === value.ownerUid ||
    !matches(guid, value.executorGuid) ||
    !matches(digest, value.pfDigest) ||
    typeof value.pfRules !== 'string' ||
    value.pfRules.length > 65536 ||
    !exact(value.initialWorkflow, ['id', 'runId', 'attempt']) ||
    !Object.values(value.initialWorkflow).every(positive) ||
    !matches(digest, value.keySetSha256) ||
    (value.runtime !== undefined &&
      (!exact(value.runtime, ['node', 'codex', 'planner']) ||
        !Object.values(value.runtime).every((value) => matches(digest, value))))
  )
    throw Error('boundary-state');
  const pinnedCheckBlobs = readReleaseCheckPins(
    value.pinnedCheckBlobs,
    allowedRootFiles,
    allowedDirectories,
  );
  if (!pinnedCheckBlobs) throw Error('boundary-state');
  return { ...value, pinnedCheckBlobs };
}

async function readInstallationRelease() {
  const file = path.join(systemRoot, 'installation-release.json');
  await rootParents(systemRoot);
  await requireAcl(systemRoot, []);
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const s = await handle.stat();
    if (
      !s.isFile() ||
      s.uid !== 0 ||
      s.gid !== 0 ||
      s.nlink !== 1 ||
      (s.mode & 0o7777) !== 0o644 ||
      s.size > limit
    )
      throw Error('boundary-state');
    await requireAcl(file, []);
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== s.size) throw Error('boundary-state');
    return parseInstallationRelease(JSON.parse(bytes.subarray(0, length).toString('utf8')));
  } finally {
    await handle.close();
  }
}

function encodeInstallationRelease(value) {
  const encoded = JSON.stringify(parseInstallationRelease(value));
  if (Buffer.byteLength(encoded) > limit) throw Error('boundary-state');
  return encoded;
}

function keySetSha256(keys) {
  return createHash('sha256')
    .update(JSON.stringify([keys.owner, keys.launch, keys.dev]))
    .digest('hex');
}

function initialProofSha256(sha, keySet, { id, runId, attempt }) {
  return createHash('sha256')
    .update(JSON.stringify([sha, keySet, id, runId, attempt]))
    .digest('hex');
}

module.exports = {
  releasePolicy,
  isReleaseNewer,
  parseInstallationRelease,
  readInstallationRelease,
  encodeInstallationRelease,
  keySetSha256,
  initialProofSha256,
};
