import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { revalidateBrainTarget, validateBrainTarget } from './installer-paths.mjs';

/** @typedef {ReturnType<typeof validateBrainTarget>} Target */
/** @typedef {{path: string, device: number, inode: number}} Identity */

/** @param {Identity | undefined} left @param {Identity | undefined} right */
function sameIdentity(left, right) {
  return (
    left !== undefined &&
    right !== undefined &&
    Number.isSafeInteger(right.device) &&
    Number.isSafeInteger(right.inode) &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

/**
 * Retain the old brain through the Linux descriptor-relative helper. This never
 * recursively deletes data. The post-checks protect the handoff to provisioning;
 * they do not make later pathname-based capture writes an atomic transaction.
 * @param {Target} previous
 */
export function prepareCleanBrain(previous) {
  const target = revalidateBrainTarget(previous);
  if (!target.request.clean)
    throw new Error('Cleanup requires an explicitly validated --clean plan.');
  if (target.missing.length > 0) return { status: 'absent', target, backupPath: null };
  if (process.platform !== 'linux') {
    throw new Error(
      '--clean of an existing brain requires Linux and /usr/bin/python3; no data moved.',
    );
  }

  const recovery = `Old data is not recursively deleted. Inspect backups beside ${dirname(target.basePath)} before retrying.`;
  const child = spawnSync(
    '/usr/bin/python3',
    ['-I', '-S', '-B', fileURLToPath(new URL('./installer-cleanup.py', import.meta.url))],
    {
      input: JSON.stringify(target),
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      timeout: 10_000,
      killSignal: 'SIGKILL',
      maxBuffer: 128 * 1024,
    },
  );
  if (child.error || child.signal) {
    throw new Error(
      `Cleanup could not complete: ${child.error?.message ?? child.signal}. ${recovery}`,
    );
  }
  let result;
  try {
    result = JSON.parse(child.stdout);
  } catch {
    throw new Error(`Cleanup did not return a valid recovery result. ${recovery}`);
  }
  if (child.status !== 0 || result?.status !== 'retained') {
    throw new Error(
      `Cleanup refused: ${String(result?.reason ?? (child.stderr.trim() || 'unknown result'))}. ` +
        `Recovery result: ${JSON.stringify({ recovery: result?.recovery, pathWitnessStatus: result?.pathWitnessStatus, backupPath: result?.backupPath, quarantinePath: result?.quarantinePath, originalCurrentPath: result?.originalCurrentPath })}. ${recovery}`,
    );
  }

  try {
    const quarantine = result.quarantinePath;
    const backup = result.backupPath;
    if (
      result.basePath !== target.basePath ||
      typeof quarantine !== 'string' ||
      typeof backup !== 'string' ||
      !isAbsolute(quarantine) ||
      dirname(quarantine) !== dirname(target.basePath) ||
      !basename(quarantine).startsWith('.bbb-clean-') ||
      !isAbsolute(backup) ||
      dirname(backup) !== quarantine ||
      ['', '..'].includes(relative(quarantine, backup)) ||
      relative(quarantine, backup).includes(sep) ||
      realpathSync(quarantine) !== quarantine ||
      !lstatSync(quarantine).isDirectory() ||
      !lstatSync(backup).isDirectory()
    ) {
      throw new Error('invalid retained-backup location');
    }
    const original = target.identities.at(-1);
    if (
      !original ||
      original.path !== target.basePath ||
      !sameIdentity(original, result.originalIdentity)
    ) {
      throw new Error('original directory identity changed');
    }
    const retained = lstatSync(backup);
    if (!sameIdentity(original, { path: backup, device: retained.dev, inode: retained.ino })) {
      throw new Error('retained directory identity changed');
    }

    const current = validateBrainTarget(target.request);
    if (
      current.basePath !== target.basePath ||
      current.inputFolder !== target.inputFolder ||
      current.missing.length !== 0 ||
      JSON.stringify(current.identities.slice(0, 2)) !==
        JSON.stringify(target.identities.slice(0, 2)) ||
      !sameIdentity(current.identities.at(-1), result.freshIdentity) ||
      readdirSync(current.basePath).length !== 0
    ) {
      throw new Error('fresh brain or source directory changed before provisioning');
    }
    return { status: 'retained', target: current, backupPath: backup };
  } catch (error) {
    throw new Error(`Cleanup handoff refused: ${String(error)}. ${recovery}`);
  }
}
