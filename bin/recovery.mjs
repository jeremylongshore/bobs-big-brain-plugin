#!/usr/bin/env node
// Builtins only until effective team refusal and existing local native checks.
import { createRequire } from "node:module";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";

const HELP = `Usage: governed-second-brain-recovery <apply|repair> [options]

  --plan PATH --digest SHA256       Private, reviewed Registrar recovery envelope
  --source-export PATH             Existing private source-tenant export root
  --target-export PATH             Existing private target-tenant export root
  --qmd-root PATH --qmd-sha256 SHA   Explicit owned qmd2.5.3 runtime and manifest pin
  --origin-secret-file PATH        Explicit apply key; forbidden for repair
  --exception-manifest PATH         Optional canonical migration exceptions
  --exception-sha256 SHA            Independently expected canonical manifest hash

Prepare and review the plan with the Registrar recovery CLI. Both export roots
must already contain the five canonical source directories, and both private
tenant index roots must exist. This command installs no runtime or native module.
Apply replay does not verify maintenance; use repair to verify settled work.
Exit 0: verified local completion; 2: settled but incomplete; 1: refusal/failure.
Declared local standing is not physical-person authentication. Local verification
publishes no remote anchor and grants no deployment or live-data authority.
`;
let executionStarted = false;
function refuse(code) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, committed: executionStarted ? "unknown" : false, recoveryComplete: false, error: code })}\n`,
  );
  process.exitCode = 1;
}

// This bounded, non-following read supplies ONLY a team-configuration lookup hint.
// The Registrar independently validates the complete envelope and reviewed digest.
function baseHint(path) {
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
      throw new Error();
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd),
      named = lstatSync(path);
    if (
      length !== info.size ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      named.dev !== info.dev ||
      named.ino !== info.ino
    )
      throw new Error();
    const value = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    const base = value?.store?.basePath;
    if (typeof base !== "string" || !isAbsolute(base)) throw new Error();
    return base;
  } finally {
    closeSync(fd);
  }
}
async function main() {
  const { values, positionals } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
      plan: { type: "string" },
      digest: { type: "string" },
      "source-export": { type: "string" },
      "target-export": { type: "string" },
      "qmd-root": { type: "string" },
      "qmd-sha256": { type: "string" },
      "origin-secret-file": { type: "string" },
      "exception-manifest": { type: "string" },
      "exception-sha256": { type: "string" },
    },
    strict: true,
    allowPositionals: true,
  });
  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return;
  }
  const operation = positionals[0];
  if (
    positionals.length !== 1 ||
    !["apply", "repair"].includes(operation) ||
    ["plan", "source-export", "target-export", "qmd-root"].some(
      (key) => !values[key]?.trim(),
    ) ||
    ["digest", "qmd-sha256"].some(
      (key) => !/^[a-f0-9]{64}$/.test(values[key] ?? ""),
    ) ||
    (operation === "repair" && values["origin-secret-file"] !== undefined) ||
    (values["exception-manifest"] === undefined) !==
      (values["exception-sha256"] === undefined) ||
    (values["exception-sha256"] !== undefined &&
      !/^[a-f0-9]{64}$/.test(values["exception-sha256"]))
  )
    return refuse("invalid_arguments");
  const require = createRequire(import.meta.url);
  const bootstrap = require("../plugin-runtime/bootstrap.cjs");
  if (bootstrap.isConfigured(process.env.TEAMKB_API_URL))
    return refuse("team_mode_refused");
  const planPath = resolve(values.plan);
  const base = baseHint(planPath);
  if (bootstrap.teamModeRequested({ ...process.env, TEAMKB_BASE_PATH: base }))
    return refuse("team_mode_refused");
  if (
    process.platform !== "linux" ||
    Number(process.versions.node.split(".")[0]) !== 22
  )
    return refuse("unsupported_recovery_runtime");
  if (!bootstrap.nativeDependenciesReady())
    return refuse("native_dependencies_missing");
  const helper = require("../plugin-runtime/local-recovery.cjs");
  executionStarted = true;
  const result = await helper.executeRecoveryMaintenance(
    {
      operation,
      planPath,
      expectedDigest: values.digest,
      ...(values["origin-secret-file"] === undefined
        ? {}
        : { originSecretFile: resolve(values["origin-secret-file"]) }),
    },
    {
      sourceExportDir: resolve(values["source-export"]),
      targetExportDir: resolve(values["target-export"]),
      qmdRuntime: {
        root: resolve(values["qmd-root"]),
        manifestSha256: values["qmd-sha256"],
      },
      ...(values["exception-manifest"] === undefined
        ? {}
        : {
            exceptionManifest: {
              path: resolve(values["exception-manifest"]),
              expectedManifestHash: values["exception-sha256"],
            },
          }),
    },
  );
  const {
    ok,
    operation: observedOperation,
    committed,
    appliedNow,
    recoveryComplete,
    warnings,
  } = result;
  const output = {
    ok,
    operation: observedOperation,
    committed,
    appliedNow,
    recoveryComplete,
    warnings,
  };
  if (!result.ok) {
    output.failedStage = result.failedStage;
    output.error = result.error;
  } else {
    output.status = {
      state: result.status.state,
      entries: result.status.entries.length,
      archived: result.status.entries.filter((v) => v.archived).length,
    };
    output.postcommit =
      result.postcommit.state === "skipped_replay"
        ? { state: "skipped_replay" }
        : {
            state: "completed",
            localWitnessVerified:
              result.postcommit.value.anchor.localWitnessVerified,
            gitHead: result.postcommit.value.anchor.gitHead,
            remotePublication: result.postcommit.value.anchor.remotePublication,
            tenants: result.postcommit.value.tenants.map((v) => ({
              tenantId: v.tenantId,
              exportComplete: v.export.complete,
              verifiedDocuments: v.index?.verifiedDocuments ?? 0,
              indexVerified: v.index?.indexVerified ?? false,
            })),
          };
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = result.ok ? (result.recoveryComplete ? 0 : 2) : 1;
}
main().catch(() => refuse("recovery_refused"));
