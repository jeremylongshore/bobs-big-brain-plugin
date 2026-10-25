import { buildRecommendedPolicy } from '@qmd-team-intent-kb/policy-engine';
import type { PolicyRepository } from '@qmd-team-intent-kb/store';

/**
 * Seed the canonical recommended LOCAL governance policy once per fresh tenant.
 *
 * Reuse the Registrar builder so newly registered rules cannot silently remain
 * dormant in this seed. Enabled rules may reject, flag for review or place a
 * human hold; enablement is not a claim that every rule decides every capture.
 *
 * Any existing tenant policy, including disabled, custom or older policies,
 * suppresses seeding. This is not a migration or an operational policy apply.
 * The caller retains its existing best-effort handling of insertion failure;
 * this helper does not establish fail-closed governance after a seed error.
 *
 * @returns true if a policy was seeded, false if any tenant policy already existed.
 */
export function seedDefaultPolicy(policyRepo: PolicyRepository, tenantId: string): boolean {
  // Defensive: treat a missing/empty result as "no policy yet".
  const existing = policyRepo.findByTenant(tenantId);
  if (Array.isArray(existing) && existing.length > 0) return false;
  const policy = buildRecommendedPolicy(tenantId, new Date().toISOString());
  policyRepo.insert(policy);
  return true;
}
