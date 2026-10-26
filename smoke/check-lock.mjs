#!/usr/bin/env node
/**
 * Lockfile drift guard. The validate-plugin gate once caught the npm package at
 * 0.1.3 while the plugin manifests sat at 0.1.0 — this makes that class of drift
 * a CI failure instead of a silent surprise. gsb.lock.json owns the known-good
 * tuple; here we assert it stays consistent with the package it ships in.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const at = (rel) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url))));
const lock = at('../gsb.lock.json');
const pkg = at('../package.json');
const mcp = at('../.mcp.json');
const plugin = at('../.claude-plugin/plugin.json');
const market = at('../.claude-plugin/marketplace.json');

let bad = 0;
const eq = (a, b, msg) => {
  const good = a === b;
  console.log(`${good ? '✓' : '✗'} ${msg}${good ? '' : ` (${a} != ${b})`}`);
  if (!good) bad += 1;
};

eq(lock.stack.plugin.name, pkg.name, 'gsb.lock plugin name == package.json name');
eq(lock.stack.plugin.version, pkg.version, 'gsb.lock plugin version == package.json version');
eq(plugin.version, pkg.version, 'plugin.json version == package.json version');
eq(market.plugins[0].version, pkg.version, 'marketplace.json plugin version == package.json version');
eq(mcp.mcpServers['governed-brain'].version, pkg.version, '.mcp.json server version == package.json version');
eq(
  typeof lock.stack.govern.commit === 'string' && /^[a-f0-9]{40}$/.test(lock.stack.govern.commit),
  true,
  'gsb.lock records a full registrar source revision',
);
for (const [file, digest, label] of [
  ['governed-brain.cjs', lock.stack.govern.bundleSha256, 'runtime bundle'],
  ['qmd-command.cjs', lock.stack.govern.qmdCommandHelperSha256, 'qmd command helper'],
  ['local-review.cjs', lock.stack.govern.localReviewHelperSha256, 'local review helper'],
  ['local-recovery.cjs', lock.stack.govern.localRecoveryHelperSha256, 'local recovery helper'],
]) {
  try {
    const hash = createHash('sha256')
      .update(readFileSync(new URL(`../plugin-runtime/${file}`, import.meta.url)))
      .digest('hex');
    eq(digest, hash, `${label} SHA-256 == gsb.lock`);
  } catch (error) {
    console.error(`✗ Cannot read ${label}: ${error.message}`);
    bad += 1;
  }
}

console.log(bad === 0 ? '\nLOCK OK' : `\nLOCK DRIFT (${bad} mismatch(es))`);
process.exit(bad === 0 ? 0 : 1);
