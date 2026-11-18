const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { test }: typeof import('node:test') = require('node:test');

/* Proposed installed adapter: base/release-origin.js exports async readReleaseOrigin({
 * policy: {repository, workflowId}, version, sha, now, transport, verifyBase
 * }). transport(url) returns {status, headers, body: Buffer}, never follows redirects.
 * verifyBase({sha, manifest, codexBytes}) is the installed closed verifier, returning
 * boolean; it is not supplied by the release. Success is {ok:true, sha, version};
 * refusal is {ok:false}. This only observes a candidate; it does not accept or install.
 * Inputs and every JSON body are untrusted. Read the GitHub ref, manifest at sha,
 * workflow runs filtered by event and head_sha, individual run jobs, and npm package
 * metadata. Follow a Codex redirect only to release-assets.githubusercontent.com.
 */
const repository = 'example-owner/example-project';
const version = '1.2.3';
const sha = 'a'.repeat(40);
const workflowId = 12345;
const tag = `v${version}`;
const api = `https://api.github.com/repos/${repository}`;
const refUrl = `${api}/git/ref/tags/${tag}`;
const manifestUrl = `${api}/contents/release/manifest.json?ref=${sha}`;
const runsUrl = `${api}/actions/workflows/${workflowId}/runs?event=push&head_sha=${sha}`;
const jobsUrl = `${api}/actions/runs/42/jobs`;
const npmUrl = 'https://registry.npmjs.org/playwright-core';
const codexUrl =
  'https://github.com/example-publisher/example-tool/releases/download/v1.0.0/tool.tar.gz';
const assetUrl = 'https://release-assets.githubusercontent.com/example/tool.tar.gz';
const jobNames = [
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
type Response = { status: number; headers: Record<string, string>; body: Buffer };
const json = (value: unknown): Response => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(value)),
});

function fixture() {
  const manifest = {
    schema: 'foliome-release/1',
    version,
    node: { version: '26.13.1', sha256: 'b'.repeat(64) },
    codex: { version: '1.0.0', sha256: 'c'.repeat(64), url: codexUrl },
    playwrightCore: {
      version: '1.64.1',
      integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
    },
    securityFix: null,
    securityNarrowing: null,
    rootChange: false,
    baseChange: false,
    notesRu: 'Тест',
  };
  const ref = { ref: `refs/tags/${tag}`, object: { type: 'commit', sha } };
  const run = {
    id: 42,
    workflow_id: workflowId,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_sha: sha,
    head_branch: tag,
    head_repository: { full_name: repository },
    repository: { full_name: repository },
    pull_requests: [],
  };
  const jobs = {
    total_count: jobNames.length,
    jobs: jobNames.map((name) => ({ name, status: 'completed', conclusion: 'success' })),
  };
  const npm = {
    name: 'playwright-core',
    versions: { '1.64.1': { name: 'playwright-core', version: '1.64.1' } },
    time: { '1.64.1': '2026-01-01T00:00:00.000Z' },
  };
  const responses = new Map<string, Response>();
  const setManifest = () =>
    responses.set(
      manifestUrl,
      json({
        encoding: 'base64',
        content: Buffer.from(JSON.stringify(manifest)).toString('base64'),
      }),
    );
  const setRun = () => responses.set(runsUrl, json({ total_count: 1, workflow_runs: [run] }));
  const setJobs = () => responses.set(jobsUrl, json(jobs));
  const setNpm = () => responses.set(npmUrl, json(npm));
  responses.set(refUrl, json(ref));
  setManifest();
  setRun();
  setJobs();
  setNpm();
  responses.set(codexUrl, { status: 302, headers: { location: assetUrl }, body: Buffer.alloc(0) });
  responses.set(assetUrl, { status: 200, headers: {}, body: Buffer.from('synthetic codex bytes') });
  const requests: string[] = [];
  let verified = 0;
  const input = {
    policy: { repository, workflowId },
    version,
    sha,
    now: '2026-01-31T00:00:00.000Z',
    transport: async (url: string) => {
      requests.push(url);
      const response = responses.get(url);
      if (!response) throw new Error('unexpected request');
      return response;
    },
    verifyBase: async (observed: { sha: string; manifest: unknown; codexBytes: Buffer }) => {
      verified++;
      assert.equal(observed.sha, sha);
      assert.deepEqual(observed.manifest, manifest);
      assert.deepEqual(observed.codexBytes, Buffer.from('synthetic codex bytes'));
      return true;
    },
  };
  return {
    input,
    ref,
    run,
    jobs,
    npm,
    manifest,
    responses,
    requests,
    setManifest,
    setRun,
    setJobs,
    setNpm,
    verified: () => verified,
  };
}
function port(): {
  readReleaseOrigin: (input: unknown) => Promise<{ ok: boolean; sha?: string; version?: string }>;
} {
  return require('../../base/release-origin.js');
}

