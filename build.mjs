// Bundle the unified governed-brain MCP server into a single self-contained .cjs.
//
// The entry is the mode dispatcher (src/index.ts): it dynamic-imports the local
// in-process server OR the remote (team) proxy by TEAMKB_API_URL. esbuild inlines
// both modules (CJS, no splitting) into ONE file, lazily — at runtime only the
// selected mode's module initializes, so team mode never touches better-sqlite3.
//
// Everything is inlined EXCEPT the native modules (better-sqlite3, which ships a
// compiled .node addon and cannot be bundled, and fs-ext, the flock(2) wrapper the
// local-mode write lock uses to serialize against the cron's /usr/bin/flock) plus
// better-sqlite3's 'bindings' loader.
// ajv/ajv-formats (pulled in transitively by the MCP SDK and used to validate
// every tool call at runtime) MUST stay bundled — externalizing them makes the
// runtime inert. zod is aliased to a single copy so the MCP SDK and our tool
// schemas share one zod instance (cross-instance `instanceof` checks otherwise
// fail and break tool registration/validation).
import esbuild from 'esbuild';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { 'bundle-only': { type: 'boolean', default: false } },
  strict: true,
  allowPositionals: false,
});

const require = createRequire(import.meta.url);
const registrarRoot = fileURLToPath(new URL('../bobs-big-brain-registrar/', import.meta.url));
const registrarGit = (...args) =>
  execFileSync('git', ['-C', registrarRoot, ...args], { encoding: 'utf8' }).trim();
const assertCleanRegistrar = () => {
  if (registrarGit('status', '--porcelain', '--untracked-files=normal') !== '') {
    throw new Error('Registrar has uncommitted changes; use a clean checkout before recording bundle provenance.');
  }
};

assertCleanRegistrar();
const registrarCommit = registrarGit('rev-parse', 'HEAD');
const registrarVersion = JSON.parse(readFileSync(join(registrarRoot, 'package.json'), 'utf8')).version;
// The bundle consumes compiled JS. Refresh it from the recorded source revision,
// rather than stamping a new revision onto a stale dist/ tree.
execFileSync('pnpm', ['build', '--force'], { cwd: registrarRoot, stdio: 'inherit' });

let zodAlias;
try {
  zodAlias = dirname(require.resolve('zod/package.json'));
} catch {
  zodAlias = require.resolve('zod');
}

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'plugin-runtime/governed-brain.cjs',
  external: ['better-sqlite3', 'bindings', 'fs-ext', 'sqlite-vec'],
  alias: { zod: zodAlias },
  logLevel: 'info',
});

console.error('✓ bundled → plugin-runtime/governed-brain.cjs');

// Install the externalized native modules INTO plugin-runtime/node_modules so the
// runtime is SELF-CONTAINED. The three externals (better-sqlite3 + its 'bindings'
// loader, and fs-ext) ship compiled .node addons that esbuild cannot inline; if the
// runtime relies on the repo's parent node_modules, a copied/marketplace plugin-runtime/
// (no parent) fails in LOCAL mode with "better-sqlite3 not built for this machine".
// Installing here builds them for the current host ABI; other hosts need their own
// compatible native dependencies.
// (TEAM mode never imports sqlite, so this only matters for local/personal-brain use.)
if (values['bundle-only']) {
  console.error('→ bundle-only: native dependencies were not provisioned or verified by this build');
} else {
  console.error('→ installing self-contained runtime natives (plugin-runtime)…');
  try {
    execSync('npm install --omit=dev --no-audit --no-fund --loglevel=error', {
      cwd: 'plugin-runtime',
      stdio: 'inherit',
    });
  } catch {
    // better-sqlite3/fs-ext ship prebuilt binaries for common platforms; if none
    // matched, npm falls back to compiling from source (node-gyp) — which needs
    // system build tools. Fail with an actionable message instead of a raw stack.
    console.error('\n❌ Failed to install/compile plugin-runtime native deps (better-sqlite3, fs-ext).');
    console.error('   If no prebuilt binary matched this platform, building from source needs system');
    console.error('   build tools (Python, make, a C/C++ compiler, or VS Build Tools). Install them and');
    console.error('   re-run `npm run build`.');
    process.exit(1);
  }
  console.error('✓ plugin-runtime is self-contained (better-sqlite3, bindings, fs-ext, sqlite-vec)');
}

assertCleanRegistrar();
if (registrarGit('rev-parse', 'HEAD') !== registrarCommit) {
  throw new Error('Registrar revision changed during the build; rebuild before recording provenance.');
}
const lockPath = new URL('./gsb.lock.json', import.meta.url);
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
lock.stack.govern.version = registrarVersion;
lock.stack.govern.commit = registrarCommit;
lock.stack.govern.bundleSha256 = createHash('sha256')
  .update(readFileSync(new URL('./plugin-runtime/governed-brain.cjs', import.meta.url)))
  .digest('hex');
// Preserve the lockfile's existing ASCII JSON representation.
const lockJson = JSON.stringify(lock, null, 2)
  .replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
writeFileSync(lockPath, `${lockJson}\n`);
console.error(`✓ recorded registrar ${registrarCommit} and bundle SHA-256 in gsb.lock.json`);
