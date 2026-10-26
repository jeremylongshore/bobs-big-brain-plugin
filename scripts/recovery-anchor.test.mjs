/** Private real-store strict-anchor source proofs; not packaged plugin/live proof. */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  existsSync,
  symlinkSync,
  renameSync,
  readdirSync,
  lstatSync,
  openSync,
  closeSync,
  chmodSync,
  linkSync,
  ftruncateSync,
  readlinkSync,
} from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  createDatabase,
  AuditRepository,
  verifyAuditChain,
  computeManifestHash,
  computeEntryHash,
} from "@qmd-team-intent-kb/store";
import { makeAuditEvent } from "../../bobs-big-brain-registrar/packages/test-fixtures/dist/index.js";
import { anchorRecoveryHead } from "../src/recovery-anchor.ts";
import {
  assertRecoveryAuditReadiness,
  readRecoveryAnchorSnapshot,
} from "../src/recovery-audit.ts";

if (!process.env.RECOVERY_FIXTURE_PROOF)
  throw new Error("Private fixture proof required");
const proof = process.env.RECOVERY_FIXTURE_PROOF;
const work = mkdtempSync(join(tmpdir(), "bbb-recovery-anchor-"));
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
function fixture() {
  const base = mkdtempSync(join(work, "case-"));
  const db = createDatabase({ path: join(base, "teamkb.db") });
  const audit = new AuditRepository(db);
  const source = makeAuditEvent({ tenantId: "source-fixture" });
  const target = makeAuditEvent({
    tenantId: "target-fixture",
    action: "governed",
  });
  audit.insert(source);
  audit.insert(target);
  let checks = 0;
  const context = {
    database: db,
    store: { basePath: base },
    targetTenantId: "target-fixture",
    status: { auditEventId: target.id },
    assertStillBound() {
      checks++;
      assert.equal(existsSync(base), true);
    },
  };
  const git = (args) =>
    execFileSync("/usr/bin/git", args, {
      cwd: join(base, "audit"),
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    }).trim();
  return {
    base,
    db,
    audit,
    source,
    target,
    context,
    git,
    checks: () => checks,
  };
}
function approveCurrentBreaks(f) {
  const breaks = verifyAuditChain(f.audit).breaks;
  const entries = breaks.map((b) => {
    const row = f.db.prepare("SELECT * FROM audit_events WHERE id=?").get(b.id);
    return {
      id: b.id,
      entryHash: row.entry_hash,
      prevEntryHash: row.prev_entry_hash,
      hashVersion: row.hash_version ?? 1,
      seq: row.seq,
      reason: b.reason,
    };
  });
  const body = {
    schemaVersion: 1,
    brainId: "private-fixture",
    generatedAt: "2026-10-26T00:00:00.000Z",
    entryCount: entries.length,
    entries,
  };
  const expectedManifestHash = computeManifestHash(body);
  const path = join(f.base, "exceptions.json");
  writeFileSync(
    path,
    JSON.stringify({ ...body, manifestHash: expectedManifestHash }),
    { mode: 0o600 },
  );
  return { exceptionManifest: { path, expectedManifestHash } };
}

