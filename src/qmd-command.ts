import { isAbsolute } from 'node:path';
import type {
  CommandResult,
  OwnedQmdRuntime,
  QmdCommandProvenance,
  ResolvedQmdBinary,
} from '@qmd-team-intent-kb/qmd-adapter';

export interface LocalQmdBindingOptions {
  tenantId: string;
  basePath: string;
  exportDir: string;
  qmdBinary?: string;
  qmdRuntime?: OwnedQmdRuntime;
}

// No MCP entrypoint import. No selection, filesystem setup, provisioning or
// process start on import. Real exports are loaded only for an explicit call.
const loadRegistrar = () => import('@qmd-team-intent-kb/qmd-adapter');

export async function createLocalQmdBinding(options: LocalQmdBindingOptions) {
  const { RealQmdExecutor, QmdAdapter, getDefaultDenseConfig } = await loadRegistrar();
  const executor = new RealQmdExecutor({
    binary: options.qmdBinary,
    ownedRuntime: options.qmdRuntime,
    tenant: { id: options.tenantId, basePath: options.basePath },
    // Preserve registrar defaults: interactive 30s; maintenance env/default600s.
  });
  const adapter = new QmdAdapter(
    {
      tenantId: options.tenantId,
      basePath: options.basePath,
      exportDir: options.exportDir,
      dense: getDefaultDenseConfig(),
    },
    executor,
  );
  return { adapter, provenance: () => executor.commandProvenance };
}

export interface LocalQmdCheck {
  result: CommandResult;
  provenance: QmdCommandProvenance | null;
}

/** Caller may start the same 5s deadline before requiring the compiled helper. */
export async function checkLocalQmd(
  options: LocalQmdBindingOptions,
  deadline = Date.now() + 5_000,
): Promise<LocalQmdCheck> {
  const { RealQmdExecutor, getQmdTenantEnv, withQmdTenantSelector } = await loadRegistrar();
  const tenantEnv = getQmdTenantEnv(options.tenantId, options.basePath);
  const args = withQmdTenantSelector(['--version']);
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return {
      result: {
        stdout: '',
        stderr: 'qmd availability exhausted its original 5s deadline',
        exitCode: 124,
      },
      provenance: null,
    };
  }
  const executor = new RealQmdExecutor({
    binary: options.qmdBinary,
    ownedRuntime: options.qmdRuntime,
    // Availability must not create a missing brain before consent/revalidation.
    // Reuse the public pure path/selector helpers, with no executor tenant
    // directory preparation for this version-only operation.
    env: tenantEnv,
    timeout: remaining,
  });
  const result = await executor.execute(args);
  return { result, provenance: executor.commandProvenance };
}

/** Preserve the old receipt only when it can represent the selected command. */
export function legacyQmdBinary(
  provenance: QmdCommandProvenance | null,
): ResolvedQmdBinary | undefined {
  if (
    !provenance ||
    provenance.source === 'owned' ||
    provenance.prefix.length !== 0 ||
    !isAbsolute(provenance.executable)
  )
    return undefined;
  return { path: provenance.executable, source: provenance.source };
}
