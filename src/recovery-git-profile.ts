/** Check-based local Git metadata binding; not confinement against same-UID writers. */
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
  type Stats,
} from "node:fs";
import { join } from "node:path";

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export const recoveryGitPathPresent = present;
const identity = (s: Stats) => `${s.dev}:${s.ino}`;

function fileSnapshot(path: string): string {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      before.size > 65536
    )
      throw new Error("Unsafe recovery Git configuration or HEAD");
    const bytes = Buffer.alloc(65537);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    const after = fstatSync(fd);
    if (
      size > 65536 ||
      size !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      identity(lstatSync(path)) !== identity(before)
    )
      throw new Error("Recovery Git configuration or HEAD changed during read");
    return `${identity(before)}:${before.mode}:${createHash("sha256").update(bytes.subarray(0, size)).digest("hex")}`;
  } finally {
    closeSync(fd);
  }
}

/** Reject metadata links before Git can read/write them; bind authority dirs and config. */
export function bindRecoveryGitProfile(
  auditDir: string,
): (allowRefUpdate?: boolean) => void {
  const gitDir = join(auditDir, ".git");
  const directories = new Map<string, string>();
  let config: string | undefined;
  let head: string | undefined;
  let refs: string | undefined;
  const check = (allowRefUpdate = false) => {
    const refFiles: Array<[string, string]> = [];
    let entries = 0;
    const seen = new Set<string>();
    const walk = (path: string, depth: number) => {
      if (++entries > 10000 || depth > 24)
        throw new Error("Recovery Git metadata exceeds supported bounds");
      const info = lstatSync(path);
      if (info.uid !== process.getuid?.() || info.isSymbolicLink())
        throw new Error("Unsafe recovery Git metadata link or owner");
      if (info.isDirectory()) {
        if (realpathSync(path) !== path)
          throw new Error("Redirected recovery Git metadata directory");
        const prior = directories.get(path);
        if (prior !== undefined && prior !== identity(info))
          throw new Error("Recovery Git metadata directory changed");
        directories.set(path, identity(info));
        seen.add(path);
        for (const name of readdirSync(path)) walk(join(path, name), depth + 1);
      } else {
        if (!info.isFile() || info.nlink !== 1)
          throw new Error("Unsafe recovery Git metadata file");
        if (
          path.startsWith(join(gitDir, "refs") + "/") ||
          path === join(gitDir, "packed-refs")
        )
          refFiles.push([path, fileSnapshot(path)]);
      }
    };
    walk(gitDir, 0);
    for (const path of directories.keys()) {
      if (!seen.has(path))
        throw new Error("Recovery Git metadata directory disappeared");
    }
    for (const required of ["objects", "refs"]) {
      if (!directories.has(join(gitDir, required)))
        throw new Error("Missing recovery Git metadata directory");
    }
    for (const name of [
      "commondir",
      "refs/replace",
      "info/grafts",
      "config.worktree",
      "objects/info/alternates",
      "objects/info/http-alternates",
      "info/attributes",
    ]) {
      if (present(join(gitDir, name)))
        throw new Error("Unsupported recovery anchor Git indirection");
    }
    if (present(join(auditDir, ".gitattributes")))
      throw new Error("Recovery anchor attributes are unsupported");
    const currentConfig = fileSnapshot(join(gitDir, "config"));
    const currentHead = fileSnapshot(join(gitDir, "HEAD"));
    if (
      (config !== undefined && config !== currentConfig) ||
      (head !== undefined && head !== currentHead)
    )
      throw new Error(
        "Recovery Git configuration or HEAD changed between commands",
      );
    const currentRefs = JSON.stringify(
      refFiles.sort(([a], [b]) => a.localeCompare(b)),
    );
    if (!allowRefUpdate && refs !== undefined && refs !== currentRefs)
      throw new Error("Recovery Git refs changed between commands");
    refs = currentRefs;
    config = currentConfig;
    head = currentHead;
  };
  check();
  return check;
}
