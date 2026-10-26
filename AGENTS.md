# AGENTS.md

Agent + developer guidance for the **Bob's Big Brain plugin** repo. Tool-agnostic; `CLAUDE.md` points here.

## What this is

The **unified, public Bob's Big Brain plugin** — a Claude Code plugin that runs as a
single stdio MCP server in **two modes**:

- **local** (default): an in-process governed brain over your own files (`~/.teamkb`). First-start native provisioning can use npm/network; optional dense retrieval uses a separate loopback embedder. Lexical retrieval needs no generative-model API key.
- **team** (when `TEAMKB_API_URL` is set): a remote proxy to a shared governed-brain HTTP API over your
  network.

This is the *installable code*; the *landing/thesis* lives in the company umbrella repo.

| | Repo | Role |
|---|---|---|
| **This repo** | `jeremylongshore/bobs-big-brain-plugin` (personal, public) | the plugin: MCP runtime (local + team) + skills |
| **Umbrella** | `intent-solutions-io/bobs-big-brain-umbrella` (company) | landing page, thesis, competitive teardown — points here |
| **Engines** | `jeremylongshore/{bobs-big-brain-compiler, bobs-big-brain-registrar}` | Bob's Big Brain Compiler (compile) + Bob's Big Brain Registrar (govern) — separate repos |
| **Retired marketplace** | `intent-solutions-io/team-intent-claude-plugins` | historical distribution; current public marketplace is this repository |

**The old standalone `intent-brain` plugin is RETIRED.** It used to live in
`qmd-team-intent-kb/.claude-plugin/` as a separate team-only plugin; it has been folded into **this**
plugin's team mode and removed from the team marketplace (bead `compile-then-govern-650.4`). There is
now ONE plugin for both local and team — do not resurrect a second one.

## Architecture — the dual-mode dispatch (the part that matters)

`src/index.ts` is the dispatcher: it reads `TEAMKB_API_URL` and `await import()`s exactly one server
(an unexpanded `${...}` placeholder counts as unset → local):

- **`src/local-server.ts`** — LOCAL mode. Drives qmd + the deterministic govern kernel + `~/.teamkb`
  **directly, in-process** (imports `@qmd-team-intent-kb/*` + `better-sqlite3`). Full tool surface (6):
  `brain_search` / `brain_status` / `brain_audit_verify` (read) + `brain_capture` / `brain_govern` /
  `brain_transition` (write).
- **`src/remote-server.ts`** — TEAM mode. Proxies to the Registrar HTTP API (`apps/api`) over the network
  with a per-user bearer token. Tool surface (9): `brain_search` and auth-free `brain_status` reads;
  `brain_capture` proposals; `brain_inbox`, `brain_approve`, and `brain_reject` admin review;
  `brain_holds` and `brain_hold_recommend` for the human-escalation hold queue (list and recommend
  only — see below); and
  `brain_transition` admin lifecycle changes. **No `brain_govern`** (govern runs server-side), and
  `brain_audit_verify` remains local-only.

### Host compatibility scope

The current distribution contains `bin/`. Anthropic's [plugin reference](https://code.claude.com/docs/en/plugins-reference#standard-layout)
excludes plugins with that directory from Cowork and claude.ai installation.
Do not describe this tree as a supported Cowork plugin or infer host compatibility
from native Claude Code validation. A compatible packaging change and actual host
validation would be separate work; preserve the existing executable layout here.

### ⚠️ CRITICAL constraint — team mode is dependency-free

