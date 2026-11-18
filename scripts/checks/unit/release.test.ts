const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { test }: typeof import("node:test") = require("node:test");

function releaseFixture() {
  const commitSha = "a".repeat(40);
  const version = "1.2.0";
  const tagName = `v${version}`;
  const repository = "fixture-owner/fixture-release";
  const workflowId = 54321;
  const codexArchiveUrlPrefix = "https://example.invalid/codex/releases/download/";
  const workflowPath = ".github/workflows/release.yml";
  const workflowBlob = "b".repeat(40);
  const pinnedCheckBlobs = {
    [workflowPath]: workflowBlob,
    "package.json": "c".repeat(40),
    "package-lock.json": "d".repeat(40),
  };
  const nodeSha256 = "e".repeat(64);
  const codexSha256 = "f".repeat(64);
  const playwrightVersion = "1.64.2";
  const playwrightIntegrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
  const treeBlobs = {
    ...pinnedCheckBlobs,
    "README.md": "1".repeat(40),
    "base/launcher.ts": "2".repeat(40),
    "core/main.ts": "3".repeat(40),
    "executor/share/AGENTS.md": "4".repeat(40),
    "release/manifest.json": "5".repeat(40),
    "release/notes.en.md": "6".repeat(40),
  };
  const trustedPolicy = {
    installedVersion: "1.1.9",
    repository,
    workflowId,
    codexArchiveUrlPrefix,
    allowedRootFiles: ["README.md", "package.json", "package-lock.json"],
    allowedDirectories: [".github", "base", "core", "executor", "release"],
    pinnedCheckBlobs,
  };
  const candidate = {
    tag: { name: tagName, sha: commitSha },
    manifest: {
      schema: "foliome-release/1",
      version,
      node: { version: "26.13.2", sha256: nodeSha256 },
      codex: {
        version: "0.167.1",
        sha256: codexSha256,
        url: `${codexArchiveUrlPrefix}v0.167.1/fixture.tar.gz`,
      },
      playwrightCore: { version: playwrightVersion, integrity: playwrightIntegrity },
      securityFix: null,
      securityNarrowing: null,
      rootChange: false,
      baseChange: false,
      notesRu: "Синтетический выпуск",
    },
    run: {
      head_sha: commitSha,
      event: "push",
      head_branch: tagName,
      head_repository: { full_name: repository },
      workflow_id: workflowId,
      conclusion: "success",
    },
    // The caller assembles these observations from trusted adapters for this commit.
    evidence: {
      commitSha,
      tree: Object.entries(treeBlobs).map(([path, blobSha]) => ({ path, blobSha, mode: "100644" })),
      runtimeDependencies: [
        {
          name: "playwright-core",
          version: playwrightVersion,
          integrity: playwrightIntegrity,
          hasInstallScript: false,
          publishedAgeDays: 30,
        },
      ],
      // The digest identifies the artifact on which the adapter checked the signature.
      signatures: {
        node: { status: "verified", sha256: nodeSha256 },
        codex: { status: "verified", sha256: codexSha256 },
        playwrightCore: { status: "verified", integrity: playwrightIntegrity },
      },
    },
  };
  return { candidate, trustedPolicy };
}

test("принимает состав выпуска и закреплённые проверки и отклоняет лишние компоненты", async () => {
  const { validateReleaseCandidate } = await import("../../../core/domain/release.ts");
  const { candidate, trustedPolicy } = releaseFixture();
  const accepted = validateReleaseCandidate(candidate, trustedPolicy);
  assert.ok(accepted.ok);
  assert.equal(accepted.checks, "pinned");

  const policyWithDifferentPin = {
    ...trustedPolicy,
    pinnedCheckBlobs: { ...trustedPolicy.pinnedCheckBlobs, "package.json": "7".repeat(40) },
  };
  const changed = validateReleaseCandidate(candidate, policyWithDifferentPin);
  assert.ok(changed.ok);
  assert.equal(changed.checks, "changed");

  for (const path of ["extra.config", "docs/guide.md", "data/sample.json", "versions/sample.ts"]) {
    const extraEntry = { path, blobSha: "8".repeat(40), mode: "100644" };
    const evidence = { ...candidate.evidence, tree: [...candidate.evidence.tree, extraEntry] };
    assert.deepEqual(
      validateReleaseCandidate({ ...candidate, evidence }, trustedPolicy),
      { ok: false, code: "tree" },
      path,
    );
  }
});

