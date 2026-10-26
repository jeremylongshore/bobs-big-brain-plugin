/** Source-bound private integration of the real lock, kernel, Git and owned qmd. */
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  createDatabase,
  openExistingDatabase,
  MemoryRepository,
  CandidateRepository,
  PolicyRepository,
  AuditRepository,
  appendAnchor,
  computeEntryHash,
  computeManifestHash,
} from "@qmd-team-intent-kb/store";
import {
  runRecoveryCommand,
  memorySnapshotDigest,
  placeHold,
} from "@qmd-team-intent-kb/curator";
import {
  getExportableCollections,
  getQmdTenantIndexPath,
  inspectRecoveryQmdRegistry,
} from "@qmd-team-intent-kb/qmd-adapter";
import {
  makeMemory,
  makeCandidate,
  makePolicy,
  makeAuditEvent,
} from "../../bobs-big-brain-registrar/packages/test-fixtures/dist/index.js";
import { verifyRuntime } from "../../bobs-big-brain-registrar/packages/qmd-runtime/lib/runtime-inventory.mjs";
import { createRequire } from "node:module";
const { executeRecoveryMaintenance } = process.env.RECOVERY_HELPER_BUNDLE
  ? createRequire(import.meta.url)(process.env.RECOVERY_HELPER_BUNDLE)
  : await import("../src/recovery-maintenance.ts");

import {
  formatMemoryAsMarkdown,
  getRelativePath,
} from "@qmd-team-intent-kb/git-exporter";

const runtimeRoot = process.env.RECOVERY_OWNED_RUNTIME_ROOT;
const manifestSha256 = process.env.RECOVERY_OWNED_RUNTIME_SHA256;
const proof = process.env.RECOVERY_FIXTURE_PROOF;
if (!runtimeRoot || !manifestSha256 || !proof)
  throw new Error("Explicit private owned-runtime fixture required");