test("anchors the global two-tenant head and repairs unchanged state without another anchor or commit", () => {
  const f = fixture();
  try {
    const first = anchorRecoveryHead(f.context);
    assert.equal(first.chainedRows, 2);
    assert.equal(first.commitCreated, true);
    assert.equal(first.remotePublication, "not-attempted");
    assert.equal(first.localWitnessVerified, true);
    const bytes = readFileSync(join(f.base, "audit", "anchors.jsonl"));
    const again = anchorRecoveryHead(f.context);
    assert.equal(again.gitHead, first.gitHead);
    assert.equal(again.commitCreated, false);
    assert.deepEqual(
      readFileSync(join(f.base, "audit", "anchors.jsonl")),
      bytes,
    );
    assert.equal(f.audit.findAllChronological().length, 2);
    assert.ok(f.checks() > 4);
  } finally {
    f.db.close();
  }
});
test("refuses an unmatched chain break and accepts only independently pinned canonical exceptions", () => {
  const f = fixture();
  try {
    f.db
      .prepare("UPDATE audit_events SET entry_hash=? WHERE id=?")
      .run("a".repeat(64), f.source.id);
    assert.throws(() => anchorRecoveryHead(f.context), /verification refused/);
    const options = approveCurrentBreaks(f);
    const result = anchorRecoveryHead(f.context, options);
    assert.ok(result.documentedExceptions > 0);
    f.db
      .prepare("UPDATE audit_events SET entry_hash=? WHERE id=?")
      .run("b".repeat(64), f.source.id);
    assert.throws(
      () => anchorRecoveryHead(f.context, options),
      /verification refused/,
    );
  } finally {
    f.db.close();
  }
});
test("refuses a mismatched exception-manifest pin without creating an audit directory", () => {
  const f = fixture();
  try {
    const options = approveCurrentBreaks(f);
    options.exceptionManifest.expectedManifestHash = "0".repeat(64);
    assert.throws(
      () => anchorRecoveryHead(f.context, options),
      /manifest digest/,
    );
    assert.equal(existsSync(join(f.base, "audit")), false);
  } finally {
    f.db.close();
  }
});
test("refuses redirected audit paths without altering outside data", () => {
  const f = fixture();
  try {
    const outside = join(f.base, "outside");
    mkdirSync(outside, { mode: 0o700 });
    writeFileSync(join(outside, "sentinel"), "private fixture");
    symlinkSync(outside, join(f.base, "audit"));
    assert.throws(() => anchorRecoveryHead(f.context), /canonical/);
    assert.equal(
      readFileSync(join(outside, "sentinel"), "utf8"),
      "private fixture",
    );
    assert.equal(existsSync(join(outside, "anchors.jsonl")), false);
  } finally {
    f.db.close();
  }
});
test("preserves unrelated staged changes and permits explicit repair after the obstruction is removed", () => {
  const f = fixture();
  try {
    anchorRecoveryHead(f.context);
    writeFileSync(join(f.base, "audit", "unrelated.txt"), "private fixture");
    f.git(["add", "unrelated.txt"]);
    const event = makeAuditEvent({ tenantId: "source-fixture" });
    f.audit.insert(event);
    assert.throws(() => anchorRecoveryHead(f.context), /Unrelated/);
    assert.equal(f.git(["diff", "--cached", "--name-only"]), "unrelated.txt");
    f.git(["restore", "--staged", "unrelated.txt"]);
    const repaired = anchorRecoveryHead(f.context);
    assert.equal(repaired.chainedRows, 3);
    assert.equal(repaired.commitCreated, true);
    assert.equal(
      readFileSync(join(f.base, "audit", "unrelated.txt"), "utf8"),
      "private fixture",
    );
  } finally {
    f.db.close();
  }
});
test("does not execute configured Git hooks or signing and never launches a remote push", () => {
  const f = fixture();
  try {
    anchorRecoveryHead(f.context);
    const hooks = join(f.base, "audit", ".git", "custom-hooks");
    mkdirSync(hooks);
    const marker = join(f.base, "hook-ran");
    writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\ntouch '${marker}'\n`, {
      mode: 0o700,
    });
    f.git(["config", "core.hooksPath", hooks]);
    f.git(["config", "commit.gpgSign", "true"]);
    f.git(["config", "gpg.program", "/missing-fixture-program"]);
    f.git(["remote", "add", "origin", "/missing-fixture-remote"]);
    f.audit.insert(makeAuditEvent({ tenantId: "source-fixture" }));
    const result = anchorRecoveryHead(f.context);
    assert.equal(result.commitCreated, true);
    assert.equal(result.remotePublication, "not-attempted");
    assert.equal(existsSync(marker), false);
  } finally {
    f.db.close();
  }
});

function treeFiles(root) {
  const found = [];
  const walk = (path) => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      if (lstatSync(child).isDirectory()) walk(child);
      else
        found.push([
          child.slice(root.length),
          readFileSync(child).toString("hex"),
        ]);
    }
  };
  walk(root);
  return found;
}
for (const kind of ["objects", "refs"])
  test(`refuses redirected Git ${kind} before writing outside the audit directory`, () => {
    const f = fixture();
    try {
      anchorRecoveryHead(f.context);
      const path = join(f.base, "audit", ".git", kind);
      const outside = join(f.base, "outside-" + kind);
      renameSync(path, outside);
      symlinkSync(outside, path);
      const before = treeFiles(outside);
      f.audit.insert(makeAuditEvent({ tenantId: "source-fixture" }));
      assert.throws(() => anchorRecoveryHead(f.context));
      assert.deepEqual(treeFiles(outside), before);
    } finally {
      f.db.close();
    }
  });
test("refuses Git configuration and attributes changed between commands", () => {
  const f = fixture();
  let indexFd;
  try {
    const first = anchorRecoveryHead(f.context);
    const index = join(f.base, "audit", ".git", "index");
    indexFd = openSync(index, "r"); // Keep the old inode allocated across Git replacement.
    const inode = lstatSync(index).ino;
    const bound = f.context.assertStillBound;
    let changed = false;
    f.context.assertStillBound = () => {
      bound();
      if (!changed && lstatSync(index).ino !== inode) {
        changed = true;
        appendFileSync(
          join(f.base, "audit", ".git", "config"),
          '\n[filter "fixture"]\n clean = /missing-fixture-program\n',
        );
        writeFileSync(
          join(f.base, "audit", ".gitattributes"),
          "anchors.jsonl filter=fixture\n",
        );
      }
    };
    f.audit.insert(makeAuditEvent({ tenantId: "source-fixture" }));
    assert.throws(() => anchorRecoveryHead(f.context));
    assert.equal(changed, true);
    assert.equal(f.git(["rev-parse", "HEAD"]), first.gitHead);
  } finally {
    if (indexFd !== undefined) closeSync(indexFd);
    f.db.close();
  }
});

test("refuses a settlement receipt belonging to another tenant", () => {
  const f = fixture();
  try {
    f.context.status.auditEventId = f.source.id;
    assert.throws(() => anchorRecoveryHead(f.context), /settlement/);
    assert.equal(existsSync(join(f.base, "audit", ".git")), false);
  } finally {
    f.db.close();
  }
});
test("refuses exception manifest count drift even with a matching independent digest", () => {
  const f = fixture();
  try {
    const options = approveCurrentBreaks(f);
    const value = JSON.parse(
      readFileSync(options.exceptionManifest.path, "utf8"),
    );
    value.entryCount += 1;
    const { manifestHash: prior, ...body } = value;
    value.manifestHash = computeManifestHash(body);
    options.exceptionManifest.expectedManifestHash = value.manifestHash;
    writeFileSync(options.exceptionManifest.path, JSON.stringify(value));
    assert.throws(
      () => anchorRecoveryHead(f.context, options),
      /digest or count/,
    );
    assert.equal(existsSync(join(f.base, "audit")), false);
  } finally {
    f.db.close();
  }
});

test("refuses replacement objects that would misrepresent the returned HEAD blob", () => {
  const f = fixture();
  try {
    const first = anchorRecoveryHead(f.context);
    f.audit.insert(makeAuditEvent({ tenantId: "source-fixture" }));
    const second = anchorRecoveryHead(f.context);
    f.git(["update-ref", "refs/heads/main", first.gitHead]);
    f.git(["replace", first.gitHead, second.gitHead]);
    assert.notEqual(
      f.git(["show", "HEAD:anchors.jsonl"]),
      f.git(["--no-replace-objects", "show", "HEAD:anchors.jsonl"]),
    );
    const bytes = readFileSync(join(f.base, "audit", "anchors.jsonl"));
    assert.throws(() => anchorRecoveryHead(f.context), /indirection/);
    assert.equal(
      f.git(["--no-replace-objects", "rev-parse", "HEAD"]),
      first.gitHead,
    );
    assert.deepEqual(
      readFileSync(join(f.base, "audit", "anchors.jsonl")),
      bytes,
    );
  } finally {
    f.db.close();
  }
});
test("refuses grafted Git ancestry before witnessing", () => {
  const f = fixture();
  try {
    const first = anchorRecoveryHead(f.context);
    const info = join(f.base, "audit", ".git", "info");
    mkdirSync(info, { recursive: true });
    writeFileSync(join(info, "grafts"), first.gitHead + "\n");
    assert.throws(() => anchorRecoveryHead(f.context), /indirection/);
  } finally {
    f.db.close();
  }
});

test("refuses a branch ref swapped after capturing the witness commit", () => {
  const f = fixture();
  let indexFd;
  try {
    const first = anchorRecoveryHead(f.context);
    f.audit.insert(makeAuditEvent({ tenantId: "source-fixture" }));
    const second = anchorRecoveryHead(f.context);
    const index = join(f.base, "audit", ".git", "index");
    indexFd = openSync(index, "r"); // Keep the old inode allocated across Git replacement.
    const inode = lstatSync(index).ino;
    const bound = f.context.assertStillBound;
    let changed = false;
    f.context.assertStillBound = () => {
      bound();
      if (!changed && lstatSync(index).ino !== inode) {
        changed = true;
        f.git(["update-ref", "refs/heads/main", first.gitHead]);
      }
    };
    f.audit.insert(makeAuditEvent({ tenantId: "source-fixture" }));
    assert.throws(() => anchorRecoveryHead(f.context), /refs changed/);
    assert.equal(changed, true);
    assert.notEqual(first.gitHead, second.gitHead);
  } finally {
    if (indexFd !== undefined) closeSync(indexFd);
    f.db.close();
  }
});

function readinessFixture() {
  const f = fixture();
  f.db.pragma("wal_checkpoint(TRUNCATE)");
  f.db.pragma("journal_mode = DELETE");
  return f;
}
function readiness(f, options) {
  // A fresh readiness context deliberately contains no settlement receipt.
  const context = {
    database: f.db,
    store: { basePath: f.base },
    assertStillBound: () => f.context.assertStillBound(),
  };
  return f.db
    .transaction(() => assertRecoveryAuditReadiness(context, options))
    .immediate();
}
function filesystemSnapshot(root) {
  const result = [];
  const walk = (path) => {
    const info = lstatSync(path);
    const type = info.isSymbolicLink()
      ? "link"
      : info.isDirectory()
        ? "directory"
        : info.isFile()
          ? "file"
          : "special";
    result.push({
      path: path.slice(root.length),
      type,
      mode: info.mode,
      uid: info.uid,
      inode: info.ino,
      device: info.dev,
      links: info.nlink,
      size: info.size,
      mtime: info.mtimeMs,
      ctime: info.ctimeMs,
      ...(type === "file"
        ? {
            sha256: createHash("sha256")
              .update(readFileSync(path))
              .digest("hex"),
          }
        : {}),
      ...(type === "link" ? { target: readlinkSync(path) } : {}),
    });
    if (type === "directory")
      for (const name of readdirSync(path).sort()) walk(join(path, name));
  };
  walk(root);
  return result;
}
for (const state of ["absent-directory", "absent-log", "existing-log"])
  test(`readiness accepts clean ${state} without creating files, changing data or requiring settlement`, () => {
    const f = readinessFixture();
    try {
      if (state === "absent-log")
        mkdirSync(join(f.base, "audit"), { mode: 0o700 });
      if (state === "existing-log") anchorRecoveryHead(f.context);
      const before = filesystemSnapshot(f.base);
      assert.equal(readiness(f), undefined);
      assert.deepEqual(filesystemSnapshot(f.base), before);
      assert.equal(f.audit.findAllChronological().length, 2);
    } finally {
      f.db.close();
    }
  });
test("readiness refuses a genuine ordering fork and never treats a fork manifest as amnesty", () => {
  const f = readinessFixture();
  try {
    const third = makeAuditEvent({ tenantId: "source-fixture" });
    f.audit.insert(third);
    const first = f.db
      .prepare("SELECT entry_hash FROM audit_events WHERE id=?")
      .get(f.source.id);
    const row = f.db
      .prepare("SELECT * FROM audit_events WHERE id=?")
      .get(third.id);
    const changed = { ...row, prev_entry_hash: first.entry_hash };
    f.db
      .prepare(
        "UPDATE audit_events SET prev_entry_hash=?,entry_hash=? WHERE id=?",
      )
      .run(
        first.entry_hash,
        computeEntryHash(changed, row.hash_version ?? 1),
        third.id,
      );
    assert.ok(
      verifyAuditChain(f.audit).breaks.some((b) => b.reason === "CHAIN_FORK"),
    );
    const before = filesystemSnapshot(f.base);
    assert.throws(() => readiness(f), /verification refused/);
    assert.deepEqual(filesystemSnapshot(f.base), before);
    const options = approveCurrentBreaks(f);
    const pinned = filesystemSnapshot(f.base);
    assert.throws(() => readiness(f, options));
    assert.deepEqual(filesystemSnapshot(f.base), pinned);
    assert.equal(existsSync(join(f.base, "audit")), false);
  } finally {
    f.db.close();
  }
});
test("readiness accepts only exact eligible exceptions and refuses pin or current tuple drift", () => {
  const f = readinessFixture();
  try {
    f.db
      .prepare("UPDATE audit_events SET entry_hash=? WHERE id=?")
      .run("a".repeat(64), f.source.id);
    assert.throws(() => readiness(f), /verification refused/);
    const options = approveCurrentBreaks(f);
    const before = filesystemSnapshot(f.base);
    assert.equal(readiness(f, options), undefined);
    assert.deepEqual(filesystemSnapshot(f.base), before);
    assert.throws(
      () =>
        readiness(f, {
          exceptionManifest: {
            ...options.exceptionManifest,
            expectedManifestHash: "0".repeat(64),
          },
        }),
      /manifest digest/,
    );
    assert.deepEqual(filesystemSnapshot(f.base), before);
    f.db
      .prepare("UPDATE audit_events SET entry_hash=? WHERE id=?")
      .run("b".repeat(64), f.source.id);
    const changed = filesystemSnapshot(f.base);
    assert.throws(() => readiness(f, options), /verification refused/);
    assert.deepEqual(filesystemSnapshot(f.base), changed);
  } finally {
    f.db.close();
  }
});
test("readiness refuses edited anchors without touching audit, Git or database files", () => {
  const f = readinessFixture();
  try {
    anchorRecoveryHead(f.context);
    const path = join(f.base, "audit/anchors.jsonl");
    const record = JSON.parse(readFileSync(path, "utf8").trim());
    record.chainHead = "forged";
    writeFileSync(path, JSON.stringify(record) + "\n");
    const before = filesystemSnapshot(f.base);
    assert.throws(() => readiness(f), /verification refused/);
    assert.deepEqual(filesystemSnapshot(f.base), before);
  } finally {
    f.db.close();
  }
});
for (const kind of [
  "audit-link",
  "audit-dangling-link",
  "file-link",
  "file-dangling-link",
  "hardlink",
  "fifo",
  "directory",
  "permissive",
  "oversized",
  "malformed",
])
  test(`readiness refuses unsafe ${kind} without repairing or changing it`, () => {
    const f = readinessFixture();
    try {
      const audit = join(f.base, "audit"),
        path = join(audit, "anchors.jsonl");
      if (kind.startsWith("audit-")) {
        const outside = join(f.base, "outside");
        if (kind === "audit-link") mkdirSync(outside, { mode: 0o700 });
        symlinkSync(outside, audit);
      } else {
        mkdirSync(audit, { mode: 0o700 });
        if (kind.startsWith("file-")) {
          const outside = join(f.base, "outside-log");
          if (kind === "file-link") writeFileSync(outside, "", { mode: 0o600 });
          symlinkSync(outside, path);
        } else if (kind === "fifo") execFileSync("/usr/bin/mkfifo", [path]);
        else if (kind === "directory") mkdirSync(path, { mode: 0o700 });
        else {
          writeFileSync(path, kind === "malformed" ? "{not-json" : "", {
            mode: kind === "permissive" ? 0o644 : 0o600,
          });
          if (kind === "hardlink") linkSync(path, join(f.base, "alias"));
          if (kind === "oversized") {
            const fd = openSync(path, "r+");
            try {
              ftruncateSync(fd, 64 * 1024 * 1024 + 1);
            } finally {
              closeSync(fd);
            }
          }
        }
      }
      const before = filesystemSnapshot(f.base);
      assert.throws(() => readiness(f));
      assert.deepEqual(filesystemSnapshot(f.base), before);
    } finally {
      f.db.close();
    }
  });
test("readiness refuses an unreadable audit directory without permission repair", () => {
  const f = readinessFixture();
  const path = join(f.base, "audit");
  try {
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0);
    assert.throws(() => readiness(f));
    assert.equal(lstatSync(path).mode & 0o777, 0);
  } finally {
    chmodSync(path, 0o700);
    f.db.close();
  }
});
for (const kind of ["directory-appeared", "log-appeared", "log-replaced"])
  test(`readiness centrally refuses ${kind} during its binding checks`, () => {
    const f = readinessFixture();
    try {
      const audit = join(f.base, "audit"),
        path = join(audit, "anchors.jsonl");
      if (kind === "log-appeared") mkdirSync(audit, { mode: 0o700 });
      if (kind === "log-replaced") anchorRecoveryHead(f.context);
      const databaseBefore = readFileSync(join(f.base, "teamkb.db"));
      const bound = f.context.assertStillBound;
      let calls = 0,
        changed = false;
      f.context.assertStillBound = () => {
        bound();
        calls++;
        if (!changed && calls === (kind === "directory-appeared" ? 3 : 4)) {
          changed = true;
          if (kind === "directory-appeared") mkdirSync(audit, { mode: 0o700 });
          else {
            if (kind === "log-replaced") renameSync(path, path + ".original");
            writeFileSync(path, "external-writer-sentinel", { mode: 0o600 });
          }
        }
      };
      assert.throws(() => readiness(f), /changed|appeared/);
      assert.equal(changed, true);
      assert.deepEqual(readFileSync(join(f.base, "teamkb.db")), databaseBefore);
      if (kind !== "directory-appeared")
        assert.equal(readFileSync(path, "utf8"), "external-writer-sentinel");
    } finally {
      f.db.close();
    }
  });
test("bounded snapshot reading refuses concurrent growth within its original allocation", async (t) => {
  const f = readinessFixture();
  let fd;
  try {
    const path = join(f.base, "bounded.jsonl");
    writeFileSync(path, "x", { mode: 0o600 });
    fd = openSync(path, "r");
    const original = fs.readSync;
    let grown = false,
      maxBuffer = 0;
    t.mock.method(
      fs,
      "readSync",
      function (handle, buffer, offset, length, position) {
        maxBuffer = Math.max(maxBuffer, buffer.length);
        if (!grown) {
          grown = true;
          appendFileSync(path, "y".repeat(1024 * 1024));
        }
        return original.call(this, handle, buffer, offset, length, position);
      },
    );
    syncBuiltinESMExports();
    assert.throws(() => readRecoveryAnchorSnapshot(fd), /changed during read/);
    assert.equal(grown, true);
    assert.equal(maxBuffer, 2);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (fd !== undefined) closeSync(fd);
    f.db.close();
  }
});
