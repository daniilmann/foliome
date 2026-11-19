'use strict';

// Observations are untrusted until the separately installed verifier checks the
// commit, pinned check bytes, publisher signatures and installed trust policy.
// Neither this reader nor a successful CI run authorizes activation.
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const shaPattern = /^[a-f0-9]{40}$/;
const repositoryPattern = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const requiredJobs = [
  'typescript',
  'eslint',
  'prettier',
  'unit',
  'stand',
  'protective',
  'signatures',
  'advisory',
  'migration',
];
const jsonLimit = 8 * 1024 * 1024;
// The canonical npm package document includes publication times for every version.
const registryLimit = 32 * 1024 * 1024;
const archiveLimit = 256 * 1024 * 1024;
const timeout = 30000;

function isReleaseRepository(value) {
  return (
    typeof value === 'string' &&
    repositoryPattern.test(value) &&
    value.split('/').every((part) => !['.', '..', '.git'].includes(part.toLowerCase()))
  );
}

function canonicalUrl(value, host) {
  if (typeof value !== 'string' || !value.startsWith(`https://${host}/`)) throw Error();
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.host !== host || url.username || url.password || url.hash)
    throw Error();
  return url;
}

async function fetchBounded(url, limit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      signal: controller.signal,
      headers: {
        accept: new URL(url).hostname === 'api.github.com' ? 'application/vnd.github+json' : '*/*',
        'user-agent': 'release-reader',
      },
    });
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw Error();
    const chunks = [];
    let size = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) throw Error();
        chunks.push(chunk);
      }
    }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.concat(chunks),
    };
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}

async function request(transport, url, limit) {
  const response = await transport(url, limit);
  if (
    !response ||
    !Number.isInteger(response.status) ||
    !Buffer.isBuffer(response.body) ||
    response.body.length > limit ||
    !response.headers ||
    typeof response.headers !== 'object'
  )
    throw Error();
  return response;
}

async function json(transport, url, limit = jsonLimit) {
  const response = await request(transport, url, limit);
  if (response.status !== 200) throw Error();
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body));
}

function completeList(value, field) {
  if (
    !value ||
    !Number.isSafeInteger(value.total_count) ||
    value.total_count < 1 ||
    value.total_count > 100 ||
    !Array.isArray(value[field]) ||
    value[field].length !== value.total_count
  )
    throw Error();
  return value[field];
}