test("отклоняет релиз при несовпадении тега прогона дерева зависимости или подписи", async () => {
  const { validateReleaseCandidate } = await import("../../../core/domain/release.ts");
  const { candidate, trustedPolicy } = releaseFixture();
  const { tag, run, evidence } = candidate;
  const { tree, runtimeDependencies, signatures } = evidence;
  const [playwright] = runtimeDependencies;
  assert.ok(playwright);

  const otherSha = "9".repeat(40);
  const otherTag = "v1.2.1";
  const installedTag = `v${trustedPolicy.installedVersion}`;
  const otherIntegrity = `sha512-${Buffer.alloc(64, 2).toString("base64")}`;
  const cases = [
    {
      label: "версия манифеста не соответствует тегу",
      value: { ...candidate, tag: { ...tag, name: otherTag }, run: { ...run, head_branch: otherTag } },
      code: "tag",
    },
    {
      label: "версия выпуска равна установленной",
      value: {
        ...candidate,
        manifest: { ...candidate.manifest, version: trustedPolicy.installedVersion },
        tag: { ...tag, name: installedTag },
        run: { ...run, head_branch: installedTag },
      },
      code: "tag",
    },
    {
      label: "SHA прогона отличается от SHA тега",
      value: { ...candidate, run: { ...run, head_sha: otherSha } },
      code: "workflow",
    },
    {
      label: "другой workflow",
      value: { ...candidate, run: { ...run, workflow_id: run.workflow_id + 1 } },
      code: "workflow",
    },
    {
      label: "прогон запущен вручную",
      value: { ...candidate, run: { ...run, event: "workflow_dispatch" } },
      code: "workflow",
    },
    {
      label: "ветка прогона отличается от тега",
      value: { ...candidate, run: { ...run, head_branch: otherTag } },
      code: "workflow",
    },
    {
      label: "прогон другого репозитория",
      value: { ...candidate, run: { ...run, head_repository: { full_name: "fixture-owner/other" } } },
      code: "workflow",
    },
    {
      label: "неуспешный прогон",
      value: { ...candidate, run: { ...run, conclusion: "failure" } },
      code: "workflow",
    },
    {
      label: "свидетельство дерева для другого SHA",
      value: { ...candidate, evidence: { ...evidence, commitSha: otherSha } },
      code: "tree",
    },
    {
      label: "в дереве нет манифеста выпуска",
      value: {
        ...candidate,
        evidence: { ...evidence, tree: tree.filter(({ path }) => path !== "release/manifest.json") },
      },
      code: "tree",
    },
    {
      label: "файл дерева с недопустимым режимом",
      value: {
        ...candidate,
        evidence: {
          ...evidence,
          tree: tree.map((entry) =>
            entry.path === "README.md" ? { ...entry, mode: "100640" } : entry,
          ),
        },
      },
      code: "tree",
    },
    {
      label: "лишняя зависимость",
      value: {
        ...candidate,
        evidence: {
          ...evidence,
          runtimeDependencies: [...runtimeDependencies, { ...playwright, name: "fixture-helper" }],
        },
      },
      code: "dependency",
    },
    {
      label: "integrity зависимости отличается от манифеста",
      value: {
        ...candidate,
        evidence: {
          ...evidence,
          runtimeDependencies: [{ ...playwright, integrity: otherIntegrity }],
        },
      },
      code: "dependency",
    },
    {
      label: "версия зависимости отличается от версии манифеста",
      value: {
        ...candidate,
        evidence: { ...evidence, runtimeDependencies: [{ ...playwright, version: "1.64.1" }] },
      },
      code: "dependency",
    },
    {
      label: "у зависимости есть скрипт установки",
      value: {
        ...candidate,
        evidence: { ...evidence, runtimeDependencies: [{ ...playwright, hasInstallScript: true }] },
      },
      code: "dependency",
    },
    {
      label: "выпуск зависимости моложе 30 дней",
      value: {
        ...candidate,
        evidence: { ...evidence, runtimeDependencies: [{ ...playwright, publishedAgeDays: 29 }] },
      },
      code: "dependency",
    },
    {
      label: "адаптер не подтвердил подпись Node",
      value: {
        ...candidate,
        evidence: {
          ...evidence,
          signatures: { ...signatures, node: { ...signatures.node, status: "failed" } },
        },
      },
      code: "signature",
    },
    {
      label: "подпись Codex проверена для другого архива",
      value: {
        ...candidate,
        evidence: {
          ...evidence,
          signatures: { ...signatures, codex: { ...signatures.codex, sha256: "9".repeat(64) } },
        },
      },
      code: "signature",
    },
    {
      label: "отсутствует свидетельство подписи зависимости",
      value: {
        ...candidate,
        evidence: { ...evidence, signatures: { node: signatures.node, codex: signatures.codex } },
      },
      code: "signature",
    },
  ];
  for (const { label, value, code } of cases) {
    assert.deepEqual(validateReleaseCandidate(value, trustedPolicy), { ok: false, code }, label);
  }
});
