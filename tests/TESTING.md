# Testing — bobs-big-brain-plugin

The installable Claude Code / Cowork plugin. **One plugin, two modes** dispatched by
`TEAMKB_API_URL`: `local` (in-process brain over `~/.teamkb`, native `better-sqlite3` +
the private sibling monorepo `@qmd-team-intent-kb/*`) and `team` (a dependency-free
stdio proxy to the remote brain over the tailnet). The shipped artifact is the committed
bundle `plugin-runtime/governed-brain.cjs` (esbuild inlines the private packages).

## The CI constraint (why not everything runs in plain CI)

The build-only devDeps are `link:../bobs-big-brain-registrar/*` — a **sibling monorepo
that does not exist in a fresh GitHub Actions checkout**. So `build` and the full
`typecheck` cannot run in generic CI (same reason `smoke.yml` never builds). CI therefore
gates the surface that is reachable **without** the sibling monorepo, and the full stack
is validated locally + by the committed-bundle smoke.

## Layers

| Layer | Gate | Where |
|---|---|---|
| L2 static — lint | `pnpm lint` (eslint flat, typescript-eslint, parse-only) | CI `ci.yml` + local |
| L2 static — types (CI-safe subset) | `pnpm typecheck:ci` (`tsconfig.ci.json`: `src/mode.ts` + `src/remote-server.ts`) | CI `ci.yml` |
| L2 static — types (full) | `pnpm typecheck` (all `src/**`, needs the sibling monorepo) | local + smoke host |
| L3 unit | `pnpm test` / `pnpm test:coverage` (vitest) — `src/mode.ts`, `src/remote-server.ts` | CI `ci.yml` + local |
| L3 unit — anchor verifier | `pnpm verify-anchors:test` (zero-dep `node:test`) | CI `ci.yml` + local |
| L3 unit — anchor-on-transition | `pnpm anchor-on-transition:test` (esbuilds `src/anchor.ts` → needs sibling) | local |
| L5 system — full chain (zero egress) | `smoke/smoke.mjs`, `smoke/audit-verify-banner.test.mjs` (drive the committed bundle) | `smoke.yml` + local |
| L5 system — synthetic golden set | `scripts/run-golden-set.mjs` (versioned fixture + expected deterministic outcomes) | `smoke.yml` + local |
| L5 system — B1 auto-govern inbox sweep | `smoke/b1-inbox-sweep.mjs` (seeds remote-shape candidates in a throwaway `candidates` table, drives the sweep: promotion/member quarantine/duplicate/terminal rejection + idempotency; verifies retained rejected content, canonical per-candidate evaluation receipt and zero-work second sweep) | `smoke.yml` + local |
| Policy pin | `audit-harness verify` (this file + any future `features/*.feature`) | CI `ci.yml` + local |

## Coverage floor

Scoped (`vitest.config.ts`) to the CI-testable modules `src/mode.ts` + `src/remote-server.ts`.
Current floor: **lines 55 / statements 50 / functions 45 / branches 45** — an honest number
for the pure helpers the unit suite owns (`resolveMode`, `errorResult`, `authHeaders`,
`search`). The `brain_capture` / `brain_transition` tool handlers and stdio boot in
`remote-server.ts` are exercised by the smoke suite over a real MCP session, not the unit
suite, so the file-level floor is modest by design. **Ratchet up as the unit surface grows;
never down.**

## What the unit suite pins (the review's risk areas)

- **`src/mode.ts`** — the local-vs-team dispatch predicate, extracted from `src/index.ts` so
  the "silently falls into local mode" trap (an unexpanded `${TEAMKB_API_URL}` placeholder,
  empty/whitespace values) is a regression-guarded function.
- **`src/remote-server.ts`** — `errorResult` (401/403/422/500 all surface a clear, role-aware
  message — never a silent success), `authHeaders` (bearer present/absent), and `search`.
  Two `search` tests **characterize** the current error-swallow (network error / non-OK →
  empty result) that the review flagged (R4/R8): pinned so the fix lands as a visible diff.

## Terminal rejection settlement

