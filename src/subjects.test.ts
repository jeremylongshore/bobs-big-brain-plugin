import { describe, expect, it } from 'vitest';
import {
  MAX_SUBJECTS,
  MAX_SUBJECT_LENGTH,
  SUBJECT_KEY_PATTERN,
  SUBJECTS_PARAM,
  validateSubjects,
} from './subjects.js';

describe('validateSubjects', () => {
  it('no subjects -> ok with nothing to send (undefined and empty alike)', () => {
    expect(validateSubjects(undefined)).toEqual({ ok: true, subjects: undefined });
    expect(validateSubjects([])).toEqual({ ok: true, subjects: undefined });
  });

  it('accepts valid slugs, preserving order', () => {
    expect(validateSubjects(['hosting.vps', 'deploy-pipeline', 'a', 'a1.b-2.c'])).toEqual({
      ok: true,
      subjects: ['hosting.vps', 'deploy-pipeline', 'a', 'a1.b-2.c'],
    });
  });

  it('collapses exact duplicates, first occurrence wins', () => {
    expect(validateSubjects(['b', 'a', 'b', 'a'])).toEqual({ ok: true, subjects: ['b', 'a'] });
  });

  it(`accepts exactly ${MAX_SUBJECTS} and rejects ${MAX_SUBJECTS + 1} with a count in the error`, () => {
    const eight = Array.from({ length: MAX_SUBJECTS }, (_, i) => `s-${i}`);
    expect(validateSubjects(eight).ok).toBe(true);
    const nine = [...eight, 's-8'];
    const r = validateSubjects(nine);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('at most 8');
      expect(r.error).toContain('got 9');
    }
  });

  it('counts the cap on the array as given, so 9 duplicates are rejected, not collapsed', () => {
    expect(validateSubjects(Array.from({ length: 9 }, () => 'same')).ok).toBe(false);
  });

  it(`accepts a ${MAX_SUBJECT_LENGTH}-char key and rejects ${MAX_SUBJECT_LENGTH + 1}`, () => {
    expect(validateSubjects(['a'.repeat(MAX_SUBJECT_LENGTH)]).ok).toBe(true);
    const r = validateSubjects(['a'.repeat(MAX_SUBJECT_LENGTH + 1)]);
    expect(r.ok).toBe(false);
    // The echo of an oversized value is truncated, never the full string.
    if (!r.ok) expect(r.error.length).toBeLessThan(400);
  });

  it.each([
    'Hosting.VPS',
    'has space',
    'trailing.',
    '.leading',
    '-leading',
    'double..dot',
    'under_score',
    'dot.-hyphen-lead',
    'ünïcode',
    '',
    ' hosting.vps',
    'hosting.vps\n',
  ])('rejects the invalid slug %j with an actionable error naming it', (bad) => {
    const r = validateSubjects(['ok.one', bad]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('not a valid subject key');
      expect(r.error).toContain('hosting.vps'); // the worked example
      expect(r.error).toContain(JSON.stringify(bad));
    }
  });

  it('never normalizes: an uppercase key is rejected, not lowercased', () => {
    expect(validateSubjects(['Hosting']).ok).toBe(false);
  });
});

describe('SUBJECT_KEY_PATTERN', () => {
  it('is the registrar SubjectKey regex verbatim', () => {
    expect(SUBJECT_KEY_PATTERN.source).toBe('^[a-z0-9][a-z0-9-]*(\\.[a-z0-9][a-z0-9-]*)*$');
  });
});

describe('SUBJECTS_PARAM (MCP boundary)', () => {
  it('is optional and loose: constraints are enforced in the handler, with clear errors', () => {
    expect(SUBJECTS_PARAM.safeParse(undefined).success).toBe(true);
    expect(SUBJECTS_PARAM.safeParse(['Anything Goes Here']).success).toBe(true);
    expect(SUBJECTS_PARAM.safeParse('not-an-array').success).toBe(false);
    expect(SUBJECTS_PARAM.safeParse([1]).success).toBe(false);
  });
});
