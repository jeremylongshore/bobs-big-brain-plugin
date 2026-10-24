#!/usr/bin/env node
/**
 * governed-second-brain init — build a local governed brain from a folder, then
 * tell you how to wire it into Claude Code / Cowork.
 *
 * Usage:
 *   governed-second-brain init <folder> [--index-only] [--yes] [--clean]
 *                                       [--base <dir>] [--tenant <id>]
 *
 *   --index-only   Build with ZERO LLM egress: capture your files → govern
 *                  (deterministic dedupe/policy/promote) → qmd index. No
 *                  Anthropic calls. Best for regulated / client data.
 *                  (Full ICO-compile mode — which derives richer knowledge and
 *                  DOES egress to Anthropic — is on the way; see the notice.)
 *   --yes          Skip the consent prompt (non-interactive).
 *   --clean        Wipe the target brain dir first, then rebuild.
 *   --base <dir>   Brain location (default ~/.teamkb). Must be under $HOME.
 *   --tenant <id>  Tenant/namespace (default "local").
 *
 * This is a self-contained driver: it builds the brain by driving the plugin's
 * own bundled MCP server (the exact runtime you'll run day-to-day), so what the
 * installer exercises is what you ship.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { homedir } from 'node:os';
import { join, resolve, relative, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { existsSync, rmSync, readFileSync, statSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { validateBrainTarget, revalidateBrainTarget } from './installer-paths.mjs';
import { installerChildEnv, effectiveInstallerEnv, assertLocalInstallerMode, selectedQmdEnvironment, qmdAvailabilityOutcome, shellQuote, mcpRegistrationArgs } from './installer-runtime.mjs';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = join(PLUGIN_ROOT, 'plugin-runtime', 'governed-brain.cjs');
const require = createRequire(import.meta.url);
const BOOTSTRAP = join(PLUGIN_ROOT, 'plugin-runtime', 'bootstrap.cjs');
const bootstrap = require(BOOTSTRAP);
const QMD_HELPER = join(PLUGIN_ROOT, 'plugin-runtime', 'qmd-command.cjs');
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.mdx']);

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};
const log = (...a) => console.log(...a);
const die = (msg) => { console.error(C.red(`✗ ${msg}`)); process.exit(1); };

function parseArgs(argv) {
  const a = { _: [], indexOnly: false, yes: false, clean: false, register: true, scope: 'user',
    base: join(homedir(), '.teamkb'), tenant: 'local' };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--index-only') a.indexOnly = true;
    else if (t === '--yes' || t === '-y') a.yes = true;
    else if (t === '--clean') a.clean = true;
    else if (t === '--base') a.base = resolve(argv[++i]);
    else if (t === '--tenant') a.tenant = argv[++i];
    else if (t === '--scope') a.scope = argv[++i];
    else if (t === '--no-register') a.register = false;
    else if (t === '--resume') {/* additive is the default; no-op */}
    else a._.push(t);
  }
  return a;
}

function walkTextFiles(root) {
  const out = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) visit(p);
      else if (TEXT_EXT.has(extname(name).toLowerCase()) && st.size > 0 && st.size < 1_000_000) out.push(p);
    }
  };
  visit(root);
  return out;
}

async function confirm(question) {
  const rl = createInterface({ input: stdin, output: stdout });
  const ans = (await rl.question(`${question} ${C.dim('[y/N]')} `)).trim().toLowerCase();
  rl.close();
  return ans === 'y' || ans === 'yes';
}