The team path uses Node built-ins, dependency-free local contract helpers, `fetch` (global), `zod`, and the MCP SDK —
**never** `@qmd-team-intent-kb/*` or anything pulling `better-sqlite3`. The team bundle must run from a
marketplace clone with **zero install/build** and never touch the native module. (Local-mode's native
imports are dynamically `import()`ed only on the local path, so they don't load in team mode.) If you
add a team tool, **mirror the local tool's Zod schema 1:1 but build the request by hand** — do not
import schema/store packages. `smoke-team.mjs` asserts the team bundle has no `@qmd-team-intent-kb/*`
behavior at runtime; a stray native import will break a marketplace install.

### Key files
- `src/index.ts` — mode dispatcher.
- `src/local-server.ts` — local 6-tool server; `brain_govern` → `src/govern.ts`.
- `src/govern.ts` — the daemon-free govern drive (also closes overdue human-escalation holds and
  counts `held` / `holdCapBlocked` / `holdsExpired`): seed local policy → ingest spool →
  `Curator.processBatch` (dedupe → policy → promote) → `runExport` → qmd index refresh → SHA-256
  hash-chained audit + git-committed external anchor.
- `src/seed-policy.ts` — seeds the Registrar's canonical recommended policy only when a tenant
  has no policy rows. Existing custom, disabled and older policies remain unchanged. Enabled rules
  can reject, flag for review or create a human hold; ten enabled types does not mean ten decisions
  on every capture. `runGovern` retains best-effort seed error handling, so insertion failure is
  not a fail-closed bootstrap guarantee. Local person-operated review uses the separate command
  described below; do not auto-promote flags or expose hold release through MCP.
- `src/remote-server.ts` — team server (dependency-free); proxies search/capture/transition. Tenant
  from `TEAMKB_TENANT_ID` (default `intent-solutions`). `errorResult()` maps 401/403/422 to clear
  member/admin messages.
- `src/config.ts` — local config; `tenantId` defaults to `local`.
- `plugin-runtime/governed-brain.cjs` — the built bundle (esbuild). **Committed** (a file-copy
  `/plugin install` runs it without a build). Rebuild + commit it with any `src/` change.

### Local person-operated review

`bin/review.mjs` exposes `governed-second-brain-review list|reject|resolve-hold`.
Its builtin-only guard refuses effective team configuration before helper/native
loading. It requires an existing regular SQLite file and existing native closure;
never add implicit provisioning or migration. `src/local-review.ts` is bundled to
`plugin-runtime/local-review.cjs`, independently hash-bound in `gsb.lock.json`.
Rebuild all four helpers from the same clean Registrar revision.

Listing is read-only and returns sanitized metadata, with output limits per queue;
repository reads can still materialize the tenant queue. Writes take the shared
flock and use one immediate transaction around canonical Registrar rejection or
hold resolution, verifying the disposition and receipts before commit. Expiry can
commit even when release is refused. Anchor first, then refresh through
`src/derived-state.ts`; do not invoke `runGovern` to settle one reviewed candidate,
as that sweeps unrelated inbox items. Post-commit failure must retain a truthful
committed result. Local declared actor/role are not physical-person authentication.
No MCP review tool or general policy-flag approval override is added.

### Local reviewed recovery

`bin/recovery.mjs` exposes `governed-second-brain-recovery apply|repair` for a
private Registrar recovery envelope and independently reviewed digest. It refuses
effective team configuration before native/helper loading, requires Linux Node22,
and never installs dependencies. The explicit owned qmd2.5.3 manifest pin and
existing private source/target export and tenant index roots are prerequisites.
The source roots need the five canonical export directories before execution.

`src/recovery-maintenance.ts` is bundled as `plugin-runtime/local-recovery.cjs`,
with its own `localRecoveryHelperSha256` in `gsb.lock.json`. The fixed coordinator
retains the Registrar's actual shared flock and existing DB through global local
Git anchoring, both tenant-exclusive exports, actual selected indexing, and final
canonical document/registry/witness checks. No configurable postcommit shell hook
or new MCP tool is added. Partial outcomes and blocked exports stay incomplete;
postcommit failure preserves known database settlement. Apply replay deliberately
stays unverified; explicit repair rechecks derived state without governance or
archival receipts. CLI output omits source bodies, keys, policy prose and runtime
paths. Local witness verification does not publish a remote anchor. Preserve the
existing general-purpose best-effort anchor and derived refresh behavior.

Fresh apply uses the fixed synchronous checker in `src/recovery-audit.ts` through
the Registrar readiness boundary, under the shared flock and the same outer
SQLite immediate transaction as application. It performs no mkdir, append, Git
command or settlement-receipt lookup. Existing logs use bounded read-only
descriptor snapshots and the canonical snapshot verifier; only ENOENT means
absence, and path/descriptor metadata is rechecked. Canonical exact exception
pins remain required; ordering forks never gain amnesty. Apply replay skips this
fresh check; repair retains historical commitment and strict postcommit checks.
Readiness establishes audit prerequisites, not guaranteed later maintenance.
The canonical postcommit appender retains its own path read; do not claim that
every postcommit internal read is bounded by the new readiness reader.

### Team-mode server contract (the Registrar's `apps/api`)
- `POST /api/candidates` — member-allowed; body = a full `MemoryCandidate` built client-side (the
  server `safeParse`s with no defaults — provide every field, like `local-server.ts` does). Optional
  `origin { tokenHmac, channel, mintedAt }` (H1): sent only when `TEAMKB_ORIGIN_SECRET` is set; a
  claimed channel outside the server allowlist gets a 422 with code `unrecognized_channel`.
- `POST /api/memories/:id/transition` — admin; body `{ to, reason, actor: <Author OBJECT>, supersededBy? }`
  (an Author **object** `{type:'human',id}`, **not** local mode's `actor` string).
- `POST /api/search` — read. Bearer token in `Authorization`. Writes must send `tenantId` explicitly
  (the current tokens are unrestricted).
- Promotion (`POST /api/candidates/:id/promote`) is admin and server-side — not exposed as a plugin tool.
- `GET /api/holds` and `POST /api/holds/:candidateId/recommend` — admin; the human-escalation hold
  queue (registrar runbook `000-docs/055-OD-RNBK`). `brain_holds` lists it and `brain_hold_recommend`
  attaches advice (`{ verdict, audience?, reasoning, actorType: 'ai' }`), which writes one receipt
  and changes no state. **`POST /api/holds/:candidateId/resolve` is deliberately NOT a plugin tool:**
  releasing or rejecting a hold is a person's decision (it chooses the audience), and an MCP tool
  call is a model emitting it. A person resolves with `curator-cli holds resolve` or the API under
  their own token; the server refuses agent tokens there. Do not add a resolve tool.
- `brain_approve` / `brain_reject` on a held candidate get a 422 (`held_for_review` / `on_hold`):
  an approval cannot release a hold.

## Building

The local MCP runtime is **bundled from the sibling `../bobs-big-brain-registrar` workspace** — esbuild
**inlines** its compiled packages into the `.cjs` (bundle, don't publish). `package.json` link paths
assume `../bobs-big-brain-registrar` is a sibling checkout.

```bash
pnpm -C ../bobs-big-brain-registrar install --frozen-lockfile
pnpm install --frozen-lockfile        # links the sibling workspace
pnpm typecheck                        # full local tsc --noEmit
node build.mjs                        # rebuilds clean Registrar + all four committed helpers
node smoke/smoke.mjs                  # LOCAL: private HOME required; never use a live brain
node smoke-team.mjs                   # TEAM: dispatch→proxy against a stub API; asserts the surface, bearer, tenant, the Author-object, and the admin 403
```

For a reviewed bundle refresh using an existing native installation, run
`node build.mjs --bundle-only`. This still rebuilds the clean Registrar source and
records its revision and bundle hash, but skips native npm provisioning. It does
not verify native compatibility; check the native closure and run the appropriate
isolated runtime smoke separately. The default build still provisions natives.

Build hard-facts:
- **Three native modules**: `better-sqlite3`, `fs-ext`, and `sqlite-vec` are externalized, with the `bindings` loader. Bootstrap provisions the lockfile-pinned runtime closure per platform (NOT committed). `ajv`/`ajv-formats` stay
  **bundled** (the SDK validates every tool call with ajv — externalizing them makes the runtime inert).
- **Single zod**: `build.mjs` aliases `zod` to one copy (cross-instance `instanceof` otherwise breaks
  tool registration).
- **qmd 2.x** for local retrieval. Local search and govern share the Registrar's
  executable/prefix selection: explicit binary, `TEAMKB_QMD_BIN`, paired
  `TEAMKB_QMD_RUNTIME` declaration, then legacy PATH / Bun discovery only when
  undeclared. A declared broken artifact never falls back to a global binary.
  The declaration is JSON with `root` and an independently expected
  `manifestSha256`; selection metadata is not proof of portable native compatibility.
  Owned execution requires the artifact's Node 22/platform/ABI match; the team
  server remains Node 20 and never selects/provisions local qmd or natives.
- **Installer boundaries**: `init` refuses effective team configuration before
  local setup. Its requested canonical base controls `team.json` lookup; an
  unrelated default brain does not block a separate local brain. After consent,
  availability uses the shared command route within its original 5 s budget,
  before cleanup or provisioning. Failed explicit selections refuse capture;
  undeclared legacy absence may proceed with degraded qmd-backed retrieval;
  native FTS may still provide partial results. Synchronous import/metadata work
  cannot be preempted.
- **Recoverable cleanup**: existing-root `--clean` uses `bin/installer-cleanup.mjs`
  and the isolated stdlib Python helper on Linux. Directory handles and
  `renameat2(RENAME_NOREPLACE)` retain the prior root in a sibling
  `.bbb-clean-<random>/original`; no recursive deletion or disk reclamation occurs.
  The pre-move `recovery.json` and any refused backup must remain recoverable;
  rollback never overwrites an occupied original name. Unsupported helpers or
  filesystems refuse before moving old data (an empty recovery holder can remain).
  Full compilation reserves a new `ico-workspace-<random>` rather than deleting
  prior compiler state. Fixture tests must use private HOME/input/outside sentinels.
  These checks do not freeze backup contents, confine same-user processes, or make
  subsequent pathname-based provisioning/capture transactional. Do not broaden
  those guarantees or add automatic backup deletion.
- **Owned prefix**: persist a Registrar-selected runtime declaration outside
  `plugin-runtime/node_modules`, which the existing lockfile `npm ci` native
  provisioner replaces. The installer does not download, copy or activate an
  owned artifact; archive/platform delivery remains separate work. Only a
  successful selected binary pin or normalized runtime pair is registered; legacy
  discovery is not implicitly pinned. Relative env binaries are canonicalized
  after success; relative explicit-config binaries cannot be persisted.
- **Headless helper**: `src/qmd-command.ts` builds separately to
  `plugin-runtime/qmd-command.cjs` for installer availability without starting MCP.
  All four generated helpers and their `gsb.lock.json` digests must come from the same
  clean Registrar build. Native provisioning uses bootstrap's existing exports.
- **Govern reconciles the export tree** (`runExport({ reconcile: true })`), not just new
  promotions: lifecycle changes made by `curator batch-transition` / `brain_transition` land in
  `archive/`, torn files are rewritten, stale copies removed. `brain_govern` reports `exported`
  (files changed) plus an `export` breakdown (written/archived/removed/unchanged/quarantined).
  Orphan removals are capped at 50 per run (empty/wrong-DB guard) and only touch files whose
  frontmatter tenant matches.
- **`brain_capture` `subjects`** (both modes): optional, at most 8 `SubjectKey` slugs, validated by
  `src/subjects.ts` (a dependency-free mirror of the registrar schema, re-checked against the real
  `ContentMetadata` in local mode) and sent as `metadata.subjects`. Invalid input is a clear
  `{ ok: false, error }` and nothing is spooled/sent/queued.
- **Tenant defaults**: do **not** hardcode `TEAMKB_TENANT_ID` in `plugin.json` / `.mcp.json` (a hardcoded
  `local` silently misroutes team writes into a tenant the team brain never reads). Local → `local`
  (config.ts); team → `intent-solutions` (remote-server.ts); a user env override applies in either mode.

### Forker/local BYO-brain contract

Local mode is the sovereignty path: keep `TEAMKB_API_URL` unset, set
`TEAMKB_BASE_PATH` to the fork's private brain root, and set
`TEAMKB_TENANT_ID` to the fork's namespace. The qmd adapter derives its
tenant-scoped registry/cache at `<base>/qmd-index/<tenant>` and the runtime
reports that resolved path through `brain_status` and the local boot receipt.
`TEAMKB_EXPORT_DIR` is optional and points to the governed Markdown source tree
(default `<base>/kb-export`), not to the qmd index. After first-start provisioning, lexical grounding needs no generative-model API key or remote brain API; optional dense retrieval uses the configured loopback service. Changes to this contract require config tests and
an isolated local smoke; never test against the operator's real `~/.teamkb`.
Existing derived indexes created under a different base are not moved by this
source change. Reconcile/rebuild the chosen brain's derived indexes through its
normal reviewed workflow when needed; stored memories require no schema migration.
Do not repair an operator index as part of fixture validation.

## Audit-claim honesty
The chain is tamper-**evident** (detection of edits/reordering), **not** tamper-proof: a local writer
can edit an event *and* re-hash forward. Keep the "What the receipt does *not* do" framing honest.
**Forbidden words:** tamper-proof, immutable, non-repudiation (for local mode), blockchain.

## Write-time provenance (origin tokens) — what they do and do NOT prove

A local `brain_capture` mints an **origin token**; team capture does so only when its administrator supplied the origin secret. The token is HMAC-SHA256 over `(candidateId, tenantId, capturedAt)`
keyed by a per-installation secret; the Registrar's govern path verifies it BEFORE promotion and
rejects a forged claim with a receipted `origin_token_invalid`. Missing origin = accepted, receipted
as channel `unattested` (backward compatibility with every pre-H1 capture/spool). Wiring:

- **Local mode** (`local-server.ts` + `govern.ts`): mints with `~/.teamkb/origin-secret`
  (auto-created 0600 on first capture; env `TEAMKB_ORIGIN_SECRET` overrides), channel `local-mcp`.
  The local govern pass verifies with the same file. **Channel attestation is OUT OF SCOPE in local
  mode (v1):** the box is one trust domain — any process that can read the secret can claim any
  channel, so the channel value is self-asserted. Canonical decision record: the Registrar's
  `000-docs/049-AT-DECR-write-time-provenance-origin-tokens.md`.
- **Team mode** (`remote-server.ts`): mints ONLY when the admin explicitly distributed
  `TEAMKB_ORIGIN_SECRET` (env; never a file fallback, never auto-generated — a client-invented secret
  would mint tokens the server rejects at promotion). Channel `team-mcp`, checked against the server's
  intake allowlist (unknown channel → stable 422 `unrecognized_channel`). No secret → the capture is
  sent WITHOUT `origin` and governs as unattested, exactly like pre-H1.

**The residual, named honestly (do not soften this):** an **authenticated insider** — anyone holding a
valid member/admin token and/or the origin secret — can still poison L2/L3 content with
validly-attested captures. Origin tokens prove **where a capture came from, not that it is true**. The
mitigations for content poisoning are the deterministic govern policy, human review of the
inbox/quarantine queues, and supersession — not the token. Receipts carry only the channel + a
truncated SHA-256 of the token (never the token; no verify-arbitrary-token oracle exists).

## Configured retrieval

At the Registrar revision in `gsb.lock.json`, the source entrypoints configure
`brain_search` with qmd BM25, native FTS5 and a
sqlite-vec dense arm (EmbeddingGemma-300M), fused with deterministic reciprocal-rank
fusion (RRF, k=60), then freshness/category reranking. `src/local-server.ts` passes
`getDefaultDenseConfig()`; the Registrar API/edge entrypoints also select their
configuration. Team mode proxies to that deployed server, so its actual version,
configuration, index and embedder availability determine the arms served.

Dense is default-on in those entrypoints, can be disabled with
`TEAMKB_DENSE_ENABLED=0`, and needs a built index plus the configured loopback
embedding service. If unavailable it fails open to lexical results. The bare
`QmdAdapter` library remains lexical-only when its `dense` config is omitted.
The retrieval path uses an embedding model but makes no query-time generative
LLM call. Do not describe that configuration as BM25-only, zero ML, or an unshipped dense roadmap.
The existing SHA-256 model/runtime pins remain applicable; see the Registrar
[embedder runbook](https://github.com/jeremylongshore/bobs-big-brain-registrar/blob/a6aeb9ca4a80687ae840168e1273dfd6c1ac555e/000-docs/051-AT-RNBK-embedder-service-and-dense-index-runbook.md)
for provisioning and evaluation history. This documentation change does not relax
those controls or establish which version a remote endpoint deploys.
Historical baseline: `bobs-big-brain-registrar/000-docs/038-AT-DECR`; owning
code: `packages/qmd-adapter/src/config.ts`, `adapter.ts` and the production
entrypoint configuration. The package scope and bead prefix remain unchanged by
the repository rename.

## Checkout, CI and installed-package contexts

The source checkout links a sibling Registrar. CI quality deliberately trims those build-only links, uses npm, and runs `typecheck:ci` plus coverage; it does not prove a full source rebuild. `smoke.yml` checks committed helper digests and exercises the committed bundle. A source/runtime change must still rebuild all four helpers locally and test their actual protocol behavior.

Use Node22 for the maintained local/owned-runtime and reviewed-recovery path. The team-only CI lane still tests Node20; package.json has no engines constraint. Do not infer a new global Node requirement from a documentation change.

npm ships this guidance, `CLAUDE.md`, and the standalone anchor verifier. Source rebuilds, tests, opt-in autocapture hooks, and source-only development commands require a repository checkout. `gsb.lock.json` records build provenance and compatibility baselines; its version fields are not proof of an installed channel or an instruction to publish a release. Current source can include changes after the v1.2.0 tag while retaining that manifest version.

## Tracking
Program-level beads + the GitHub tracking issue live on the **umbrella** repo
(`intent-solutions-io/bobs-big-brain-umbrella` — epic `compile-then-govern-qy7`, issue #1), not here.
This repo is code; file code-anchored issues here and cross-reference the epic.
