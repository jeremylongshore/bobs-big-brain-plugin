/** Fixed local recovery composition. Importing this module performs no maintenance. */
import { isAbsolute, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  executeRecoveryEnvelope,
  type RecoveryExecutionRequest,
  type RecoveryExecutionResult,
  type RecoveryPostcommitContext,
} from "@qmd-team-intent-kb/curator";
import { AuditRepository } from "@qmd-team-intent-kb/store";
import { assertRecoveryAuditReadiness } from "./recovery-audit.js";
import {
  getQmdTenantIndexPath,
  inspectRecoveryQmdRegistry,
  assertRecoveryQmdRegistryBinding,
  verifyRecoveryQmdRegistry,
  type OwnedQmdRuntime,
} from "@qmd-team-intent-kb/qmd-adapter";
import {
  anchorRecoveryHead,
  type RecoveryAnchorOptions,
  type RecoveryAnchorSummary,
} from "./recovery-anchor.js";
import {
  inspectRecoveryExportRoot,
  reconcileRecoveryExport,
  verifyRecoveryExportDocuments,
  type RecoveryExportSummary,
} from "./recovery-export.js";
import {
  refreshRecoveryIndex,
  type RecoveryIndexSummary,
} from "./recovery-index.js";
import { verifyRecoveryIndexDocuments } from "./recovery-index-documents.js";

export interface RecoveryMaintenanceOptions extends RecoveryAnchorOptions {
  sourceExportDir: string;
  targetExportDir: string;
  qmdRuntime: OwnedQmdRuntime;
}
export interface RecoveryTenantMaintenance {
  tenantId: string;
  export: RecoveryExportSummary;
  index?: RecoveryIndexSummary;
}
export interface RecoveryMaintenanceSummary {
  complete: boolean;
  anchor: RecoveryAnchorSummary;
  tenants: RecoveryTenantMaintenance[];
}
type WithCompletion<T> = T extends unknown
  ? Omit<T, "recoveryComplete"> & { recoveryComplete: boolean }
  : never;
export type RecoveryMaintenanceResult = WithCompletion<
  RecoveryExecutionResult<RecoveryMaintenanceSummary>
>;