async function preflight(folder, args, fileCount) {
  log('');
  log(C.bold("  Bob's Big Brain — pre-flight"));
  log('  ' + C.dim('─'.repeat(58)));
  log(`  Mode        ${args.indexOnly ? C.green('index-only (no LLM egress)') : C.yellow('full compile (egresses to Anthropic)')}`);
  log(`  Source      ${folder}  ${C.dim(`(${fileCount} text file${fileCount === 1 ? '' : 's'})`)}`);
  log(`  Brain       ${args.base}  ${C.dim(`(tenant: ${args.tenant})`)}`);
  log(`  qmd index   ${qmdIndexPath(args)}  ${C.dim('(derived, tenant-scoped)')}`);
  log('');
  log('  This will:');
  log(`    • ${C.bold('read')} every text file (.md/.txt/.mdx) under the source folder`);
  log(`    • ${C.bold('run local tools')} on your machine (the bundled govern kernel + qmd)`);
  log(`    • ${C.bold('write')} a governed brain (SQLite + JSONL audit + qmd index) under ${args.base}`);
  if (args.indexOnly) {
    log(`    • ${C.green('send NOTHING over the network')} — index-only is fully local`);
  } else {
    log(`    • ${C.yellow('SEND your file text to DeepSeek')} (ICO compile derives knowledge) — this egresses`);
  }
  log('');
  if (args.yes) return true;
  return confirm('  Proceed?');
}

// Reuse the import-inert bootstrap's lockfile-pinned provisioner. Its native
// prefix is separate from any explicitly declared owned qmd artifact.
function ensureNativeDep() {
  bootstrap.provisionNativeDependencies();
}

async function checkQmd(args) {
  const deadline = Date.now() + 5_000;
  const { checkLocalQmd } = require(QMD_HELPER);
  const checked = await checkLocalQmd({
    tenantId: args.tenant, basePath: args.base, exportDir: join(args.base, 'kb-export'),
  }, deadline);
  const outcome = qmdAvailabilityOutcome(checked);
  args.qmdEnvironment = outcome.available
    ? selectedQmdEnvironment(checked.provenance, dirname(RUNTIME)) : {};
  if (outcome.available) {
    log(C.dim(`  qmd (${checked.provenance?.source ?? 'selected'}): ${outcome.version}`));
    return true;
  }
  log(C.yellow(`  ⚠ Selected qmd is unavailable: ${outcome.reason}`));
  log(C.yellow('    Capture/govern/audit can continue; native FTS may provide partial retrieval.'));
  return false;
}

function qmdIndexPath(args) {
  return join(args.base, 'qmd-index', args.tenant);
}