const hash = (v) => createHash("sha256").update(v).digest("hex");
assert.equal(
  hash(readFileSync(join(runtimeRoot, "runtime-manifest.json"))),
  manifestSha256,
);
const runtimeBefore = verifyRuntime(runtimeRoot);
const work = mkdtempSync(join(tmpdir(), "bbb-recovery-maintenance-"));
appendFileSync(proof, JSON.stringify({ phase: "created", root: work }) + "\n");
after(() => {
  try {
    assert.deepEqual(
      verifyRuntime(runtimeRoot).manifest.inventory,
      runtimeBefore.manifest.inventory,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
    appendFileSync(
      proof,
      JSON.stringify({
        phase: "cleaned",
        root: work,
        removed: !existsSync(work),
      }) + "\n",
    );
  }
});
const sourceTenant = "source-fixture";
const targetTenant = "target-fixture";
function fixture() {
  const root = mkdtempSync(join(work, "case-"));
  const base = join(root, "brain");
  mkdirSync(base, { mode: 0o700 });
  const databasePath = join(base, "teamkb.db");
  const db = createDatabase({ path: databasePath });
  const memories = new MemoryRepository(db);
  const source = makeMemory({
    tenantId: sourceTenant,
    source: "import",
    title: "Synthetic heliotrope procedure",
    content:
      "The heliotrope private procedure uses explicit orchard review before every change.",
    metadata: {
      filePaths: ["orchard.md"],
      tags: ["fixture"],
      audience: "tenant",
    },
  });
  const excluded = makeMemory({
    tenantId: sourceTenant,
    title: "Excluded tidal procedure",
    content:
      "Retain the tidal private procedure in its existing source tenant.",
  });
  memories.insert(source);
  memories.insert(excluded);
  const queued = makeCandidate({
    tenantId: targetTenant,
    content: "The unrelated pending saffron candidate remains in the inbox.",
  });
  new CandidateRepository(db).insert(queued, hash(queued.content));
  new PolicyRepository(db).insert(
    makePolicy({
      tenantId: targetTenant,
      name: "Private fixture governance policy",
    }),
  );
  const held = makeCandidate({
    tenantId: targetTenant,
    content:
      "Unrelated quarantined fixture awaits a person and must remain held.",
  });
  const candidates = new CandidateRepository(db);
  candidates.insert(held, hash(held.content));
  const hold = placeHold(
    held,
    {
      triggers: ["sensitivity_gate_flag"],
      basis: "pii",
      recommendedAudience: "admins",
      declaredAudience: "tenant",
      triggerRuleIds: ["fixture-rule"],
      matchedPatterns: [],
      otherFlags: [],
    },
    {
      candidateRepo: candidates,
      auditRepo: new AuditRepository(db),
      memoryRepo: memories,
      policyRepo: new PolicyRepository(db),
    },
    { now: "2026-10-26T07:30:00.000Z" },
  );
  assert.equal(hold.status, "held");
  const spool = join(base, "spool");
  mkdirSync(spool, { mode: 0o700 });
  writeFileSync(
    join(spool, "unrelated.jsonl"),
    "private unrelated spool sentinel\n",
    { mode: 0o600 },
  );
  db.close();
  const requestPath = join(root, "request.json"),
    planPath = join(root, "plan.json"),
    key = join(root, "origin.key");
  writeFileSync(
    requestPath,
    JSON.stringify({
      runId: randomUUID(),
      createdAt: "2026-10-26T07:30:00.000Z",
      storeLocator: databasePath,
      sourceTenantId: sourceTenant,
      targetTenantId: targetTenant,
      selections: [
        { id: source.id, snapshotDigest: memorySnapshotDigest(source) },
      ],
      exclusions: [
        { id: excluded.id, snapshotDigest: memorySnapshotDigest(excluded) },
      ],
      actor: { type: "human", id: "private-fixture-operator" },
      role: "owner",
      reason: "Verify bounded private recovery integration.",
    }),
    { mode: 0o600 },
  );
  writeFileSync(key, "private-fixture-origin", { mode: 0o600 });
  let plan;
  assert.equal(
    runRecoveryCommand(
      [
        "plan",
        "--request",
        requestPath,
        "--out",
        planPath,
        "--origin-secret-file",
        key,
        "--origin-channel",
        "local-mcp",
      ],
      {
        output(value) {
          plan = value;
        },
      },
    ),
    0,
  );
  const request = {
    operation: "apply",
    planPath,
    expectedDigest: plan.reviewedDigest,
    originSecretFile: key,
  };
  const options = {
    sourceExportDir: join(root, "source-export"),
    targetExportDir: join(root, "target-export"),
    qmdRuntime: { root: runtimeRoot, manifestSha256 },
  };
  for (const exportDir of [options.sourceExportDir, options.targetExportDir]) {
    mkdirSync(exportDir, { mode: 0o700 });
    for (const d of getExportableCollections())
      mkdirSync(join(exportDir, d.sourceSubdir));
  }
  for (const tenant of [sourceTenant, targetTenant])
    mkdirSync(getQmdTenantIndexPath(tenant, base), {
      recursive: true,
      mode: 0o700,
    });
  return {
    root,
    base,
    databasePath,
    source,
    excluded,
    queued,
    held,
    request,
    options,
  };
}
function snapshot(f) {
  const db = openExistingDatabase({ path: f.databasePath, readonly: true });
  try {
    return Object.fromEntries(
      [
        "candidates",
        "curated_memories",
        "audit_events",
        "memory_links",
        "governance_policies",
      ].map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  } finally {
    db.close();
  }
}
const WATCHER = `import fcntl,json,os,sys,time
base,source,target,log,ready,stop=sys.argv[1:]
fd=os.open(os.path.join(base,'.write.lock'),os.O_RDWR|os.O_CREAT,0o600)
open(ready,'x').close()
seen=set()
try:
 while not os.path.exists(stop):
  try:
   fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);fcntl.flock(fd,fcntl.LOCK_UN);held=False
  except BlockingIOError:held=True
  phases={'anchor':os.path.exists(os.path.join(base,'audit','anchors.jsonl')),'source-export':len(os.listdir(os.path.join(source,'archive')))>0,'target-export':len(os.listdir(os.path.join(target,'curated')))>0,'source-index':os.path.exists(os.path.join(base,'qmd-index','source-fixture','cache','qmd','index.sqlite')),'target-index':os.path.exists(os.path.join(base,'qmd-index','target-fixture','cache','qmd','index.sqlite'))}
  for phase,present in phases.items():
   if held and present and phase not in seen:
    with open(log,'a') as out:out.write(json.dumps({'phase':phase,'kernelLockHeld':True})+'\\n')
    seen.add(phase)
  time.sleep(.005)
finally:os.close(fd)
`;
async function watch(f) {
  const log = join(f.root, "contention.jsonl"),
    ready = join(f.root, "ready"),
    stop = join(f.root, "stop");
  const child = spawn(
    "/usr/bin/python3",
    [
      "-u",
      "-c",
      WATCHER,
      f.base,
      f.options.sourceExportDir,
      f.options.targetExportDir,
      log,
      ready,
      stop,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let error = "";
  child.stderr.on("data", (v) => {
    error += v;
  });
  const exited = once(child, "exit");
  for (let i = 0; i < 100 && !existsSync(ready); i++) await delay(10);
  assert.equal(existsSync(ready), true);
  return async () => {
    writeFileSync(stop, "done");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    try {
      const [code] = await exited;
      assert.equal(code, 0, error);
    } finally {
      clearTimeout(timer);
    }
    return existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse)
      : [];
  };
}
function unlocked(f) {
  return (
    spawnSync(
      "/usr/bin/flock",
      ["--nonblock", join(f.base, ".write.lock"), "/usr/bin/true"],
      { timeout: 1000 },
    ).status === 0
  );
}

test(
  "fixed recovery holds the kernel lock through both actual tenant indexes and explicit repair adds no governance receipts",
  { timeout: 240000 },
  async () => {
    const f = fixture();
    const spoolPath = join(f.base, "spool", "unrelated.jsonl");
    const spoolBefore = lstatSync(spoolPath);
    const before = snapshot(f);
    const stop = await watch(f);
    let result, observations;
    try {
      result = await executeRecoveryMaintenance(f.request, f.options);
    } finally {
      observations = await stop();
    }
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.committed, true);
    assert.equal(result.recoveryComplete, true);
    assert.equal(result.status.state, "complete");
    assert.equal(result.postcommit.value.anchor.localWitnessVerified, true);
    assert.deepEqual(
      result.postcommit.value.tenants.map((v) => [
        v.tenantId,
        v.index.indexVerified,
      ]),
      [
        [sourceTenant, true],
        [targetTenant, true],
      ],
    );
    assert.deepEqual(
      observations.map((v) => v.phase).sort(),
      [
        "anchor",
        "source-export",
        "source-index",
        "target-export",
        "target-index",
      ].sort(),
    );
    assert.equal(unlocked(f), true);
    const afterApply = snapshot(f);
    const spoolAfter = lstatSync(spoolPath);
    assert.deepEqual(
      [
        spoolAfter.dev,
        spoolAfter.ino,
        spoolAfter.mode,
        spoolAfter.mtimeMs,
        spoolAfter.size,
      ],
      [
        spoolBefore.dev,
        spoolBefore.ino,
        spoolBefore.mode,
        spoolBefore.mtimeMs,
        spoolBefore.size,
      ],
    );
    assert.deepEqual(
      afterApply.governance_policies,
      before.governance_policies,
    );
    assert.deepEqual(
      afterApply.candidates.find((v) => v.id === f.queued.id),
      before.candidates.find((v) => v.id === f.queued.id),
    );
    assert.deepEqual(
      afterApply.curated_memories.find((v) => v.id === f.excluded.id),
      before.curated_memories.find((v) => v.id === f.excluded.id),
    );
    assert.deepEqual(
      afterApply.candidates.find((v) => v.id === f.held.id),
      before.candidates.find((v) => v.id === f.held.id),
    );
    assert.deepEqual(
      afterApply.audit_events.filter((v) => v.action === "held"),
      before.audit_events.filter((v) => v.action === "held"),
    );
    assert.equal(
      readFileSync(join(f.base, "spool", "unrelated.jsonl"), "utf8"),
      "private unrelated spool sentinel\n",
    );
    const anchorBytes = readFileSync(join(f.base, "audit", "anchors.jsonl"));
    const replay = await executeRecoveryMaintenance(f.request, f.options);
    assert.equal(replay.ok, true);
    assert.equal(replay.recoveryComplete, false);
    assert.equal(replay.postcommit.state, "skipped_replay");
    assert.deepEqual(snapshot(f), afterApply);
    const repair = await executeRecoveryMaintenance(
      {
        operation: "repair",
        planPath: f.request.planPath,
        expectedDigest: f.request.expectedDigest,
      },
      f.options,
    );
    assert.equal(repair.ok, true, JSON.stringify(repair));
    assert.equal(repair.recoveryComplete, true);
    assert.equal(repair.appliedNow, false);
    assert.deepEqual(snapshot(f), afterApply);
    assert.deepEqual(
      readFileSync(join(f.base, "audit", "anchors.jsonl")),
      anchorBytes,
    );
    assert.equal(
      repair.postcommit.value.anchor.gitHead,
      result.postcommit.value.anchor.gitHead,
    );
    assert.equal(unlocked(f), true);
    assert.equal(
      JSON.stringify(result).includes("private-fixture-origin"),
      false,
    );
    if (process.env.RECOVERY_CLI_PATH) {
      const cli = spawnSync(
        process.execPath,
        [
          process.env.RECOVERY_CLI_PATH,
          "repair",
          "--plan",
          f.request.planPath,
          "--digest",
          f.request.expectedDigest,
          "--source-export",
          f.options.sourceExportDir,
          "--target-export",
          f.options.targetExportDir,
          "--qmd-root",
          runtimeRoot,
          "--qmd-sha256",
          manifestSha256,
        ],
        {
          env: {
            ...process.env,
            ...(process.env.RECOVERY_CLI_NODE_OPTIONS
              ? { NODE_OPTIONS: process.env.RECOVERY_CLI_NODE_OPTIONS }
              : {}),
          },
          encoding: "utf8",
          timeout: 90000,
          maxBuffer: 128 * 1024,
        },
      );
      assert.equal(cli.error, undefined);
      assert.equal(cli.status, 0, cli.stderr + cli.stdout);
      const output = JSON.parse(cli.stdout);
      assert.equal(output.recoveryComplete, true);
      assert.equal(output.appliedNow, false);
      assert.equal(output.postcommit.localWitnessVerified, true);
      assert.equal(
        output.postcommit.gitHead,
        result.postcommit.value.anchor.gitHead,
      );
      assert.equal(cli.stdout.includes("private-fixture-origin"), false);
      assert.equal(cli.stdout.includes("heliotrope private"), false);
      assert.equal(cli.stdout.includes(runtimeRoot), false);
      assert.deepEqual(snapshot(f), afterApply);
      assert.equal(unlocked(f), true);
    }
  },
);

test(
  "postcommit obstruction preserves committed truth and repair never repeats governance",
  { timeout: 240000 },
  async () => {
    const f = fixture();
    const outside = join(f.root, "outside");
    mkdirSync(outside, { mode: 0o700 });
    writeFileSync(
      join(f.options.targetExportDir, "unknown-entry"),
      "preserve obstruction",
    );
    const failed = await executeRecoveryMaintenance(f.request, f.options);
    assert.equal(failed.ok, false);
    assert.equal(failed.committed, true);
    assert.equal(failed.failedStage, "postcommit");
    assert.equal(failed.recoveryComplete, false);
    assert.equal(unlocked(f), true);
    const settled = snapshot(f);
    rmSync(join(f.options.targetExportDir, "unknown-entry"));
    const repaired = await executeRecoveryMaintenance(
      {
        operation: "repair",
        planPath: f.request.planPath,
        expectedDigest: f.request.expectedDigest,
      },
      f.options,
    );
    assert.equal(repaired.ok, true, JSON.stringify(repaired));
    assert.equal(repaired.recoveryComplete, true);
    assert.deepEqual(snapshot(f), settled);
    assert.equal(unlocked(f), true);
  },
);

test(
  "partial governance settlement stays incomplete after successful actual maintenance",
  { timeout: 240000 },
  async () => {
    const f = fixture();
    const wrongKey = join(f.root, "wrong.key");
    writeFileSync(wrongKey, "wrong-private-fixture-origin", { mode: 0o600 });
    const result = await executeRecoveryMaintenance(
      { ...f.request, originSecretFile: wrongKey },
      f.options,
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.committed, true);
    assert.equal(result.status.state, "partial");
    assert.equal(result.recoveryComplete, false);
    assert.equal(result.postcommit.value.complete, false);
    assert.equal(result.status.entries[0].archived, false);
    assert.equal(unlocked(f), true);
  },
);

test(
  "orphan mass-removal guard preserves files and cannot certify recovery completion",
  { timeout: 30000 },
  async () => {
    const f = fixture();
    const orphans = [];
    for (let i = 0; i < 51; i++) {
      const memory = makeMemory({ tenantId: sourceTenant });
      const path = join(f.options.sourceExportDir, getRelativePath(memory));
      const content = formatMemoryAsMarkdown(memory);
      writeFileSync(path, content, { mode: 0o600 });
      orphans.push([path, content]);
    }
    const result = await executeRecoveryMaintenance(f.request, f.options);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.committed, true);
    assert.equal(result.status.state, "complete");
    assert.equal(result.recoveryComplete, false);
    assert.equal(
      result.postcommit.value.tenants[0].export.removalBlocked,
      true,
    );
    assert.equal(result.postcommit.value.tenants[0].index, undefined);
    for (const [path, content] of orphans)
      assert.equal(readFileSync(path, "utf8"), content);
    assert.equal(unlocked(f), true);
  },
);

function completeFilesystem(root) {
  const rows = [];
  function walk(path) {
    const s = lstatSync(path),
      relative = path.slice(root.length);
    const type = s.isSymbolicLink()
      ? "link"
      : s.isDirectory()
        ? "directory"
        : s.isFile()
          ? "file"
          : "special";
    rows.push({
      path: relative,
      type,
      inode: s.ino,
      device: s.dev,
      mode: s.mode,
      uid: s.uid,
      links: s.nlink,
      bytes: s.size,
      mtime: s.mtimeMs,
      ctime: s.ctimeMs,
      ...(type === "file" ? { sha256: hash(readFileSync(path)) } : {}),
      ...(type === "link" ? { target: readlinkSync(path) } : {}),
    });
    if (type === "directory")
      for (const name of readdirSync(path).sort()) walk(join(path, name));
  }
  walk(root);
  return rows;
}
for (const kind of ["fork", "anchor-mismatch", "manifest-pin"])
  test(
    `fixed readiness refuses ${kind} before any database or maintenance mutation`,
    { timeout: 10000 },
    async () => {
      const f = fixture();
      const db = openExistingDatabase({
        path: f.databasePath,
        readonly: false,
      });
      try {
        db.pragma("journal_mode = DELETE");
        const audit = new AuditRepository(db);
        if (kind === "fork") {
          audit.insert(makeAuditEvent({ tenantId: targetTenant }));
          const event = makeAuditEvent({ tenantId: targetTenant });
          audit.insert(event);
          const first = db
            .prepare("SELECT entry_hash FROM audit_events ORDER BY seq LIMIT 1")
            .get();
          const row = db
            .prepare("SELECT * FROM audit_events WHERE id=?")
            .get(event.id);
          const changed = { ...row, prev_entry_hash: first.entry_hash };
          db.prepare(
            "UPDATE audit_events SET prev_entry_hash=?,entry_hash=? WHERE id=?",
          ).run(
            first.entry_hash,
            computeEntryHash(changed, row.hash_version ?? 1),
            event.id,
          );
        }
        if (kind === "anchor-mismatch") {
          const directory = join(f.base, "audit"),
            path = join(directory, "anchors.jsonl");
          mkdirSync(directory, { mode: 0o700 });
          writeFileSync(path, "", { mode: 0o600 });
          appendAnchor(audit, path, { tenantId: targetTenant });
          const record = JSON.parse(readFileSync(path, "utf8").trim());
          record.chainHead = "forged";
          writeFileSync(path, JSON.stringify(record) + "\n");
        }
        if (kind === "manifest-pin") {
          const body = {
            schemaVersion: 1,
            brainId: "private-fixture",
            generatedAt: "2026-10-26T00:00:00.000Z",
            entryCount: 0,
            entries: [],
          };
          const path = join(f.root, "exceptions.json");
          writeFileSync(
            path,
            JSON.stringify({
              ...body,
              manifestHash: computeManifestHash(body),
            }),
            { mode: 0o600 },
          );
          f.options.exceptionManifest = {
            path,
            expectedManifestHash: "0".repeat(64),
          };
        }
      } finally {
        db.close();
      }
      writeFileSync(join(f.base, ".write.lock"), "", { mode: 0o600 });
      const before = snapshot(f),
        files = completeFilesystem(f.root);
      const result = await executeRecoveryMaintenance(f.request, f.options);
      assert.deepEqual(
        {
          ok: result.ok,
          committed: result.committed,
          appliedNow: result.appliedNow,
          stage: result.failedStage,
          postcommit: result.postcommit,
          recoveryComplete: result.recoveryComplete,
        },
        {
          ok: false,
          committed: false,
          appliedNow: false,
          stage: "preflight",
          postcommit: { state: "not_run" },
          recoveryComplete: false,
        },
      );
      assert.deepEqual(snapshot(f), before);
      assert.deepEqual(completeFilesystem(f.root), files);
      assert.equal(unlocked(f), true);
    },
  );
