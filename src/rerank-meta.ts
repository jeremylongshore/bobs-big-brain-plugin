import type { CitedHitMetadata } from '@qmd-team-intent-kb/common';

/** The slice of a governed memory row the rerank needs. */
export interface RerankableMemory {
  category: string;
  updatedAt: string;
  title: string;
  lifecycle: string;
}

/**
 * Map a governed memory to the metadata `rerankCitedHits` consumes.
 *
 * `title` feeds the historical-record demotion and `lifecycle` feeds the
 * deprecated/archived demotion (registrar rerank-policy.ts, bead
 * compile-then-govern-39z.13). Without them the policy fails open and a
 * point-in-time AAR can outrank the current decision memory.
 */
export function toCitedHitMetadata(m: RerankableMemory): CitedHitMetadata {
  return { category: m.category, updatedAt: m.updatedAt, title: m.title, lifecycle: m.lifecycle };
}