async function buildBrain(folder, files, args) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [BOOTSTRAP],
    env: installerChildEnv(args),
  });
  const client = new Client({ name: 'gsb-installer', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  const text = (r) => { try { return JSON.parse(r.content?.[0]?.text ?? '{}'); } catch { return {}; } };

  log('');
  log(C.bold(`  Capturing ${files.length} file${files.length === 1 ? '' : 's'} → governing…`));
  let captured = 0;
  for (const f of files) {
    const rel = relative(folder, f) || f;
    const content = readFileSync(f, 'utf8').slice(0, 200_000);
    const r = text(await client.callTool({
      name: 'brain_capture',
      arguments: { title: rel, content, category: 'reference', filePaths: [f] },
    }));
    if (r.ok) captured++;
    stdout.write(`\r  ${C.dim(`captured ${captured}/${files.length}`)}   `);
  }
  log('');
  const gov = text(await client.callTool({ name: 'brain_govern', arguments: {} }));
  const st = text(await client.callTool({ name: 'brain_status', arguments: {} }));
  await client.close();
  return { captured, gov, status: st };
}

// Resolve the ICO CLI: local sibling checkout first (built), then `ico` on PATH,
// then npx. Full-compile drives it with ICO_PROVIDER=deepseek.
function resolveIco() {
  const sibling = resolve(PLUGIN_ROOT, '..', 'bobs-big-brain-compiler', 'packages', 'cli', 'dist', 'index.js');
  if (process.env.GSB_ICO_CLI && existsSync(process.env.GSB_ICO_CLI)) {
    return { cmd: 'node', base: [process.env.GSB_ICO_CLI], label: process.env.GSB_ICO_CLI };
  }
  if (existsSync(sibling)) return { cmd: 'node', base: [sibling], label: '../bobs-big-brain-compiler (local)' };
  try {
    execFileSync('ico', ['--version'], { stdio: 'ignore' });
    return { cmd: 'ico', base: [], label: 'ico (PATH)' };
  } catch {
    return { cmd: 'npx', base: ['-y', 'intentional-cognition-os@^1.14.0'], label: 'npx intentional-cognition-os@^1.14.0' };
  }
}

// Full-compile path: ICO derives knowledge from the folder (6 passes, on DeepSeek),
// emits the spool, and brain_govern (the same in-process runtime) governs it.
async function fullCompile(folder, args) {
  const ico = resolveIco();
  const ws = join(args.base, 'ico-workspace');
  rmSync(ws, { recursive: true, force: true });
  const icoEnv = { ...process.env, ICO_PROVIDER: 'deepseek' }; // DEEPSEEK_API_KEY already in env
  const run = (a, opts = {}) =>
    execFileSync(ico.cmd, [...ico.base, ...a], { stdio: ['ignore', 'ignore', 'inherit'], env: icoEnv, ...opts });

  log('');
  log(C.dim(`  ICO via ${ico.label} — provider: deepseek`));
  log(C.dim('  ico init…'));
  run(['init', basename(ws), '--path', dirname(ws)]);
  log(C.dim('  ico mount + ingest…'));
  run(['--workspace', ws, 'mount', 'add', 'corpus', folder]);
  run(['--workspace', ws, 'ingest', folder, '--yes']);
  log(C.yellow('  ico compile all (6 passes — sending content to DeepSeek)…'));
  run(['--workspace', ws, 'compile', 'all'], { stdio: ['ignore', 'inherit', 'inherit'] });
  log(C.dim('  ico spool emit…'));
  run(['--workspace', ws, 'spool', 'emit', '--scope', 'all', '--tenant', args.tenant]);

  // Hand the compiled spool to the brain's spool dir, then govern via the bundled MCP server.
  const wsSpool = join(ws, 'spool');
  const brainSpool = join(args.base, 'spool');
  mkdirSync(brainSpool, { recursive: true });
  let moved = 0;
  if (existsSync(wsSpool)) {
    for (const f of readdirSync(wsSpool)) {
      if (f.startsWith('spool-') && f.endsWith('.jsonl')) {
        copyFileSync(join(wsSpool, f), join(brainSpool, f));
        moved++;
      }
    }
  }
  if (moved === 0) die('ICO compile produced no spool — nothing to govern (see the compile output above).');

  const transport = new StdioClientTransport({
    command: 'node',
    args: [BOOTSTRAP],
    env: installerChildEnv(args),
  });
  const client = new Client({ name: 'gsb-installer', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  const text = (r) => {
    try {
      return JSON.parse(r.content?.[0]?.text ?? '{}');
    } catch {
      return {};
    }
  };
  log(C.bold('  Governing the compiled spool…'));
  const gov = text(await client.callTool({ name: 'brain_govern', arguments: {} }));
  const status = text(await client.callTool({ name: 'brain_status', arguments: {} }));
  await client.close();
  return { captured: gov.ingested ?? 0, gov, status };
}

function hasClaude() {
  try { execFileSync('claude', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

// Register the bundled server with Claude Code via the official CLI. Idempotent:
// drop any prior registration at this scope, then add fresh with absolute paths
// (so the server resolves its vendored native dep + the brain we just built).
function registerMcp(args) {
  try { execFileSync('claude', ['mcp', 'remove', 'governed-brain', '-s', args.scope], { stdio: 'ignore' }); } catch {}
  try {
    execFileSync('claude', mcpRegistrationArgs(args, BOOTSTRAP), { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function printNextSteps(args, qmdOk, registered) {
  log('');
  log('  ' + C.green('✓ Brain built.') + ` ${C.dim(args.base)}`);
  log('  ' + C.dim(`qmd index: ${qmdIndexPath(args)}`));
  log('  ' + C.dim('─'.repeat(58)));
  if (registered) {
    log('  ' + C.green(`✓ MCP server 'governed-brain' registered with Claude Code`) + C.dim(` (scope: ${args.scope})`));
    log('  ' + C.dim('Start a new Claude Code session to load it.'));
    log('');
    log('  For the /brain and /brain-save skills too, install the full plugin:');
    log(C.cyan('    claude plugin marketplace add jeremylongshore/bobs-big-brain-plugin'));
    log(C.cyan('    claude plugin install governed-second-brain'));
  } else {
    log('  ' + C.yellow('Register the MCP server with Claude Code:'));
    log(C.cyan(`    claude ${mcpRegistrationArgs(args, BOOTSTRAP).map(shellQuote).join(' ')}`));
  }
  log('');
  log(C.bold('  Then try'));
  log(`    /brain ${C.dim('"<a few keywords from your notes>"')}        ${C.dim('→ a qmd://-cited answer')}`);
  log(`    /brain-save ${C.dim('"<a fact worth keeping>"')}            ${C.dim('→ governed capture + receipt')}`);
  if (!qmdOk) log('  ' + C.yellow('(repair the selected qmd configuration; native FTS alone may provide partial retrieval)'));
  log('');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._[0] !== 'init' || !args._[1]) {
    log('Usage: governed-second-brain init <folder> [--index-only] [--yes] [--clean] [--base <dir>] [--tenant <id>]');
    process.exit(args._[0] === 'init' ? 1 : 0);
  }
  const target = validateBrainTarget({
    home: homedir(), base: args.base, inputFolder: args._[1], clean: args.clean,
  });
  const folder = target.inputFolder;
  args.base = target.basePath;
  assertLocalInstallerMode(effectiveInstallerEnv(args), bootstrap);
  if (!existsSync(RUNTIME)) die(`bundled runtime missing at ${RUNTIME} — run "pnpm build" in the plugin repo first.`);

  // Full compile mode egresses to DeepSeek — require the key up front (fail fast, before consent).
  if (!args.indexOnly && !process.env.DEEPSEEK_API_KEY) {
    die(
      'full compile mode sends your file text to DeepSeek and needs DEEPSEEK_API_KEY.\n' +
        '    export DEEPSEEK_API_KEY=…   — or use --index-only for the zero-egress path.',
    );
  }

  const files = walkTextFiles(folder);
  if (files.length === 0) die(`no .md/.txt/.mdx files found under ${folder}`);

  if (!(await preflight(folder, args, files.length))) { log(C.dim('  aborted.')); process.exit(0); }

  // Local tool execution follows consent, before cleanup/provisioning/capture.
  const qmdOk = await checkQmd(args);

  // Recheck the original paths and existing directory identities after consent.
  // Use the validated canonical target, never the original alias spelling.
  const currentTarget = revalidateBrainTarget(target);
  if (args.clean && existsSync(currentTarget.basePath)) {
    log(C.dim(`  --clean: removing ${currentTarget.basePath}`));
    rmSync(currentTarget.basePath, { recursive: true, force: true });
  }

  ensureNativeDep();
  const { captured, gov, status } = args.indexOnly
    ? await buildBrain(folder, files, args)
    : await fullCompile(folder, args);

  log('  ' + C.dim('─'.repeat(58)));
  log(`  captured ${C.bold(captured)} · governed → ${C.green(`${gov.promoted ?? 0} promoted`)}, ` +
      `${gov.rejected ?? 0} rejected, ${gov.duplicates ?? 0} duplicate` +
      (gov.indexUpdated ? '' : C.yellow('  (index not refreshed — qmd?)')));
  log(`  brain now holds ${C.bold(status.total ?? 0)} governed memor${(status.total ?? 0) === 1 ? 'y' : 'ies'}`);

  let registered = false;
  if (args.register && hasClaude()) registered = registerMcp(args);
  printNextSteps(args, qmdOk, registered);
}

main().catch((e) => die(e?.stack || String(e)));
