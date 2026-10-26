/** Actual builtin CLI refusal paths, with canaries at native/helper loading. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "bbb-recovery-cli-"));
  try {
    for (const path of ["bin", "plugin-runtime", "brain", "home"])
      mkdirSync(join(root, path), { mode: 0o700 });
    copyFileSync(
      new URL("../bin/recovery.mjs", import.meta.url),
      join(root, "bin/recovery.mjs"),
    );
    copyFileSync(
      new URL("../plugin-runtime/bootstrap.cjs", import.meta.url),
      join(root, "plugin-runtime/bootstrap.cjs"),
    );
    const plan = join(root, "plan.json"),
      marker = join(root, "native-load");
    writeFileSync(
      plan,
      JSON.stringify({ store: { basePath: join(root, "brain") } }),
      { mode: 0o600 },
    );
    const probe = join(root, "probe.cjs");
    writeFileSync(
      probe,
      `const Module=require('node:module');const load=Module._load;Module._load=function(id,...args){if(['better-sqlite3','fs-ext','sqlite-vec'].includes(id)||id.endsWith('local-recovery.cjs')){require('node:fs').writeFileSync(process.env.RECOVERY_CLI_CANARY,id);throw Error('fixture refusal');}return load.call(this,id,...args)};`,
    );
    const args = [
      "apply",
      "--plan",
      plan,
      "--digest",
      "a".repeat(64),
      "--source-export",
      join(root, "source"),
      "--target-export",
      join(root, "target"),
      "--qmd-root",
      join(root, "runtime"),
      "--qmd-sha256",
      "b".repeat(64),
    ];
    const execute = (argv = args, overrides = {}) => {
      const env = {
        PATH: "/usr/bin:/bin",
        HOME: join(root, "home"),
        TEAMKB_BASE_PATH: join(root, "brain"),
        RECOVERY_CLI_CANARY: marker,
        ...overrides,
      };
      const result = spawnSync(
        process.execPath,
        ["--require", probe, join(root, "bin/recovery.mjs"), ...argv],
        { env, encoding: "utf8", timeout: 3000 },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.stderr, "");
      return {
        ...result,
        output: result.stdout.startsWith("{")
          ? JSON.parse(result.stdout)
          : undefined,
      };
    };
    run({ root, plan, marker, args, execute });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("help requires no plan, helper or native module", () =>
  fixture(({ execute, marker }) => {
    const result = execute(["--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /apply\|repair/);
    assert.equal(existsSync(marker), false);
  }));
test("explicit team URL refuses before even reading a missing plan", () =>
  fixture(({ execute, args, marker }) => {
    args[2] += "-missing";
    const result = execute(args, {
      TEAMKB_API_URL: "https://private-fixture.invalid",
    });
    assert.equal(result.output.error, "team_mode_refused");
    assert.equal(result.status, 1);
    assert.equal(existsSync(marker), false);
  }));
test("team.json at the reviewed brain refuses before native/helper loading", () =>
  fixture(({ execute, root, marker }) => {
    writeFileSync(join(root, "brain/team.json"), "{}");
    const result = execute();
    assert.equal(result.output.error, "team_mode_refused");
    assert.equal(result.output.committed, false);
    assert.equal(existsSync(marker), false);
  }));
test("an unrelated environment brain does not override the reviewed local base", () =>
  fixture(({ execute, root, marker }) => {
    const other = join(root, "other");
    mkdirSync(other);
    writeFileSync(join(other, "team.json"), "{}");
    const result = execute(undefined, {
      TEAMKB_BASE_PATH: other,
      TEAMKB_API_URL: "${TEAMKB_API_URL}",
    });
    const supported =
      process.platform === "linux" &&
      Number(process.versions.node.split(".")[0]) === 22;
    assert.equal(
      result.output.error,
      supported
        ? "native_dependencies_missing"
        : "unsupported_recovery_runtime",
    );
    assert.equal(existsSync(marker), supported);
  }));
test("repair refuses an origin key before helper or native loading", () =>
  fixture(({ execute, args, marker }) => {
    args[0] = "repair";
    args.push("--origin-secret-file", "/unused-private-key");
    const result = execute();
    assert.equal(result.output.error, "invalid_arguments");
    assert.equal(existsSync(marker), false);
  }));
test("malformed private plan refuses without raw content or native loading", () =>
  fixture(({ execute, plan, marker }) => {
    writeFileSync(plan, "private malformed fixture marker");
    const result = execute();
    assert.equal(result.output.error, "recovery_refused");
    assert.equal(result.stdout.includes("private malformed"), false);
    assert.equal(existsSync(marker), false);
  }));
test("FIFO plan refuses promptly without waiting for a writer or loading natives", () =>
  fixture(({ execute, root, args, marker }) => {
    const fifo = join(root, "plan.fifo");
    assert.equal(spawnSync("/usr/bin/mkfifo", ["-m", "600", fifo]).status, 0);
    args[2] = fifo;
    const result = execute();
    assert.equal(result.output.error, "recovery_refused");
    assert.equal(existsSync(marker), false);
  }));
