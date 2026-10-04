/**
 * Subject keys for `brain_capture` (subject-keyed supersession, registrar PR #357).
 *
 * A captured decision can declare WHAT it is about (`metadata.subjects`); when it
 * is later promoted, the registrar's `planSupersession` retires every active
 * same-tenant memory sharing one of those keys. Keys are compared by exact
 * equality, so they are validated strictly and NEVER normalized — a typo'd key
 * silently supersedes nothing, which is why a bad one is an error here.
 *
 * DEPENDENCY-FREE on purpose (CLAUDE.md rule 1): imported by BOTH modes, and team
 * mode may not pull `@qmd-team-intent-kb/*`. The two constants below mirror
 * `SubjectKey` + `ContentMetadata.subjects` in the registrar's
 * `packages/schema/src/common.ts`. Drift is guarded twice: local mode re-validates
 * the built candidate against the registrar's own `ContentMetadata` before it
 * touches the spool, and `scripts/subjects-conformance.test.mjs` compares this
 * mirror with the real schema on a corpus (runs where the sibling is provisioned).
 */

import { z } from 'zod';

/**
 * The `subjects` tool parameter, shared by both modes' `brain_capture`.
 *
 * Deliberately a LOOSE `string[]` at the MCP boundary: the constraints are
 * enforced by {@link validateSubjects} inside the handler so a violation comes
 * back as a clear `{ ok: false, error }` naming the offending key, instead of the
 * SDK's generic input-validation error.
 */
export const SUBJECTS_PARAM = z
  .array(z.string())
  .optional()
  .describe(
    'Optional subject keys this memory is authoritative for, so it can supersede older memories about the same subject once promoted. At most 8; each a lowercase dot/hyphen slug such as "hosting.vps" (max 96 chars). Exact-match identities, not tags: only declare subjects you are the current source of truth for.',
  );

/** Max subject keys per capture — mirrors `ContentMetadata.subjects.max(8)`. */
export const MAX_SUBJECTS = 8;
/** Max length of one key — mirrors `SubjectKey.max(96)`. */
export const MAX_SUBJECT_LENGTH = 96;
/** Lowercase dot/hyphen slug — mirrors the `SubjectKey` regex verbatim. */
export const SUBJECT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;

export type SubjectsResult =
  | { ok: true; subjects: string[] | undefined }
  | { ok: false; error: string };

/** Echo a rejected value without letting a huge string blow up the error. */
function show(value: string): string {
  const v = value.length > 40 ? `${value.slice(0, 40)}...` : value;
  return JSON.stringify(v);
}

/**
 * Validate the optional `subjects` argument of `brain_capture`.
 *
 * - `undefined` / empty array -> `{ ok: true, subjects: undefined }` (no key sent;
 *   byte-identical to a pre-subjects capture).
 * - more than {@link MAX_SUBJECTS} entries (counted as given, before de-dupe) or
 *   any key that is not a valid slug -> `{ ok: false, error }` naming the problem
 *   and how to fix it. Nothing is captured.
 * - exact duplicates collapse, first occurrence wins, order preserved.
 */
export function validateSubjects(raw: readonly string[] | undefined): SubjectsResult {
  if (raw === undefined || raw.length === 0) return { ok: true, subjects: undefined };
  if (raw.length > MAX_SUBJECTS) {
    return {
      ok: false,
      error: `subjects: at most ${MAX_SUBJECTS} subject keys are allowed per capture (got ${raw.length}). Keep only the subjects this memory is authoritative for.`,
    };
  }
  for (const key of raw) {
    if (key.length > MAX_SUBJECT_LENGTH || !SUBJECT_KEY_PATTERN.test(key)) {
      return {
        ok: false,
        error: `subjects: ${show(key)} is not a valid subject key. Use a lowercase dot/hyphen slug of at most ${MAX_SUBJECT_LENGTH} characters, e.g. "hosting.vps" or "deploy-pipeline" (letters a-z, digits, "-", and "." between segments; no spaces, uppercase, or leading/trailing separators).`,
      };
    }
  }
  return { ok: true, subjects: [...new Set(raw)] };
}
