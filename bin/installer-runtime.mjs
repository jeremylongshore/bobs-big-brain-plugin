import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

/** @param {{base: string, tenant: string}} args
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function effectiveInstallerEnv(args, env = process.env) {
  return { ...env, TEAMKB_BASE_PATH: args.base, TEAMKB_TENANT_ID: args.tenant };
}

/**
 * The requested brain base controls team.json lookup. Do not consult an
 * unrelated default brain or duplicate bootstrap's team-mode predicate.
 * @param {NodeJS.ProcessEnv} env
 * @param {{teamModeRequested: (env: NodeJS.ProcessEnv) => boolean}} bootstrap
 */
export function assertLocalInstallerMode(env, bootstrap) {
  if (bootstrap.teamModeRequested(env)) {
    throw new Error(
      'Local init refuses an effective team configuration. Use team onboarding, or clear the team API environment and choose a brain base without team.json.',
    );
  }
}

/** @param {string} parent @param {string} child */
function withinOrEqual(parent, child) {
  const tail = relative(parent, child);
  return tail === '' || (tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail));
}

/**
 * Persist only a selection already inspected by the Registrar. This does not
 * verify an artifact or activate/copy a runtime. Future execution rechecks it.
 * @param {import('@qmd-team-intent-kb/qmd-adapter').QmdCommandProvenance | null} selected
 * @param {string} runtimeDirectory
 * @returns {Record<string, string>}
 */
export function selectedQmdEnvironment(selected, runtimeDirectory) {
  if (!selected) return {};
  if (selected.source === 'env' || selected.source === 'explicit') {
    if (selected.source === 'explicit' && !isAbsolute(selected.executable)) {
      throw new Error(
        'Cannot persist a relative explicit qmd binary; provide an absolute filesystem path. Execution itself retains the explicit verbatim contract.',
      );
    }
    return { TEAMKB_QMD_BIN: realpathSync(selected.executable) };
  }
  if (selected.source !== 'owned') return {};
  if (!selected.runtime) throw new Error('Selected owned qmd is missing its provenance.');
  const runtime = selected.runtime;
  const nodeModules = join(realpathSync(runtimeDirectory), 'node_modules');
  const forbidden = [nodeModules];
  if (existsSync(nodeModules)) forbidden.push(realpathSync(nodeModules));
  if (forbidden.some((root) => withinOrEqual(root, runtime.root))) {
    throw new Error(
      'Cannot persist an owned qmd runtime beneath plugin-runtime/node_modules; place the verified artifact in a separate prefix before registration.',
    );
  }
  return {
    TEAMKB_QMD_RUNTIME: JSON.stringify({
      root: runtime.root,
      manifestSha256: runtime.manifestSha256,
    }),
  };
}

/**
 * A failed explicitly configured choice is not an undeclared legacy miss.
 * Inspect presence only; selection/parsing/validation remain Registrar-owned.
 * @param {import('../src/qmd-command.js').LocalQmdCheck} checked
 * @param {NodeJS.ProcessEnv} [env]
 */
export function qmdAvailabilityOutcome(checked, env = process.env) {
  const version = checked.result.stdout.trim();
  const major = version.match(/(\d+)\.\d+\.\d+/);
  const reason =
    checked.result.exitCode !== 0
      ? checked.result.stderr.trim() ||
        `qmd availability exited with code ${checked.result.exitCode}`
      : major && Number(major[1]) < 2
        ? `${version} is too old; qmd-backed retrieval needs qmd 2.x`
        : undefined;
  const selected = checked.provenance?.source;
  const required =
    selected === 'explicit' ||
    selected === 'env' ||
    selected === 'owned' ||
    Boolean(env.TEAMKB_QMD_BIN?.trim()) ||
    env.TEAMKB_QMD_RUNTIME !== undefined;
  if (reason !== undefined && required) {
    throw new Error(
      `Configured qmd selection refused: ${reason}. Repair the pin or owned declaration before local capture.`,
    );
  }
  return { available: reason === undefined, version, reason };
}

/** POSIX shell rendering only; process execution uses structured argv.
 * @param {string} value
 */
export function shellQuote(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

/**
 * @param {{scope: string, tenant: string, base: string, qmdEnvironment?: Record<string, string>}} args
 * @param {string} bootstrapPath
 */
export function mcpRegistrationArgs(args, bootstrapPath) {
  return [
    'mcp',
    'add',
    'governed-brain',
    '-s',
    args.scope,
    '-e',
    `TEAMKB_TENANT_ID=${args.tenant}`,
    '-e',
    `TEAMKB_BASE_PATH=${args.base}`,
    ...Object.entries(args.qmdEnvironment ?? {}).flatMap(([key, value]) => [
      '-e',
      `${key}=${value}`,
    ]),
    '--',
    'node',
    bootstrapPath,
  ];
}
