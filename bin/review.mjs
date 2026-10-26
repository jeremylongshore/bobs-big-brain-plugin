#!/usr/bin/env node
// Person-operated local review. Builtins only until effective team-mode refusal.
import { lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const HELP = `Usage: governed-second-brain-review <command> [options]

  list                           List pending inbox and active holds (metadata only)
  reject                         Reject one pending inbox candidate
  resolve-hold                   Release or reject one human-escalation hold

Options:
  --base PATH                    Existing local brain (default: configured base)
  --tenant ID                    Tenant (default: configured tenant or local)
  --limit N                      Entries per list queue, 1–100 (default: 25)
  --role owner|admin             Declared local standing (default: owner)
  --candidate UUID               Candidate for a write command
  --actor ID --reason TEXT       Declared person and review reason
  --resolution release|reject    Required for resolve-hold
  --audience tenant|admins|owner  Required for hold release
  --acknowledge-wider            Acknowledge audience wider than recommendation

This command shares the local machine's trust domain. Declared actor/role do not
prove a physical person issued it. Reasons are recorded; omit private content.
No general policy-flag approval override is provided.
`;

function refuse(code, message) {
  process.stdout.write(`${JSON.stringify({ ok: false, committed: false, code, message })}\n`);
  process.exitCode = 1;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        help: { type: 'boolean', short: 'h' },
        base: { type: 'string' },
        tenant: { type: 'string' },
        limit: { type: 'string' },
        role: { type: 'string' },
        candidate: { type: 'string' },
        actor: { type: 'string' },
        reason: { type: 'string' },
        resolution: { type: 'string' },
        audience: { type: 'string' },
        'acknowledge-wider': { type: 'boolean' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch {
    return refuse('invalid_arguments', 'Invalid arguments. Use --help.');
  }
  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return;
  }
  const operation = positionals[0];
  if (values.base !== undefined && values.base.trim() === '') {
    return refuse('invalid_arguments', 'An explicitly selected base cannot be blank.');
  }
  const limit = Number(values.limit ?? '25');
  const role = values.role ?? 'owner';
  if (
    positionals.length !== 1 ||
    !['list', 'reject', 'resolve-hold'].includes(operation) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !['admin', 'owner'].includes(role)
  ) {
    return refuse('invalid_arguments', 'Choose a command, role and limit shown in --help.');
  }
  if (
    operation !== 'list' &&
    (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      values.candidate ?? '',
    ) ||
      !values.actor?.trim() ||
      !values.reason?.trim())
  )
    return refuse('invalid_arguments', 'A candidate UUID, actor and reason are required.');
  if (
    operation === 'resolve-hold' &&
    (!['release', 'reject'].includes(values.resolution) ||
      (values.resolution === 'release' && !['tenant', 'admins', 'owner'].includes(values.audience)))
  )
    return refuse('invalid_arguments', 'Choose release with an audience, or reject.');

  const base = resolve(
    values.base?.trim() ||
      process.env.TEAMKB_BASE_PATH?.trim() ||
      process.env.TEAMKB_HOME?.trim() ||
      join(homedir(), '.teamkb'),
  );
  const tenant = (values.tenant ?? process.env.TEAMKB_TENANT_ID ?? 'local').trim();
  if (!tenant) return refuse('invalid_arguments', 'A tenant is required.');
  const effective = { ...process.env, TEAMKB_BASE_PATH: base, TEAMKB_TENANT_ID: tenant };
  const require = createRequire(import.meta.url);
  const bootstrap = require('../plugin-runtime/bootstrap.cjs');
  if (bootstrap.teamModeRequested(effective)) {
    return refuse('team_mode_refused', 'Use the team review surface; this command is local only.');
  }
  try {
    if (!lstatSync(join(base, 'teamkb.db')).isFile()) throw new Error();
  } catch {
    return refuse(
      'existing_store_required',
      'Choose an existing local brain database. No setup was run.',
    );
  }
  if (!bootstrap.nativeDependenciesReady()) {
    return refuse(
      'native_dependencies_missing',
      'Complete local plugin setup before review. No installation was run.',
    );
  }
  process.env.TEAMKB_BASE_PATH = base;
  process.env.TEAMKB_TENANT_ID = tenant;
  const helper = require('../plugin-runtime/local-review.cjs');
  const config = helper.localReviewConfig();
  const result =
    operation === 'list'
      ? helper.listLocalReview(config, { limit, role })
      : await helper.reviewLocalCandidate(config, {
          operation,
          candidateId: values.candidate,
          actor: { type: 'human', id: values.actor },
          role,
          reason: values.reason,
          ...(operation === 'resolve-hold'
            ? {
                resolution: values.resolution,
                audience: values.audience,
                acknowledgeWider: values['acknowledge-wider'] === true,
              }
            : {}),
        });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

try {
  await main();
} catch {
  // Never echo arbitrary native/schema/candidate diagnostics to the command reply.
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      committed: null,
      code: 'review_failed',
      message: 'Review disposition is unknown. Inspect local state before retrying.',
    })}\n`,
  );
  process.exitCode = 1;
}
