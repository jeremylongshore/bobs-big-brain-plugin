/** Private real-store source tests; not a packaged-runtime or live-corpus proof. */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  existsSync,
  chmodSync,
  appendFileSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase, MemoryRepository } from "@qmd-team-intent-kb/store";
import { makeMemory } from "../../bobs-big-brain-registrar/packages/test-fixtures/dist/index.js";
import {
  formatMemoryAsMarkdown,
  getRelativePath,
} from "@qmd-team-intent-kb/git-exporter";
import { reconcileRecoveryExport } from "../src/recovery-export.ts";

if (!process.env.RECOVERY_FIXTURE_PROOF)
  throw new Error("Explicit private fixture proof required");
const proof = process.env.RECOVERY_FIXTURE_PROOF;
const work = mkdtempSync(join(tmpdir(), "bbb-recovery-export-"));
appendFileSync(proof, JSON.stringify({ phase: "created", root: work }) + "\n");
after(() => {
  rmSync(work, { recursive: true, force: true });
  appendFileSync(
    proof,
    JSON.stringify({
      phase: "cleaned",
      root: work,
      removed: !existsSync(work),
    }) + "\n",
  );
});
const tenant = "source-fixture";
function fixture() {
  const root = mkdtempSync(join(work, "case-"));
  const exportDir = join(root, "export");
  mkdirSync(exportDir, { mode: 0o700 });
  const db = createDatabase({ path: join(root, "teamkb.db") });
  const memories = new MemoryRepository(db);
  return {
    root,
    exportDir,
    db,
    memories,
    binding: { tenantId: tenant, exportDir },
  };
}
function put(exportDir, memory) {
  const path = join(exportDir, getRelativePath(memory));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, formatMemoryAsMarkdown(memory));
  return path;
}

test("reconciles source archival and target admission into separate canonical roots, then replays without file changes", () => {
  const f = fixture();
  try {
    const source = makeMemory({ tenantId: tenant, lifecycle: "archived" });
    const target = makeMemory({ tenantId: "target-fixture" });
    f.memories.insert(source);
    f.memories.insert(target);
    const old = put(f.exportDir, { ...source, lifecycle: "active" });
    const targetRoot = join(f.root, "target");
    mkdirSync(targetRoot, { mode: 0o700 });
    let checks = 0;
    const first = reconcileRecoveryExport(f.db, f.binding, () => {
      checks++;
    });
    assert.equal(first.complete, true);
    assert.equal(first.verifiedDocuments, 1);
    assert.equal(first.archived, 1);
    assert.equal(existsSync(old), false);
    const second = reconcileRecoveryExport(
      f.db,
      { tenantId: target.tenantId, exportDir: targetRoot },
      () => {},
    );
    assert.equal(second.complete, true);
    assert.equal(second.verifiedDocuments, 1);
    assert.equal(
      readFileSync(join(targetRoot, getRelativePath(target)), "utf8"),
      formatMemoryAsMarkdown(target),
    );
    const replay = reconcileRecoveryExport(f.db, f.binding, () => {});
    assert.deepEqual(
      [replay.written, replay.archived, replay.removed, replay.unchanged],
      [0, 0, 0, 1],
    );
    assert.equal(checks, 3);
  } finally {
    f.db.close();
  }
});

test("refuses a mixed tenant tree before export or state-cursor writes", () => {
  const f = fixture();
  try {
    const foreign = makeMemory({ tenantId: "foreign-fixture" });
    const path = put(f.exportDir, foreign);
    const bytes = readFileSync(path);
    assert.throws(
      () => reconcileRecoveryExport(f.db, f.binding, () => {}),
      /tenant-exclusive/,
    );
    assert.deepEqual(readFileSync(path), bytes);
    assert.equal(
      f.db.prepare("SELECT COUNT(*) AS n FROM export_state").get().n,
      0,
    );
  } finally {
    f.db.close();
  }
});

test("does not follow directory or file links and preserves outside bytes", () => {
  for (const kind of ["directory", "file"]) {
    const f = fixture();
    try {
      const outside = join(f.root, "outside");
      mkdirSync(outside);
      const memory = makeMemory({ tenantId: tenant });
      const path = put(outside, memory);
      const bytes = readFileSync(path);
      const directory = getRelativePath(memory).split("/")[0];
      if (kind === "directory")
        symlinkSync(join(outside, directory), join(f.exportDir, directory));
      else {
        mkdirSync(join(f.exportDir, directory));
        symlinkSync(path, join(f.exportDir, getRelativePath(memory)));
      }
      assert.throws(() => reconcileRecoveryExport(f.db, f.binding, () => {}));
      assert.deepEqual(readFileSync(path), bytes);
    } finally {
      f.db.close();
    }
  }
});

test("removes restricted stale files while preserving the canonical restricted database row", () => {
  const f = fixture();
  try {
    const memory = makeMemory({
      tenantId: tenant,
      sensitivity: "confidential",
    });
    f.memories.insert(memory);
    const path = put(f.exportDir, memory);
    const result = reconcileRecoveryExport(f.db, f.binding, () => {});
    assert.equal(result.complete, true);
    assert.equal(result.removed, 1);
    assert.equal(existsSync(path), false);
    assert.deepEqual(f.memories.findById(memory.id), {
      ...memory,
      supersession: undefined,
    });
  } finally {
    f.db.close();
  }
});

test("orphan removal guard remains incomplete without deleting files", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 51; i++)
      put(f.exportDir, makeMemory({ tenantId: tenant, id: randomUUID() }));
    const result = reconcileRecoveryExport(f.db, f.binding, () => {});
    assert.equal(result.complete, false);
    assert.equal(result.removalBlocked, true);
    assert.equal(result.removed, 0);
  } finally {
    f.db.close();
  }
});

test("a source failing domain validation cannot certify completion", () => {
  const f = fixture();
  try {
    const memory = makeMemory({ tenantId: tenant });
    f.memories.insert(memory);
    f.db
      .prepare("UPDATE curated_memories SET author_json = ? WHERE id = ?")
      .run("{}", memory.id);
    const result = reconcileRecoveryExport(f.db, f.binding, () => {});
    assert.equal(result.complete, false);
    assert.equal(result.quarantined, 1);
  } finally {
    f.db.close();
  }
});

test("refuses a root with changed permissions during post-export verification", () => {
  const f = fixture();
  try {
    let calls = 0;
    assert.throws(
      () =>
        reconcileRecoveryExport(f.db, f.binding, () => {
          if (++calls === 2) chmodSync(f.exportDir, 0o755);
        }),
      /owner-private/,
    );
  } finally {
    f.db.close();
  }
});

test("detects physical root replacement after export even when bytes and permissions match", () => {
  const f = fixture();
  try {
    let calls = 0;
    assert.throws(
      () =>
        reconcileRecoveryExport(f.db, f.binding, () => {
          if (++calls === 2) {
            renameSync(f.exportDir, f.exportDir + "-moved");
            mkdirSync(f.exportDir, { mode: 0o700 });
          }
        }),
      /root changed/,
    );
  } finally {
    f.db.close();
  }
});

test("detects changed document bytes after reconciliation", () => {
  const f = fixture();
  try {
    const memory = makeMemory({ tenantId: tenant });
    f.memories.insert(memory);
    let calls = 0;
    assert.throws(
      () =>
        reconcileRecoveryExport(f.db, f.binding, () => {
          if (++calls === 2)
            appendFileSync(
              join(f.exportDir, getRelativePath(memory)),
              "unexpected fixture mutation",
            );
        }),
      /canonical tenant rendering/,
    );
  } finally {
    f.db.close();
  }
});
