/** Bounded local Git witness for recovery, with no network/background push. */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  bindRecoveryGitProfile,
  recoveryGitPathPresent,
} from "./recovery-git-profile.js";

const FLAGS = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.autocrlf=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
  "-c",
  "gc.autoDetach=false",
  "-c",
  "color.ui=false",
];
const ENV = {
  PATH: "/usr/bin:/bin",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "governed-brain",
  GIT_AUTHOR_EMAIL: "anchor@localhost",
  GIT_COMMITTER_NAME: "governed-brain",
  GIT_COMMITTER_EMAIL: "anchor@localhost",
};

export function witnessRecoveryAnchor(
  auditDir: string,
  bytes: Buffer,
  verify: () => void,
): { commitCreated: boolean; gitHead: string } {
  const profile: { verify?: (allowRefUpdate?: boolean) => void } = {};
  const check = (allowRefUpdate = false) => {
    verify();
    profile.verify?.(allowRefUpdate);
  };
  const git = (args: string[], input?: Buffer): Buffer => {
    check();
    const output = execFileSync("/usr/bin/git", [...FLAGS, ...args], {
      cwd: auditDir,
      env: ENV,
      input,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
      maxBuffer: Math.max(1024 * 1024, bytes.length + 1),
    });
    check(args[0] === "commit");
    return output;
  };
  const text = (args: string[]) => git(args).toString("utf8").trim();
  const gitDir = join(auditDir, ".git");
  if (!recoveryGitPathPresent(gitDir))
    git(["init", "-q", "--template=/dev/null", "--initial-branch=main"]);
  profile.verify = bindRecoveryGitProfile(auditDir);
  const keys = text([
    "config",
    "--local",
    "--no-includes",
    "--name-only",
    "--list",
  ]).split("\n");
  if (
    keys.some((key) =>
      /^(?:include\.|includeif\.|filter\.|extensions\.worktreeconfig)/i.test(
        key,
      ),
    )
  )
    throw new Error("Recovery Git configuration may execute or redirect");
  if (
    text(["rev-parse", "--show-toplevel"]) !== auditDir ||
    text(["rev-parse", "--absolute-git-dir"]) !== gitDir
  )
    throw new Error("Recovery Git repository binding differs");
  const onlyAnchor = (value: Buffer) =>
    value
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .every((name) => name === "anchors.jsonl");
  if (
    !onlyAnchor(
      git(["diff", "--no-ext-diff", "--cached", "--name-only", "-z"]),
    ) ||
    !onlyAnchor(git(["diff", "--no-ext-diff", "--name-only", "-z"]))
  )
    throw new Error("Unrelated recovery Git changes must be preserved");
  let previousHead: string | undefined;
  // An unborn repository has no HEAD object; an existing HEAD must contain the log.
  if (text(["rev-parse", "--is-inside-work-tree"]) !== "true")
    throw new Error("Recovery Git work tree unavailable");
  try {
    previousHead = text(["rev-parse", "--verify", "HEAD"]);
  } catch {
    if (text(["for-each-ref", "--format=%(refname)"]).length > 0)
      throw new Error("Recovery Git HEAD is invalid");
  }
  if (previousHead !== undefined) {
    const size = Number(text(["cat-file", "-s", "HEAD:anchors.jsonl"]));
    if (!Number.isSafeInteger(size) || size < 0 || size > bytes.length)
      throw new Error("Recovery Git log prefix differs");
    const previous = git(["cat-file", "blob", "HEAD:anchors.jsonl"]);
    if (!bytes.subarray(0, previous.length).equals(previous))
      throw new Error("Recovery Git witnessed history changed");
  }
  git(["add", "--", "anchors.jsonl"]);
  const expected = git(["hash-object", "--no-filters", "--stdin"], bytes)
    .toString("utf8")
    .trim();
  if (text(["rev-parse", ":anchors.jsonl"]) !== expected)
    throw new Error("Recovery Git staged bytes differ");
  if (
    previousHead !== undefined &&
    text(["rev-parse", "--verify", "HEAD"]) !== previousHead
  )
    throw new Error("Recovery Git HEAD changed before commit");
  const alreadyWitnessed =
    previousHead !== undefined &&
    text(["rev-parse", "HEAD:anchors.jsonl"]) === expected;
  if (!alreadyWitnessed)
    git(["commit", "-q", "-m", "anchor reviewed recovery"]);
  const gitHead = text(["rev-parse", "--verify", "HEAD"]);
  if (
    text(["rev-parse", `${gitHead}:anchors.jsonl`]) !== expected ||
    Number(text(["cat-file", "-s", `${gitHead}:anchors.jsonl`])) !== bytes.length
  )
    throw new Error("Recovery Git witness bytes differ");
  if (alreadyWitnessed && gitHead !== previousHead)
    throw new Error("Recovery Git witness changed unexpectedly");
  if (
    !alreadyWitnessed &&
    previousHead !== undefined &&
    text(["rev-parse", `${gitHead}^`]) !== previousHead
  )
    throw new Error("Recovery Git witness parent differs");
  if (text(["rev-parse", "--verify", "HEAD"]) !== gitHead)
    throw new Error("Recovery Git HEAD changed after witness");
  check();
  return { commitCreated: !alreadyWitnessed, gitHead };
}
