/** Fixed owned-qmd recovery maintenance; caller retains the shared brain flock. */
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type Database from "better-sqlite3";
import {
  RealQmdExecutor,
  getExportableCollections,
  inspectRecoveryQmdRegistry,
  verifyRecoveryQmdRegistry,
  assertRecoveryQmdRegistryBinding,
  type RecoveryQmdRegistryOptions,
  type RecoveryQmdRegistryInspection,
  type QmdCommandProvenance,
} from "@qmd-team-intent-kb/qmd-adapter";
import { verifyRecoveryExportDocuments } from "./recovery-export.js";
import { verifyRecoveryIndexDocuments } from "./recovery-index-documents.js";

export interface RecoveryIndexSummary {
  indexVerified: true;
  verifiedDocuments: number;
  command: QmdCommandProvenance;
}

function preserveSetupBindings(
  before: RecoveryQmdRegistryInspection,
  after: RecoveryQmdRegistryInspection,
): void {
  if (!isDeepStrictEqual(before.command, after.command))
    throw new Error("Recovery qmd command binding changed");
  for (const [path, identity] of Object.entries(before.bindings)) {
    // A collection addition rewrites the YAML. It may not replace existing authority dirs/index.
    if (
      path !== before.registryPath &&
      !isDeepStrictEqual(identity, after.bindings[path])
    )
      throw new Error("Recovery qmd setup path changed");
  }
}

/** Existing private tenant root and canonical five source dirs are explicit prerequisites. */
export async function refreshRecoveryIndex(
  database: Database.Database,
  options: Omit<RecoveryQmdRegistryOptions, "allowPartial">,
  assertStillBound: () => void,
): Promise<RecoveryIndexSummary> {
  const fixed = structuredClone(options);
  const documents = () =>
    verifyRecoveryExportDocuments(database, fixed, assertStillBound);
  const expected = documents();
  let registry = inspectRecoveryQmdRegistry({ ...fixed, allowPartial: true });
  if (registry.bindings[registry.indexPath] !== undefined)
    verifyRecoveryIndexDocuments(registry.indexPath, fixed.tenantId);
  const executor = new RealQmdExecutor({
    ownedRuntime: fixed.qmdRuntime,
    tenant: { id: fixed.tenantId, basePath: fixed.basePath },
  });
  const execute = async (args: string[]) => {
    assertStillBound();
    const result = await executor.execute(args);
    assertStillBound();
    if (
      result.exitCode !== 0 ||
      result.failure !== undefined ||
      !isDeepStrictEqual(executor.commandProvenance, registry.command)
    )
      throw new Error("Selected recovery qmd maintenance failed");
  };
  for (const definition of getExportableCollections()) {
    const before = inspectRecoveryQmdRegistry({ ...fixed, allowPartial: true });
    assertRecoveryQmdRegistryBinding(registry, before);
    if (before.collections.includes(definition.name)) continue;
    if (!isDeepStrictEqual(expected, documents()))
      throw new Error("Recovery export changed before indexing");
    await execute([
      "collection",
      "add",
      join(fixed.exportDir, definition.sourceSubdir),
      "--name",
      definition.name,
    ]);
    const after = inspectRecoveryQmdRegistry({ ...fixed, allowPartial: true });
    preserveSetupBindings(before, after);
    verifyRecoveryIndexDocuments(after.indexPath, fixed.tenantId);
    registry = after;
  }
  assertStillBound();
  registry = await verifyRecoveryQmdRegistry(fixed, registry);
  assertStillBound();
  if (!isDeepStrictEqual(expected, documents()))
    throw new Error("Recovery export changed before update");
  await execute(["update"]);
  const after = await verifyRecoveryQmdRegistry(fixed, registry);
  assertStillBound();
  const verifiedDocuments = verifyRecoveryIndexDocuments(
    after.indexPath,
    fixed.tenantId,
    expected,
  );
  if (!isDeepStrictEqual(expected, documents()))
    throw new Error("Recovery export changed after update");
  assertRecoveryQmdRegistryBinding(after, inspectRecoveryQmdRegistry(fixed));
  assertStillBound();
  return { indexVerified: true, verifiedDocuments, command: after.command };
}