test('читает независимые байты метаданных кандидата до отдельного принятия', async () => {
  const f = fixture();
  assert.deepEqual(await port().readReleaseOrigin(f.input), { ok: true, sha, version });
  for (const url of [refUrl, manifestUrl, runsUrl, jobsUrl, npmUrl, codexUrl, assetUrl])
    assert.ok(f.requests.includes(url), url);
  assert.equal(f.verified(), 1);
});

test('отклоняет чужой тег, SHA, проект и прогон без точной привязки', async () => {
  for (const kind of [
    'sha-format',
    'ref',
    'ref-sha',
    'manifest-version',
    'workflow',
    'event',
    'sha',
    'branch',
    'fork',
    'project',
    'pr',
    'status',
    'conclusion',
  ]) {
    const f = fixture();
    switch (kind) {
      case 'sha-format':
        f.input.sha = 'A'.repeat(40);
        break;
      case 'ref':
        f.ref.ref = `refs/heads/${tag}`;
        f.responses.set(refUrl, json(f.ref));
        break;
      case 'ref-sha':
        f.ref.object.sha = 'd'.repeat(40);
        f.responses.set(refUrl, json(f.ref));
        break;
      case 'manifest-version':
        f.manifest.version = '1.2.4';
        f.setManifest();
        break;
      case 'workflow':
        f.run.workflow_id++;
        f.setRun();
        break;
      case 'event':
        f.run.event = 'pull_request';
        f.setRun();
        break;
      case 'sha':
        f.run.head_sha = 'd'.repeat(40);
        f.setRun();
        break;
      case 'branch':
        f.run.head_branch = 'main';
        f.setRun();
        break;
      case 'fork':
        f.run.head_repository.full_name = 'example-owner/other';
        f.setRun();
        break;
      case 'project':
        f.run.repository.full_name = 'example-owner/other';
        f.setRun();
        break;
      case 'pr':
        (f.run.pull_requests as unknown[]).push({ number: 1 });
        f.setRun();
        break;
      case 'status':
        f.run.status = 'in_progress';
        f.setRun();
        break;
      case 'conclusion':
        f.run.conclusion = 'failure';
        f.setRun();
        break;
    }
    assert.equal((await port().readReleaseOrigin(f.input)).ok, false, kind);
  }
});

test('требует каждую отдельную успешную проверку включая подписи и advisory', async () => {
  for (const name of jobNames)
    for (const defect of ['missing', 'failed', 'unfinished']) {
      const f = fixture();
      const job = f.jobs.jobs.find((item) => item.name === name)!;
      if (defect === 'missing') {
        f.jobs.jobs = f.jobs.jobs.filter((item) => item.name !== name);
        f.jobs.total_count--;
      }
      if (defect === 'failed') job.conclusion = 'failure';
      if (defect === 'unfinished') job.status = 'in_progress';
      f.setJobs();
      assert.equal((await port().readReleaseOrigin(f.input)).ok, false, `${name}: ${defect}`);
    }
});

test('сверяет возраст версии пакета по независимому времени реестра', async () => {
  for (const [published, expected] of [
    ['2026-01-01T00:00:00.000Z', true],
    ['2026-01-01T00:00:00.001Z', false],
    ['2026-02-01T00:00:00.000Z', false],
    ['invalid', false],
  ] as const) {
    const f = fixture();
    f.npm.time['1.64.1'] = published;
    f.setNpm();
    assert.equal((await port().readReleaseOrigin(f.input)).ok, expected, published);
  }
  const f = fixture();
  f.npm.versions['1.64.1'].version = '1.64.2';
  f.setNpm();
  assert.equal((await port().readReleaseOrigin(f.input)).ok, false);
});

test('ограничивает перенаправление Codex и отклоняет испорченный JSON или отказ проверяющего', async () => {
  for (const location of [
    'http://release-assets.githubusercontent.com/example/tool.tar.gz',
    'https://other.example/tool',
    'https://user@release-assets.githubusercontent.com/example/tool.tar.gz',
    'https://release-assets.githubusercontent.com.evil.example/tool',
  ]) {
    const f = fixture();
    f.responses.set(codexUrl, { status: 302, headers: { location }, body: Buffer.alloc(0) });
    assert.equal((await port().readReleaseOrigin(f.input)).ok, false, location);
    assert.ok(!f.requests.includes(location));
  }
  const malformed = fixture();
  malformed.responses.set(runsUrl, { status: 200, headers: {}, body: Buffer.from('{') });
  assert.equal((await port().readReleaseOrigin(malformed.input)).ok, false);
  const refused = fixture();
  refused.input.verifyBase = async () => false;
  assert.equal((await port().readReleaseOrigin(refused.input)).ok, false);
});