`node --test scripts/govern-rejections.test.mjs` runs in the existing
`anchor-conformance` CI job, after it provisions the public sibling Registrar.
The dependency-free unit lane retains its existing scope. The nine local-stack
cases use the actual Curator, policy engine, SQLite and audit repositories.
qmd refresh and external anchoring are stubbed. Missing-evidence and drift cases
also wrap the real `Curator.processSingle` to inject deterministic changes after
evaluation; they do not exercise a genuinely concurrent second writer. They cover a retained
terminal rejection and canonical receipt, repeated-sweep no-op, mixed flags /
holds / member quarantine / tenant isolation, per-candidate and batch receipt
failure rollback, missing evaluation evidence, and tenant/status/payload drift refusal.
Evaluation errors skip individual rows. Deferred settlement validation or receipt
errors instead abort the call and roll back the whole deferred batch; prior
promotions and holds retain their own commits. A persistent settlement conflict
can refuse later calls until its cause is resolved. These cases do not establish
bundled MCP, retrieval or external-anchor behavior.

The generated local runtime separately supports an isolated MCP check: capture a
nine-character synthetic note, govern twice, then read back the candidate and
receipts. Expect retained `status=rejected`, one canonical `deleted` rejection
receipt plus one `governed` batch receipt, zero curated memories and no additional
receipt or processed candidate on the second sweep. Verify the chain and external
anchor through `brain_audit_verify`. Run only with private HOME/base and a fixture
qmd executable; this is distinct from activating or migrating a live brain.

## Capture disclosure feedback

`node smoke/capture-feedback.mjs` runs against the committed local bundle and
its native SQLite closure in the hosted Node20 full-chain job. Fourteen private
MCP cases cover canonical secret refusals in content, title, file paths and
configured tenant, PII/compensation refusals, unchanged preexisting spool and
settled database rows, clean spool mode/origin HMAC, and clean promotion/audit.
The explicit qmd executable is missing and dense is disabled; this proves no
actual qmd ranking, dense quality or live corpus behavior.

The refusal snapshot has an observer-only stability control. It checks private
file inventory, bytes, mode, inode/device and logical candidate/memory/audit rows;
only `teamkb.db-shm` mtime is excluded because read-only inspection itself updates
that derived timestamp. This is state-preservation evidence, not zero filesystem
I/O or a sandbox. Scratch is removed only after transport closure is witnessed.
Reply and request-era stderr checks exclude the existing configured-tenant boot
log; these do not establish whole-process configuration secrecy.

`node --test scripts/capture-feedback.test.mjs` separately bundles the actual
source handler with fake MCP registration/config, an injected throwing scanner,
and origin/spool counters. Error and non-Error faults must return the fixed
`capture-validation-unavailable` reply, write no origin/spool data and expose no
fault value in the reply or intercepted stderr. It runs with zero skips in the
provisioned Node22 source lane; this instrumentation is not an actual scanner
fault or an independent shipped-bundle test.

The capture path uses the Registrar's full-candidate disclosure gate before
origin creation and spool writing. Canonical refusals return
`capture-disclosure-rejected` with category and fixed text, without a candidate ID
or matched value. This feedback is not a durable hash-chain refusal receipt.
Existing archives and non-MCP intake remain separate work under umbrella Bead
`compile-then-govern-eqw.9`; no operator archive is read or purged by these tests.

## Run it

```bash
pnpm install            # from a checkout that is a sibling of bobs-big-brain-registrar
pnpm lint
pnpm typecheck:ci       # or: pnpm typecheck (full, needs the sibling monorepo)
pnpm test:coverage
pnpm verify-anchors:test
node scripts/run-golden-set.mjs
```

## One entrypoint — `pnpm test:plugin` (Governed Second Brain)

Product-shaped packs over the hermetic suite. Prefer this before a dogfood push or release.

| Command | What it runs |
|---|---|
| `pnpm test:plugin` | Unit + skill contract + local smoke + team stub smoke + mode-dispatch + onboarding assert (hits live demos page locally) |
| `pnpm test:plugin:quick` | Hermetic only (no vitest) |
| `pnpm test:plugin:live` | Above + `smoke/live-smoke.mjs` (team API health; set `TEAMKB_API_TOKEN` for auth/search) |
| `pnpm onboarding:assert` | Package + demos page alone |
| `pnpm smoke:live` | Team API only |

**Pack map**

| Pack | Script | Proves |
|---|---|---|
| A hermetic | `smoke/smoke.mjs`, `smoke-team.mjs`, `mode-dispatch`, vitest | Bundle + mode + stub team proxy |
| B live | `smoke/live-smoke.mjs` | Real team API on tailnet (+ optional token) |
| C onboarding | `smoke/onboarding-assert.mjs` | Manifest author object, skills, demos page prompts/commands/footer |
| D skills | `smoke/skill-contract.test.mjs` | `/brain` + `/brain-save` frontmatter + write-never-auto |

Human acceptance: [`onboarding/DOGFOOD.md`](../onboarding/DOGFOOD.md).
