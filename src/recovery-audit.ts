/** Canonical strict audit snapshots shared by recovery readiness and anchoring. */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type Database from "better-sqlite3";
import type { RecoveryReadinessContext } from "@qmd-team-intent-kb/curator";
import {
  AuditRepository,
  ExceptionManifestSchema,
  computeManifestHash,
  classifyChainBreaks,
  parseAnchorLog,
  verifyAnchorRecords,
  type ExceptionManifest,
  type StoredRowTuple,
} from "@qmd-team-intent-kb/store";
import { inspectRecoveryExportRoot } from "./recovery-export.js";

export interface RecoveryAnchorOptions {
  exceptionManifest?: { path: string; expectedManifestHash: string };
}

export function readRecoveryExceptionManifest(
  options: RecoveryAnchorOptions,
): ExceptionManifest | null {
  if (options.exceptionManifest === undefined) return null;
  const { path, expectedManifestHash } = options.exceptionManifest;
  if (
    !/^[a-f0-9]{64}$/.test(expectedManifestHash) ||
    realpathSync(path) !== path
  )
    throw new Error("Invalid recovery exception manifest binding");
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
      (info.mode & 0o077) !== 0 ||
      info.size > 8 * 1024 * 1024
    )
      throw new Error("Unsafe recovery exception manifest");
    const buffer = Buffer.alloc(info.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = readSync(fd, buffer, used, buffer.length - used, null);
      if (!count) break;
      used += count;
    }
    const after = fstatSync(fd);
    const named = lstatSync(path);
    if (
      used !== info.size ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs ||
      named.dev !== info.dev ||
      named.ino !== info.ino ||
      named.nlink !== 1
    )
      throw new Error("Recovery exception manifest changed during read");
    const value = ExceptionManifestSchema.parse(
      JSON.parse(buffer.subarray(0, used).toString("utf8")),
    );
    const { manifestHash, ...body } = value;
    if (
      value.entryCount !== value.entries.length ||
      computeManifestHash(body) !== manifestHash
    )
      throw new Error("Recovery exception manifest digest or count differs");
    if (
      value.manifestHash !== expectedManifestHash ||
      new Set(value.entries.map((entry) => entry.id)).size !==
        value.entries.length
    )
      throw new Error("Recovery exception manifest digest or identity differs");
    return value;
  } finally {
    closeSync(fd);
  }
}

/** Read exactly one bounded snapshot; reject growth, truncation and metadata drift. */
export function readRecoveryAnchorSnapshot(fd: number): Buffer {
  const info = fstatSync(fd);
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    info.size > 64 * 1024 * 1024
  )
    throw new Error("Unsafe recovery anchor log");
  const buffer = Buffer.alloc(info.size + 1);
  let used = 0;
  while (used < buffer.length) {
    const count = readSync(fd, buffer, used, buffer.length - used, used);
    if (!count) break;
    used += count;
  }
  const after = fstatSync(fd);
  if (
    used !== info.size ||
    after.size !== info.size ||
    after.mtimeMs !== info.mtimeMs ||
    after.ctimeMs !== info.ctimeMs ||
    after.mode !== info.mode ||
    after.uid !== info.uid ||
    after.nlink !== 1
  )
    throw new Error("Recovery anchor log changed during read");
  return buffer.subarray(0, used);
}

export function verifyRecoveryAuditSnapshot(
  database: Database.Database,
  snapshot: string | Buffer,
  approved: ExceptionManifest | null,
) {
  const rows = database
    .prepare(
      "SELECT id, tenant_id, entry_hash, prev_entry_hash, hash_version, seq FROM audit_events ORDER BY seq",
    )
    .all() as Array<{
    id: string;
    tenant_id: string;
    entry_hash: string | null;
    prev_entry_hash: string | null;
    hash_version: number | null;
    seq: number;
  }>;
  const tuples = new Map<string, StoredRowTuple>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.seq) || row.seq < 1)
      throw new Error("Recovery audit sequence is unavailable");
    tuples.set(row.id, {
      entry_hash: row.entry_hash,
      prev_entry_hash: row.prev_entry_hash,
      hash_version: row.hash_version ?? 1,
      seq: row.seq,
    });
  }
  const verification = verifyAnchorRecords(
    new AuditRepository(database),
    parseAnchorLog(
      typeof snapshot === "string" ? snapshot : snapshot.toString("utf8"),
    ),
  );
  const classified = classifyChainBreaks(
    verification.chain.breaks,
    approved,
    tuples,
  );
  if (verification.anchorBreaks.length > 0 || !classified.verified)
    throw new Error("Recovery anchor or chain verification refused");
  return { rows, verification, classified };
}

