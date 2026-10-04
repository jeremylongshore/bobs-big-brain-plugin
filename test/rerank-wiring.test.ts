import { describe, it, expect } from 'vitest';
import { rerankCitedHits } from '@qmd-team-intent-kb/common';
import { toCitedHitMetadata, type RerankableMemory } from '../src/rerank-meta.js';

const NOW = '2026-10-04T12:00:00.000Z';

// Raw fused scores mirror the live regression (2026-10-03): the point-in-time records
// out-scored the current decision because they repeat the query terms more often.
const store: Record<string, RerankableMemory> = {
  decision: {
    category: 'decision',
    updatedAt: NOW,
    title: 'GCP fully exited: estate torn down 2026-07-09, all hosting on the Contabo VPS',
    lifecycle: 'active',
  },
  aar: {
    category: 'reference',
    updatedAt: NOW,
    title: 'Phase 19 AAR - Terraform and Vertex AI Agent Engine',
    lifecycle: 'active',
  },
  audit: {
    category: 'reference',
    updatedAt: NOW,
    title: 'WIF and GitHub Actions Dev Audit',
    lifecycle: 'active',
  },
  retired: {
    category: 'reference',
    updatedAt: NOW,
    title: 'Terraform Setup',
    lifecycle: 'deprecated',
  },
};

const hits = [
  { file: 'qmd://kb-guides/aar.md', score: 1.0 },
  { file: 'qmd://kb-guides/audit.md', score: 0.98 },
  { file: 'qmd://kb-guides/retired.md', score: 0.97 },
  { file: 'qmd://kb-decisions/decision.md', score: 0.72 },
];

const resolve = (id: string) => (store[id] ? toCitedHitMetadata(store[id]) : null);
const order = (r: Array<{ file: string }>) => r.map((h) => h.file.split('/').pop()!.replace('.md', ''));

describe('local search rerank wiring', () => {
  it('maps title and lifecycle through to the rerank metadata', () => {
    expect(toCitedHitMetadata(store.decision)).toEqual({
      category: 'decision',
      updatedAt: NOW,
      title: store.decision.title,
      lifecycle: 'active',
    });
  });

  it('puts the current decision first when the query is not asking for history', () => {
    const ranked = rerankCitedHits(hits, resolve, NOW, undefined, { query: 'gcp exodus' });
    expect(order(ranked)[0]).toBe('decision');
  });

  it('demotes a deprecated memory below active hits', () => {
    const ranked = order(rerankCitedHits(hits, resolve, NOW, undefined, { query: 'terraform setup' }));
    expect(ranked.indexOf('retired')).toBeGreaterThan(ranked.indexOf('decision'));
  });

  it('keeps the historical record on top when the query asks for history', () => {
    const ranked = rerankCitedHits(hits, resolve, NOW, undefined, { query: 'gcp exodus aar what happened' });
    expect(order(ranked)[0]).toBe('aar');
  });

  it('without the query (the pre-fix wiring) the AAR still wins, which is the bug this guards', () => {
    const preFix = rerankCitedHits(
      hits,
      (id) => (store[id] ? { category: store[id].category, updatedAt: store[id].updatedAt } : null),
      NOW,
    );
    expect(order(preFix)[0]).toBe('aar');
  });

  it('fails open when a hit cannot be resolved (no demotion, no throw)', () => {
    const ranked = rerankCitedHits([{ file: 'qmd://kb-guides/unknown.md', score: 0.5 }], resolve, NOW, undefined, {
      query: 'gcp exodus',
    });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].memoryId).toBeNull();
  });
});
