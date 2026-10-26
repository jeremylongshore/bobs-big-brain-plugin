/** Strict global recovery anchoring. Caller retains the shared recovery flock. */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { RecoveryPostcommitContext } from "@qmd-team-intent-kb/curator";
import {
  AuditRepository,
  appendAnchor,
  verifyAnchors,
  readAnchors,
  ExceptionManifestSchema,
  computeManifestHash,
  classifyChainBreaks,
  type ExceptionManifest,
  type StoredRowTuple,
} from "@qmd-team-intent-kb/store";
import { inspectRecoveryExportRoot } from "./recovery-export.js";
import { witnessRecoveryAnchor } from "./recovery-anchor-git.js";

export interface RecoveryAnchorSummary {
  anchorVerified: true;
  localWitnessVerified: true;
  chainHead: string;
  chainedRows: number;
  documentedExceptions: number;
  unverifiedRows: number;
  commitCreated: boolean;
  gitHead: string;
  remotePublication: "not-attempted";
}
export interface RecoveryAnchorOptions {
  exceptionManifest?: { path: string; expectedManifestHash: string };
}

function manifest(options: RecoveryAnchorOptions): ExceptionManifest | null {
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

export function anchorRecoveryHead(
  context: RecoveryPostcommitContext,
  options: RecoveryAnchorOptions = {},
): RecoveryAnchorSummary {
  if (process.platform !== "linux")
    throw new Error("Recovery anchor requires Linux descriptor binding");
  context.assertStillBound();
  const approved = manifest(options);
  const base = context.store.basePath;
  const baseIdentity = inspectRecoveryExportRoot(base);
  const auditDir = join(base, "audit");
  try {
    lstatSync(auditDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(auditDir, { mode: 0o700 });
  }
  const directoryIdentity = inspectRecoveryExportRoot(auditDir);
  const directoryFd = openSync(
    auditDir,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let fd: number | undefined;
  try {
    const relative = `/proc/self/fd/${directoryFd}/anchors.jsonl`;
    let flags = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    try {
      lstatSync(relative);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      flags |= constants.O_CREAT | constants.O_EXCL;
    }
    fd = openSync(relative, flags, 0o600);
    const identity = fstatSync(fd);
    if (
      !identity.isFile() ||
      identity.nlink !== 1 ||
      identity.uid !== process.getuid?.() ||
      (identity.mode & 0o077) !== 0 ||
      identity.size > 64 * 1024 * 1024
    )
      throw new Error("Unsafe recovery anchor log");
    const file = `/proc/self/fd/${fd}`;
    const verify = () => {
      context.assertStillBound();
      if (
        !isDeepStrictEqual(baseIdentity, inspectRecoveryExportRoot(base)) ||
        !isDeepStrictEqual(
          directoryIdentity,
          inspectRecoveryExportRoot(auditDir),
        )
      )
        throw new Error("Recovery anchor directory changed");
      const current = lstatSync(join(auditDir, "anchors.jsonl"));
      if (
        !current.isFile() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        current.nlink !== 1 ||
        current.size > 64 * 1024 * 1024
      )
        throw new Error("Recovery anchor log binding changed");
    };
    verify();
    const audit = new AuditRepository(context.database);
    const tuples = new Map<string, StoredRowTuple>();
    const rows = context.database
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
    const settlement = rows.find(
      (row) => row.id === context.status.auditEventId,
    );
    if (
      settlement === undefined ||
      settlement.entry_hash === null ||
      settlement.tenant_id !== context.targetTenantId
    )
      throw new Error("Recovery settlement is not in the chained audit head");
    const before = verifyAnchors(audit, file);
    const classified = classifyChainBreaks(
      before.chain.breaks,
      approved,
      tuples,
    );
    if (before.anchorBreaks.length > 0 || !classified.verified)
      throw new Error("Recovery anchor or chain verification refused");
    const record = appendAnchor(audit, file, {
      tenantId: context.targetTenantId,
    });
    verify();
    const after = verifyAnchors(audit, file);
    if (
      after.anchorBreaks.length > 0 ||
      !isDeepStrictEqual(before.chain, after.chain) ||
      readAnchors(file).at(-1)?.anchorHash !== record.anchorHash
    )
      throw new Error("Recovery anchor verification changed");
    const chained = audit
      .findAllChronological()
      .filter((row) => row.entry_hash !== null);
    if (
      record.chainedRows !== chained.length ||
      record.chainHead !== chained.at(-1)?.entry_hash
    )
      throw new Error("Recovery anchor does not witness the global head");
    const bytes = readFileSync(file);
    const witness = witnessRecoveryAnchor(auditDir, bytes, verify);
    verify();
    if (!readFileSync(file).equals(bytes))
      throw new Error("Recovery anchor bytes changed after witness");
    return {
      anchorVerified: true,
      localWitnessVerified: true,
      chainHead: record.chainHead,
      chainedRows: record.chainedRows,
      documentedExceptions: classified.documentedExceptions.length,
      unverifiedRows: before.chain.unverifiedRows,
      ...witness,
      remotePublication: "not-attempted",
    };
  } finally {
    try {
      if (fd !== undefined) closeSync(fd);
    } finally {
      closeSync(directoryFd);
    }
  }
}