function absent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function directoryBinding(path: string, fd: number) {
  const named = inspectRecoveryExportRoot(path);
  const opened = fstatSync(fd);
  if (
    !opened.isDirectory() ||
    opened.dev !== named.device ||
    opened.ino !== named.inode ||
    opened.uid !== process.getuid?.() ||
    (opened.mode & 0o077) !== 0
  )
    throw new Error("Recovery audit directory binding changed");
  return {
    ...named,
    mode: opened.mode,
    uid: opened.uid,
    mtimeMs: opened.mtimeMs,
    ctimeMs: opened.ctimeMs,
  };
}

/** Fixed read-only readiness. Caller holds the recovery flock and SQLite writer lock. */
export function assertRecoveryAuditReadiness(
  context: RecoveryReadinessContext,
  options: RecoveryAnchorOptions = {},
): undefined {
  if (process.platform !== "linux")
    throw new Error("Recovery audit readiness requires Linux");
  context.assertStillBound();
  const approved = readRecoveryExceptionManifest(options);
  const base = context.store.basePath;
  const baseIdentity = inspectRecoveryExportRoot(base);
  const baseFd = openSync(
    base,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let auditFd: number | undefined;
  let fileFd: number | undefined;
  try {
    const initialBase = directoryBinding(base, baseFd);
    if (
      initialBase.device !== baseIdentity.device ||
      initialBase.inode !== baseIdentity.inode
    )
      throw new Error("Recovery audit base changed while opening");
    const boundBase = () => {
      context.assertStillBound();
      if (!isDeepStrictEqual(initialBase, directoryBinding(base, baseFd)))
        throw new Error("Recovery audit base changed");
    };
    boundBase();
    const auditPath = join(base, "audit");
    const relativeAudit = `/proc/self/fd/${baseFd}/audit`;
    if (absent(relativeAudit)) {
      verifyRecoveryAuditSnapshot(context.database, "", approved);
      boundBase();
      if (!absent(relativeAudit))
        throw new Error("Recovery audit directory appeared during readiness");
      return undefined;
    }
    const auditIdentity = inspectRecoveryExportRoot(auditPath);
    auditFd = openSync(
      relativeAudit,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const initialAudit = directoryBinding(auditPath, auditFd);
    if (
      initialAudit.device !== auditIdentity.device ||
      initialAudit.inode !== auditIdentity.inode
    )
      throw new Error("Recovery audit directory changed while opening");
    const boundAudit = () => {
      boundBase();
      if (
        !isDeepStrictEqual(initialAudit, directoryBinding(auditPath, auditFd!))
      )
        throw new Error("Recovery audit directory changed");
    };
    boundAudit();
    const relativeFile = `/proc/self/fd/${auditFd}/anchors.jsonl`;
    if (absent(relativeFile)) {
      verifyRecoveryAuditSnapshot(context.database, "", approved);
      boundAudit();
      if (!absent(relativeFile))
        throw new Error("Recovery anchor log appeared during readiness");
      return undefined;
    }
    fileFd = openSync(
      relativeFile,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const initial = fstatSync(fileFd);
    const snapshot = readRecoveryAnchorSnapshot(fileFd);
    verifyRecoveryAuditSnapshot(context.database, snapshot, approved);
    boundAudit();
    const current = fstatSync(fileFd);
    const named = lstatSync(relativeFile);
    if (
      named.dev !== initial.dev ||
      named.ino !== initial.ino ||
      named.nlink !== 1 ||
      current.size !== initial.size ||
      current.mtimeMs !== initial.mtimeMs ||
      current.ctimeMs !== initial.ctimeMs ||
      current.mode !== initial.mode ||
      current.uid !== initial.uid ||
      current.nlink !== 1
    )
      throw new Error("Recovery anchor binding changed during readiness");
    return undefined;
  } finally {
    try {
      if (fileFd !== undefined) closeSync(fileFd);
    } finally {
      try {
        if (auditFd !== undefined) closeSync(auditFd);
      } finally {
        closeSync(baseFd);
      }
    }
  }
}
