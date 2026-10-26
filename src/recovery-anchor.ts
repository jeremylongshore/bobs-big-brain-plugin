/** Strict global recovery anchoring. Caller retains the shared recovery flock. */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { RecoveryPostcommitContext } from "@qmd-team-intent-kb/curator";
import {
  AuditRepository,
  appendAnchor,
  verifyAnchorRecords,
  parseAnchorLog,
} from "@qmd-team-intent-kb/store";
import { inspectRecoveryExportRoot } from "./recovery-export.js";
import { witnessRecoveryAnchor } from "./recovery-anchor-git.js";
import {
  readRecoveryExceptionManifest,
  readRecoveryAnchorSnapshot,
  verifyRecoveryAuditSnapshot,
  type RecoveryAnchorOptions,
} from "./recovery-audit.js";

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
export type { RecoveryAnchorOptions } from "./recovery-audit.js";

export function anchorRecoveryHead(
  context: RecoveryPostcommitContext,
  options: RecoveryAnchorOptions = {},
): RecoveryAnchorSummary {
  if (process.platform !== "linux")
    throw new Error("Recovery anchor requires Linux descriptor binding");
  context.assertStillBound();
  const approved = readRecoveryExceptionManifest(options);
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
    const {
      rows,
      verification: before,
      classified,
    } = verifyRecoveryAuditSnapshot(
      context.database,
      readRecoveryAnchorSnapshot(fd),
      approved,
    );
    const settlement = rows.find(
      (row) => row.id === context.status.auditEventId,
    );
    if (
      settlement === undefined ||
      settlement.entry_hash === null ||
      settlement.tenant_id !== context.targetTenantId
    )
      throw new Error("Recovery settlement is not in the chained audit head");
    const record = appendAnchor(audit, file, {
      tenantId: context.targetTenantId,
    });
    verify();
    const afterRecords = parseAnchorLog(
      readRecoveryAnchorSnapshot(fd).toString("utf8"),
    );
    const after = verifyAnchorRecords(audit, afterRecords);
    if (
      after.anchorBreaks.length > 0 ||
      !isDeepStrictEqual(before.chain, after.chain) ||
      afterRecords.at(-1)?.anchorHash !== record.anchorHash
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
    const bytes = readRecoveryAnchorSnapshot(fd);
    const witness = witnessRecoveryAnchor(auditDir, bytes, verify);
    verify();
    if (!readRecoveryAnchorSnapshot(fd).equals(bytes))
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
