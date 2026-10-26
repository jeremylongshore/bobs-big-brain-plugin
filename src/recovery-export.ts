/** Tenant-exclusive recovery exports. Never creates a root or chooses a live path. */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import type Database from "better-sqlite3";
import {
  formatMemoryAsMarkdown,
  getRelativePath,
  isExportRestricted,
  runExport,
} from "@qmd-team-intent-kb/git-exporter";
import {
  ExportStateRepository,
  MemoryRepository,
} from "@qmd-team-intent-kb/store";

const DIRECTORIES = new Set([
  "decisions",
  "curated",
  "guides",
  "archive",
  "bulk",
]);
const MEMORY_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/i;
const TENANT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface RecoveryExportSummary {
  written: number;
  archived: number;
  removed: number;
  unchanged: number;
  quarantined: number;
  removalBlocked: boolean;
  verifiedDocuments: number;
  complete: boolean;
}
interface RootIdentity {
  device: number;
  inode: number;
}

/** Existing, canonical, owner-private directory; no chmod, mkdir or symlink repair. */
export function inspectRecoveryExportRoot(root: string): RootIdentity {
  if (
    !isAbsolute(root) ||
    normalize(root) !== root ||
    realpathSync(root) !== root
  )
    throw new Error("Recovery export root must be canonical");
  const info = lstatSync(root);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error("Recovery export root must be owner-private");
  return { device: info.dev, inode: info.ino };
}

function requireRoot(root: string, expected: RootIdentity): void {
  const actual = inspectRecoveryExportRoot(root);
  if (actual.device !== expected.device || actual.inode !== expected.inode)
    throw new Error("Recovery export root changed");
}

function readDocument(path: string): string {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      info.size > 16 * 1024 * 1024
    )
      throw new Error("Unsafe recovery export document");
    const buffer = Buffer.alloc(info.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = readSync(fd, buffer, used, buffer.length - used, null);
      if (count === 0) break;
      used += count;
    }
    const after = fstatSync(fd);
    const named = lstatSync(path);
    if (
      used !== info.size ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      named.dev !== info.dev ||
      named.ino !== info.ino ||
      named.nlink !== 1
    )
      throw new Error("Recovery export document changed during read");
    return buffer.subarray(0, used).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Scan every entry, including unknown/hidden entries; never follow links. */
function scanTree(root: string, tenantId: string): Map<string, string> {
  const documents = new Map<string, string>();
  for (const directory of readdirSync(root).sort()) {
    const path = join(root, directory);
    const info = lstatSync(path);
    if (
      !DIRECTORIES.has(directory) ||
      !info.isDirectory() ||
      info.uid !== process.getuid?.() ||
      realpathSync(path) !== path
    )
      throw new Error("Recovery export tree has an unexpected entry");
    for (const name of readdirSync(path).sort()) {
      if (!MEMORY_FILE.test(name))
        throw new Error("Unexpected recovery export filename");
      const text = readDocument(join(path, name));
      const end = text.indexOf("\n---\n", 4);
      const header = text.slice(0, end);
      const tenants = [...header.matchAll(/^tenant_id: "([^"\n]*)"$/gm)];
      if (
        !text.startsWith("---\n") ||
        end < 0 ||
        tenants.length !== 1 ||
        tenants[0][1] !== tenantId
      )
        throw new Error("Recovery export tree is not tenant-exclusive");
      documents.set(relative(root, join(path, name)), text);
    }
  }
  return documents;
}

/**
 * Reconcile only the explicitly bound tenant into an already exclusive root.
 * The caller owns the shared recovery lock. Counts cannot certify index refresh.
 * A blocked/quarantined result remains incomplete, even if some files changed.
 */
export function reconcileRecoveryExport(
  database: Database.Database,
  binding: { tenantId: string; exportDir: string },
  assertStillBound: () => void,
): RecoveryExportSummary {
  const { tenantId, exportDir } = binding;
  if (!TENANT.test(tenantId))
    throw new Error("Unsupported recovery export tenant");
  const identity = inspectRecoveryExportRoot(exportDir);
  assertStillBound();
  scanTree(exportDir, tenantId);
  const memories = new MemoryRepository(database);
  const state = new ExportStateRepository(database);
  const targetId = `recovery-${createHash("sha256")
    .update(JSON.stringify([tenantId, exportDir]))
    .digest("hex")}`;
  const result = runExport(memories, state, {
    outputDir: exportDir,
    tenantId,
    targetId,
    reconcile: true,
  });
  assertStillBound();
  requireRoot(exportDir, identity);
  const summary: RecoveryExportSummary = {
    written: result.written.length,
    archived: result.archived.length,
    removed: result.removed.length,
    unchanged: result.unchanged,
    quarantined: result.quarantined.length,
    removalBlocked: result.removalBlocked !== undefined,
    verifiedDocuments: 0,
    complete: false,
  };
  if (summary.quarantined > 0 || summary.removalBlocked) return summary;
  // The outer reconcile checks retain the original root identity and stage boundaries.
  const actual = verifyRecoveryExportDocuments(database, binding, () => {});
  assertStillBound();
  requireRoot(exportDir, identity);
  return { ...summary, verifiedDocuments: actual.size, complete: true };
}

/** Read-only full canonical document proof for verification around index commands. */
export function verifyRecoveryExportDocuments(
  database: Database.Database,
  binding: { tenantId: string; exportDir: string },
  assertStillBound: () => void,
): Map<string, string> {
  const { tenantId, exportDir } = binding;
  if (!TENANT.test(tenantId))
    throw new Error("Unsupported recovery export tenant");
  assertStillBound();
  const identity = inspectRecoveryExportRoot(exportDir);
  const current = new MemoryRepository(database).findByTenantResilient(
    tenantId,
  );
  if (current.failures.length > 0)
    throw new Error("Recovery export source cannot be read");
  const expected = new Map(
    current.memories
      .filter((memory) => !isExportRestricted(memory))
      .map((memory) => [
        getRelativePath(memory),
        formatMemoryAsMarkdown(memory),
      ]),
  );
  const actual = scanTree(exportDir, tenantId);
  if (
    actual.size !== expected.size ||
    [...expected].some(([path, text]) => actual.get(path) !== text)
  )
    throw new Error("Recovery export differs from canonical tenant rendering");
  assertStillBound();
  requireRoot(exportDir, identity);
  return actual;
}