async function readReleaseOrigin(input) {
  try {
    const { policy, version, sha, now, verifyBase } = input;
    if (
      !policy ||
      !isReleaseRepository(policy.repository) ||
      !Number.isSafeInteger(policy.workflowId) ||
      policy.workflowId < 1 ||
      !versionPattern.test(version) ||
      !shaPattern.test(sha) ||
      typeof verifyBase !== 'function'
    )
      throw Error();
    const current = Date.parse(now);
    if (
      typeof now !== 'string' ||
      !Number.isFinite(current) ||
      new Date(current).toISOString() !== now
    )
      throw Error();
    const transport = input.transport === undefined ? fetchBounded : input.transport;
    if (typeof transport !== 'function') throw Error();
    const api = `https://api.github.com/repos/${policy.repository}`;
    const tag = `v${version}`;
    const ref = await json(transport, `${api}/git/ref/tags/${tag}`);
    if (ref?.ref !== `refs/tags/${tag}` || ref.object?.type !== 'commit' || ref.object.sha !== sha)
      throw Error();
    const content = await json(transport, `${api}/contents/release/manifest.json?ref=${sha}`);
    if (content?.encoding !== 'base64' || typeof content.content !== 'string') throw Error();
    const encoded = content.content.replace(/\n/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
      throw Error();
    const manifestBytes = Buffer.from(encoded, 'base64');
    if (manifestBytes.toString('base64') !== encoded) throw Error();
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
    const codexVersion = manifest?.codex?.version;
    const playwrightVersion = manifest?.playwrightCore?.version;
    if (
      manifest.version !== version ||
      !versionPattern.test(codexVersion) ||
      !versionPattern.test(playwrightVersion) ||
      !playwrightVersion.startsWith('1.64.')
    )
      throw Error();
    const codexUrl = `https://github.com/openai/codex/releases/download/rust-v${codexVersion}/codex-aarch64-apple-darwin.tar.gz`;
    if (manifest.codex.url !== codexUrl) throw Error();
    canonicalUrl(codexUrl, 'github.com');
    const runs = completeList(
      await json(
        transport,
        `${api}/actions/workflows/${policy.workflowId}/runs?event=push&head_sha=${sha}&per_page=100&page=1`,
      ),
      'workflow_runs',
    );
    // Multiple matching runs are ambiguous: do not choose an older successful run.
    if (runs.length !== 1) throw Error();
    const run = runs[0];
    if (
      !Number.isSafeInteger(run.id) ||
      run.id < 1 ||
      !Number.isSafeInteger(run.run_attempt) ||
      run.run_attempt < 1 ||
      run.workflow_id !== policy.workflowId ||
      run.event !== 'push' ||
      run.status !== 'completed' ||
      run.conclusion !== 'success' ||
      run.head_sha !== sha ||
      run.head_branch !== tag ||
      run.head_repository?.full_name !== policy.repository ||
      run.repository?.full_name !== policy.repository ||
      !Array.isArray(run.pull_requests) ||
      run.pull_requests.length
    )
      throw Error();
    const jobs = completeList(
      await json(
        transport,
        `${api}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=1`,
      ),
      'jobs',
    );
    const names = new Set();
    for (const job of jobs) {
      if (
        !job ||
        typeof job.name !== 'string' ||
        names.has(job.name) ||
        job.run_id !== run.id ||
        job.head_sha !== sha ||
        job.head_branch !== tag ||
        job.run_attempt !== run.run_attempt ||
        job.status !== 'completed' ||
        job.conclusion !== 'success'
      )
        throw Error();
      names.add(job.name);
    }
    if (!requiredJobs.every((name) => names.has(name))) throw Error();
    const npm = await json(transport, 'https://registry.npmjs.org/playwright-core', registryLimit);
    const packageVersion = npm?.versions?.[playwrightVersion];
    const publishedAt = npm?.time?.[playwrightVersion];
    const published = Date.parse(publishedAt);
    if (
      npm?.name !== 'playwright-core' ||
      packageVersion?.name !== 'playwright-core' ||
      packageVersion.version !== playwrightVersion ||
      typeof publishedAt !== 'string' ||
      !Number.isFinite(published) ||
      new Date(published).toISOString() !== publishedAt ||
      current - published < 30 * 86400000
    )
      throw Error();
    const redirect = await request(transport, codexUrl, jsonLimit);
    if (redirect.status !== 302 || typeof redirect.headers.location !== 'string') throw Error();
    canonicalUrl(redirect.headers.location, 'release-assets.githubusercontent.com');
    const archive = await request(transport, redirect.headers.location, archiveLimit);
    if (archive.status !== 200 || archive.body.length === 0) throw Error();
    // Installed code binds these observations to the independently read Git bytes.
    const observations = {
      sha,
      version,
      tag: { name: tag, sha },
      manifest,
      manifestBytes,
      run,
      jobs,
      candidateRun: {
        head_sha: run.head_sha,
        event: run.event,
        head_branch: run.head_branch,
        head_repository: { full_name: run.head_repository.full_name },
        workflow_id: run.workflow_id,
        conclusion: run.conclusion,
      },
      registry: {
        metadata: packageVersion,
        publishedAt,
        now,
        publishedAgeDays: (current - published) / 86400000,
      },
      codexBytes: archive.body,
    };
    if ((await verifyBase(observations)) !== true) throw Error();
    return { ok: true, sha, version };
  } catch {
    // Never expose a redirect URL or remote response in errors or logs.
    return { ok: false };
  }
}

async function readReleaseArchive(url, limit) {
  const response = await request(fetchBounded, url, limit);
  if (response.status !== 200 || !response.body.length) throw Error();
  return response.body;
}

async function readProductionWorkflowId() {
  const workflow = await json(
    fetchBounded,
    'https://api.github.com/repos/daniilmann/foliome/actions/workflows/release.yml',
  );
  if (
    workflow?.path !== '.github/workflows/release.yml' ||
    !Number.isSafeInteger(workflow.id) ||
    workflow.id <= 0
  )
    throw Error('workflow');
  return workflow.id;
}

function playwrightArchiveUrl(version) {
  if (typeof version !== 'string' || !/^1\.64\.(0|[1-9]\d*)$/.test(version)) throw Error();
  return `https://registry.npmjs.org/playwright-core/-/playwright-core-${version}.tgz`;
}

async function readReleaseArchives(nodeVersion, playwrightVersion, observedTarball) {
  if (typeof nodeVersion !== 'string' || !/^26\.13\.(0|[1-9]\d*)$/.test(nodeVersion)) throw Error();
  const playwrightUrl = playwrightArchiveUrl(playwrightVersion);
  if (observedTarball !== playwrightUrl) throw Error();
  const nodeArchive = `node-v${nodeVersion}-darwin-arm64.tar.gz`;
  const node = await readReleaseArchive(
    `https://nodejs.org/dist/v${nodeVersion}/${nodeArchive}`,
    128 * 1024 * 1024,
  );
  const playwright = await readReleaseArchive(playwrightUrl, 32 * 1024 * 1024);
  return { node, nodeArchive, playwright };
}

module.exports = {
  readReleaseOrigin,
  readReleaseArchives,
  readProductionWorkflowId,
  isReleaseRepository,
  playwrightArchiveUrl,
};
