/** Explicit private real owned-qmd lane; never selects a live brain or global binary. */
import assert from "node:assert/strict";
import { test, after } from "node:test";
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createDatabase, MemoryRepository } from "@qmd-team-intent-kb/store";
import {
  getExportableCollections,
  getQmdTenantIndexPath,
  inspectRecoveryQmdRegistry,
} from "@qmd-team-intent-kb/qmd-adapter";
import { makeMemory } from "../../bobs-big-brain-registrar/packages/test-fixtures/dist/index.js";
import { verifyRuntime } from "../../bobs-big-brain-registrar/packages/qmd-runtime/lib/runtime-inventory.mjs";
import {
  reconcileRecoveryExport,
  verifyRecoveryExportDocuments,
} from "../src/recovery-export.ts";
import { refreshRecoveryIndex } from "../src/recovery-index.ts";
import { verifyRecoveryIndexDocuments } from "../src/recovery-index-documents.ts";

const runtimeRoot = process.env.RECOVERY_OWNED_RUNTIME_ROOT;
const manifestSha256 = process.env.RECOVERY_OWNED_RUNTIME_SHA256;
const proof = process.env.RECOVERY_FIXTURE_PROOF;
if (!runtimeRoot || !manifestSha256 || !proof)
  throw new Error("Explicit owned runtime and private fixture proof required");
const hash = (v) => createHash("sha256").update(v).digest("hex");
assert.equal(
  hash(readFileSync(join(runtimeRoot, "runtime-manifest.json"))),
  manifestSha256,
);
const initialRuntime = verifyRuntime(runtimeRoot);
const work = mkdtempSync(join(tmpdir(), "bbb-recovery-owned-index-"));
appendFileSync(proof, JSON.stringify({ phase: "created", root: work }) + "\n");
after(() => {
  try {
    assert.deepEqual(
      verifyRuntime(runtimeRoot).manifest.inventory,
      initialRuntime.manifest.inventory,
    );
    assert.equal(
      hash(readFileSync(join(runtimeRoot, "runtime-manifest.json"))),
      manifestSha256,
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

test(
  "real owned qmd verifies every active canonical document for both isolated tenants and refuses foreign retained history",
  { timeout: 240000 },
  async () => {
    const basePath = join(work, "brain");
    mkdirSync(basePath, { mode: 0o700 });
    const db = createDatabase({ path: join(basePath, "teamkb.db") });
    const memories = new MemoryRepository(db);
    let checks = 0;
    const bound = () => {
      checks++;
      assert.equal(existsSync(basePath), true);
    };
    try {
      for (const tenantId of ["source-fixture", "target-fixture"]) {
        const exportDir = join(work, tenantId);
        mkdirSync(exportDir, { mode: 0o700 });
        for (const d of getExportableCollections())
          mkdirSync(join(exportDir, d.sourceSubdir));
        mkdirSync(getQmdTenantIndexPath(tenantId, basePath), {
          recursive: true,
          mode: 0o700,
        });
        const memory = makeMemory({
          tenantId,
          content: `The ${tenantId} saffron procedure includes 中文資料 and explicit bounded recovery evidence.`,
        });
        const archived = makeMemory({
          tenantId,
          lifecycle: "archived",
          category: "decision",
          content: `The ${tenantId} retired heliotrope decision remains available only in its archive.`,
        });
        memories.insert(memory);
        memories.insert(archived);
        const options = {
          tenantId,
          basePath,
          exportDir,
          qmdRuntime: { root: runtimeRoot, manifestSha256 },
        };
        assert.equal(
          reconcileRecoveryExport(db, options, bound).complete,
          true,
        );
        const first = await refreshRecoveryIndex(db, options, bound);
        assert.equal(first.indexVerified, true);
        assert.equal(first.verifiedDocuments, 2);
        assert.equal(first.command.source, "owned");
        const again = await refreshRecoveryIndex(db, options, bound);
        assert.equal(again.verifiedDocuments, 2);
        const registry = inspectRecoveryQmdRegistry(options);
        const expected = verifyRecoveryExportDocuments(db, options, bound);
        const index = new Database(registry.indexPath);
        try {
          const originalTitle = index
            .prepare("SELECT id,title FROM documents WHERE active=1 LIMIT 1")
            .get();
          index
            .prepare("UPDATE documents SET title=? WHERE id=?")
            .run("foreign unrelated title", originalTitle.id);
          index
            .prepare("UPDATE documents_fts SET title=? WHERE rowid=?")
            .run("foreign unrelated title", originalTitle.id);
          assert.throws(
            () =>
              verifyRecoveryIndexDocuments(
                registry.indexPath,
                tenantId,
                expected,
              ),
            /title differs from content/,
          );
          index
            .prepare("UPDATE documents SET title=? WHERE id=?")
            .run(originalTitle.title, originalTitle.id);
          const fts = index
            .prepare("SELECT rowid,body FROM documents_fts LIMIT 1")
            .get();
          index
            .prepare("UPDATE documents_fts SET body=? WHERE rowid=?")
            .run("wrong private projection", fts.rowid);
          assert.throws(
            () =>
              verifyRecoveryIndexDocuments(
                registry.indexPath,
                tenantId,
                expected,
              ),
            /FTS projection/,
          );
          index
            .prepare("UPDATE documents_fts SET body=? WHERE rowid=?")
            .run(fts.body, fts.rowid);
          const active = index
            .prepare("SELECT id FROM documents WHERE active=1 LIMIT 1")
            .get();
          index
            .prepare("UPDATE documents SET active=0 WHERE id=?")
            .run(active.id);
          assert.throws(
            () =>
              verifyRecoveryIndexDocuments(
                registry.indexPath,
                tenantId,
                expected,
              ),
            /active documents/,
          );
          index
            .prepare("UPDATE documents SET active=1 WHERE id=?")
            .run(active.id);
          const foreign =
            '---\ntenant_id: "foreign-fixture"\n---\nPrivate foreign orphan payload.\n';
          index
            .prepare("INSERT INTO content(hash,doc,created_at) VALUES(?,?,?)")
            .run(hash(foreign), foreign, "2026-10-26T00:00:00Z");
        } finally {
          index.close();
        }
        const before = readFileSync(registry.indexPath);
        await assert.rejects(
          refreshRecoveryIndex(db, options, bound),
          /foreign or unattributed/,
        );
        assert.deepEqual(readFileSync(registry.indexPath), before);
      }
      assert.ok(checks > 20);
    } finally {
      db.close();
    }
  },
);
