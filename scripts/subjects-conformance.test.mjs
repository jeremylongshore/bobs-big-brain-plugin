/**
 * Conformance: the plugin's dependency-free subject validator (src/subjects.ts,
 * shared by both modes) must agree with the registrar's real schema
 * (`SubjectKey` + `ContentMetadata.subjects`, packages/schema/src/common.ts) on
 * every input. Team mode may not import the schema, so it carries a mirror; this
 * test is what stops that mirror silently drifting.
 *
 * `node --test scripts/subjects-conformance.test.mjs` — needs the sibling registrar
 * checked out + built and the plugin pnpm-installed (the anchor-conformance CI job
 * provisions exactly that). src/subjects.ts is esbuild-transpiled to a throwaway
 * .mjs inside the repo tree so it resolves the repo's node_modules.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { ContentMetadata } from '@qmd-team-intent-kb/schema';

// SubjectKey itself is not re-exported from the schema index; the array element of
// ContentMetadata.subjects IS that schema, so test through the public surface.
const SubjectKey = ContentMetadata.shape.subjects.unwrap().element;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let tmp;
let mod;

before(async () => {
  tmp = mkdtempSync(join(REPO_ROOT, 'scripts', '.subjects-'));
  const outfile = join(tmp, 'subjects.mjs');
  await build({
    entryPoints: [join(REPO_ROOT, 'src', 'subjects.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  });
  mod = await import(`file://${outfile}`);
});
after(() => tmp && rmSync(tmp, { recursive: true, force: true }));

const CORPUS = [
  'a',
  '0',
  'hosting.vps',
  'deploy-pipeline',
  'a1.b-2.c3',
  'a-',
  'a.b.c.d.e.f',
  'a'.repeat(96),
  'a'.repeat(97),
  '',
  ' ',
  'A',
  'Hosting.VPS',
  '.a',
  'a.',
  'a..b',
  '-a',
  'a_b',
  'a b',
  'a\n',
  '\na',
  'a.-b',
  'a-.b',
  'é',
  'a/b',
  'a:b',
  '1.2.3',
  '9-9',
];

test('single-key verdict matches the registrar SubjectKey on a corpus', () => {
  for (const key of CORPUS) {
    const mirror = mod.validateSubjects([key]).ok;
    const real = SubjectKey.safeParse(key).success;
    assert.equal(mirror, real, `verdict differs for ${JSON.stringify(key)} (mirror=${mirror}, real=${real})`);
  }
});

test('single-key verdict matches on pseudo-random strings over the interesting alphabet', () => {
  const alphabet = ['a', 'z', '0', '9', '-', '.', '_', 'A', ' ', 'é'];
  let seed = 1234567;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < 3000; i++) {
    const len = 1 + (next() % 9);
    let s = '';
    for (let j = 0; j < len; j++) s += alphabet[next() % alphabet.length];
    assert.equal(
      mod.validateSubjects([s]).ok,
      SubjectKey.safeParse(s).success,
      `verdict differs for ${JSON.stringify(s)}`,
    );
  }
});

test('the 8-key cap and the length cap are the registrar constants', () => {
  assert.equal(mod.MAX_SUBJECTS, 8);
  assert.equal(mod.MAX_SUBJECT_LENGTH, 96);
  const nine = Array.from({ length: 9 }, (_, i) => `s-${i}`);
  const eight = nine.slice(0, 8);
  assert.equal(ContentMetadata.safeParse({ subjects: nine }).success, false);
  assert.equal(ContentMetadata.safeParse({ subjects: eight }).success, true);
  assert.equal(mod.validateSubjects(nine).ok, false);
  assert.equal(mod.validateSubjects(eight).ok, true);
});

test('whatever the mirror accepts, the registrar ContentMetadata accepts verbatim', () => {
  const r = mod.validateSubjects(['hosting.vps', 'deploy-pipeline', 'hosting.vps']);
  assert.equal(r.ok, true);
  const parsed = ContentMetadata.safeParse({ filePaths: [], tags: [], subjects: r.subjects });
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data.subjects, ['hosting.vps', 'deploy-pipeline']);
});
