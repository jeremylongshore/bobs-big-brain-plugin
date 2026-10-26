# Plugin source contract reconciliation

Baseline: `09b6644`; checked 2026-10-26. Bead: `compile-then-govern-eqw.6.4`.
This is the plugin slice of intent-os consistency audit244. The authority registry
is absent; fact classes remain unowned. This report records source and package
contracts without adopting an authority registry, releasing a version or activating a runtime.

## Deterministic findings

| ID | Baseline observations | Source correction and evidence |
| --- | --- | --- |
| W1 | Team MCP initialize reports1.1.0; root/local/plugin manifests declare1.2.0. | Align team stamp1.2.0 and assert the actual initialize response against package.json in existing team smoke. The original committed bundle fails this real protocol check; four rebuilt helpers and exact digests are required before acceptance. |
| W2 | Partner badge HTML sits inside the verifier bash fence. | Preserve the badge markers and move the block outside the executable example; syntax-check the resulting bash example. |
| W3 | Build guidance names root smoke.mjs and differs from npm CI/typecheck:ci; CI deliberately tests committed helpers without a source rebuild. | Name actual source and CI commands and their different proof scopes. Keep workflow logic and gate names unchanged. |
| W4 | AGENTS describes one native module; runtime package/bootstrap/build externalize three. | Name better-sqlite3, fs-ext, sqlite-vec plus the bindings loader. Distinguish first-start provisioning, existing native ABI compatibility, teamNode20 CI and maintained local/owned/recovery Node22 paths. No engines or build target is changed. |
| W5 | Lock/CI/team-config comments call the Registrar private. | Correct descriptions: public sibling, separately provisioned. Visibility edits change no fetch/install authorization or CI behavior. |
| W6 | Hook guide refers to umbrella014/015 as plugin-local files. | Link the actual umbrella decision/rollout records and label the optional source-checkout workflow. |
| I1 | npm ships CLAUDE pointing to absent AGENTS; README/package script references an absent standalone verifier. | Include AGENTS.md and scripts/verify-anchors.mjs in the npm file list; verify actual packed bytes and execute the shipped verifier. Tests/build scripts remain source-checkout commands. |
| I2 | Version labels are reused after the original1.2.0 tag; compiler compatibility baseline is1.14.0 while fallback accepts^1.14.0. | Preserve version labels/range and document source versus release/installed artifact identity; do not invent a release or claim a measured installed compiler version. |

## Advisory findings and boundaries

- Current source configures a default-enabled dense arm above lexical fusion, but the stock
  package does not provision an embedder or index. Failure opens to lexical retrieval;
  optional cross-encoder reranking differs from freshness/category ranking.
- Capture proposals, governance receipts, retrieval citations and git witnesses have distinct
  persistence and trust boundaries. Do not promise every spool write has a governance receipt
  or every possible tamper is detected on one writable machine.
- The installer’s stale Anthropic/future-full-mode comment is corrected to its existing
  DeepSeek selection and supported registration flags. This is a comment correction, not a provider change.
- Real environment keys override team.json; the file fills missing values. Explicit operator
  tenant guidance prevents relying on the default. Team outbox and opt-in autocapture are
  distinct from local capture and can persist proposals before promotion.
- Optional autocapture filtering reduces disclosure risk; neither model filtering nor regex
  scanning guarantees arbitrary sensitive content is removed. Installing the plugin does not enable the hook.
- The code license does not license separate model weights. Registrar044’s model-selection
  conflict remains in `compile-then-govern-eqw.11`; no supersession or model choice is adopted here.
- The public product name and actual plugin identifier are distinguished: Bob’s Big Brain,
  npm/plugin governed-second-brain, MCP governed-brain. The retired marketplace is historical.
- Source fixes and passing tests are not evidence of released channels or a current installed
  client. Prior dated clean-room proof remains historical; this work performs no live-brain migration.

## Validation scope

Check source and package version contracts, actual MCP initialize behavior, native/runtime
boundaries, complete helper digests, the real packed file list and standalone verifier, docs
links and bash fences, and owning source/runtime gates. Nine drift dimensions are considered:
index/files, version strings, README/CI commands, guidance references, phase/status language,
capability/code, cross-document facts, local references, and planning/implementation.

Exact commands, negative/positive results, source pins, configured review outcomes and normal
merge evidence belong to the PR and Bead. The failed original version check is retained as
negative-control evidence. No current release, website, hosted service or private/live corpus
is changed, and this report does not assert that unexecuted checks passed.