function overlaps(a: string, b: string): boolean {
  const within = relative(a, b);
  return (
    within === "" ||
    (!isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`))
  );
}

async function maintain(
  context: RecoveryPostcommitContext,
  options: RecoveryMaintenanceOptions,
): Promise<RecoveryMaintenanceSummary> {
  const tenants = [
    { tenantId: context.sourceTenantId, exportDir: options.sourceExportDir },
    { tenantId: context.targetTenantId, exportDir: options.targetExportDir },
  ];
  if (context.sourceTenantId === context.targetTenantId)
    throw new Error("Recovery tenants must differ");
  const roots = tenants.map((tenant) => ({
    path: tenant.exportDir,
    identity: inspectRecoveryExportRoot(tenant.exportDir),
  }));
  const protectedPaths = [
    join(context.store.basePath, "audit"),
    join(context.store.basePath, "spool"),
    context.store.databasePath,
    options.qmdRuntime.root,
    ...tenants.map((tenant) =>
      getQmdTenantIndexPath(tenant.tenantId, context.store.basePath),
    ),
  ];
  if (
    overlaps(roots[0].path, roots[1].path) ||
    overlaps(roots[1].path, roots[0].path) ||
    roots.some(({ path }) =>
      protectedPaths.some(
        (protectedPath) =>
          overlaps(path, protectedPath) || overlaps(protectedPath, path),
      ),
    )
  )
    throw new Error("Recovery export and authority roots overlap");
  const indexRoots = tenants.map((tenant) => {
    const path = getQmdTenantIndexPath(tenant.tenantId, context.store.basePath);
    return { path, identity: inspectRecoveryExportRoot(path) };
  });
  const bound = () => {
    context.assertStillBound();
    for (const root of [...roots, ...indexRoots]) {
      if (
        !isDeepStrictEqual(root.identity, inspectRecoveryExportRoot(root.path))
      )
        throw new Error("Recovery export authority root changed");
    }
  };
  const registryOptions = tenants.map((tenant) => ({
    ...tenant,
    basePath: context.store.basePath,
    qmdRuntime: options.qmdRuntime,
  }));
  bound();
  // Every selected registry is inspected before the first maintenance write.
  const registries = registryOptions.map((binding) =>
    inspectRecoveryQmdRegistry({ ...binding, allowPartial: true }),
  );
  const anchor = anchorRecoveryHead(
    { ...context, assertStillBound: bound },
    options,
  );
  const summaries: RecoveryTenantMaintenance[] = [];
  for (const tenant of tenants) {
    bound();
    summaries.push({
      tenantId: tenant.tenantId,
      export: reconcileRecoveryExport(context.database, tenant, bound),
    });
  }
  if (summaries.some((tenant) => !tenant.export.complete))
    return { complete: false, anchor, tenants: summaries };
  for (let i = 0; i < tenants.length; i++) {
    bound();
    assertRecoveryQmdRegistryBinding(
      registries[i],
      inspectRecoveryQmdRegistry({ ...registryOptions[i], allowPartial: true }),
    );
    summaries[i].index = await refreshRecoveryIndex(
      context.database,
      registryOptions[i],
      bound,
    );
    registries[i] = inspectRecoveryQmdRegistry(registryOptions[i]);
  }
  // Re-prove the first tenant after maintenance of the second, under the same lock.
  for (let i = 0; i < tenants.length; i++) {
    bound();
    const registry = await verifyRecoveryQmdRegistry(
      registryOptions[i],
      registries[i],
    );
    bound();
    const documents = verifyRecoveryExportDocuments(
      context.database,
      tenants[i],
      bound,
    );
    const verified = verifyRecoveryIndexDocuments(
      registry.indexPath,
      tenants[i].tenantId,
      documents,
    );
    if (verified !== summaries[i].index?.verifiedDocuments)
      throw new Error("Recovery document denominator changed");
  }
  const chained = new AuditRepository(context.database)
    .findAllChronological()
    .filter((row) => row.entry_hash !== null);
  if (
    chained.length !== anchor.chainedRows ||
    chained.at(-1)?.entry_hash !== anchor.chainHead
  )
    throw new Error("Recovery global chain changed during maintenance");
  const final = anchorRecoveryHead(
    { ...context, assertStillBound: bound },
    options,
  );
  if (final.gitHead !== anchor.gitHead || final.chainHead !== anchor.chainHead)
    throw new Error("Recovery anchor witness changed during maintenance");
  bound();
  return {
    complete: context.status.state === "complete",
    anchor,
    tenants: summaries,
  };
}

/** Apply replay stays unverified; explicit repair rechecks derived state without governance. */
export async function executeRecoveryMaintenance(
  request: RecoveryExecutionRequest,
  options: RecoveryMaintenanceOptions,
): Promise<RecoveryMaintenanceResult> {
  if (
    process.platform !== "linux" ||
    Number(process.versions.node.split(".")[0]) !== 22
  )
    throw new Error("Local recovery maintenance requires Linux Node22");
  const fixedRequest = structuredClone(request);
  const fixedOptions = structuredClone(options);
  if (
    typeof fixedOptions?.sourceExportDir !== "string" ||
    typeof fixedOptions.targetExportDir !== "string" ||
    fixedOptions.qmdRuntime === undefined
  )
    throw new Error("Explicit recovery maintenance bindings required");
  const result = await executeRecoveryEnvelope(
    fixedRequest,
    (context) => maintain(context, fixedOptions),
    (context) => assertRecoveryAuditReadiness(context, fixedOptions),
  );
  return {
    ...result,
    recoveryComplete:
      result.ok &&
      result.postcommit.state === "completed" &&
      result.postcommit.value.complete,
  };
}
