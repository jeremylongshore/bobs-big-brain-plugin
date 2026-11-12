# Skill response-policy evaluation

The adjacent `eval-spec.yaml` files are distinct, hand-authored J-Rig skill
profiles for this repository. They are grounded in source commit `cad3815c61c4e63306f599e49d2f10d716e1d3c9`;
other BBB repositories have different tool and permission contracts and must
retain their own profiles.

| Skill        | Recorded SKILL.md SHA-256 snapshot                                 |
| ------------ | ------------------------------------------------------------------ |
| `brain`      | `9a618e9030f230475d21f4d887ab6c1d2c23cf5c11bec1dc73a7ab6df4940666` |
| `brain-save` | `ebb85efa4dc230a7d41ef77c3379810dc14544363bfebdf7c05f940507b2e27e` |

## What these fixtures measure

Each functional case embeds an explicitly synthetic, already completed tool
transcript in its prompt. Binary judges assess the resulting response against
that transcript: citations, honest uncertainty, read/write separation and truthful
proposal/transition outcomes. No real corpus, token, filesystem write or MCP
service is supplied. These profiles do not prove that a model actually called the
right tool, that a deployed service enforced permissions, or that a write settled.
That requires a separately reviewed execution/trajectory lane.

Trigger-only cases cover explicit invocations, near-sibling requests and an
always-loaded MCP fixture: available tools alone are not expected to activate the skill. These trigger cases do
not test write-authorization enforcement. They are
adversarial cases with `criteria_ids: []`, so trigger classification runs without
manufacturing functional scores from an unrelated prompt. `brain` reads;
`brain-save` requires explicit invocation for its one-item write workflow.
Local and team capture outcomes are deliberately separate: team client intake is not local governance or proof of promotion.

## Validation and controlled execution

Validate each profile using the existing J-Rig CLI without provider execution:

```sh
j-rig validate skills/brain/eval-spec.yaml --json
j-rig validate skills/brain-save/eval-spec.yaml --json
```

A valid schema is not a model-quality result. The profiles target MiniMax-M3 with
five judge samples and explicit call/token/time budgets. Running them can consume
provider allowance; this source change neither executes them nor enables a
schedule. No budget may be interpreted as a claim that a run finished within it.

A coordinated J-Rig change is being prepared to select a separate fixed commit-SHA
source pin for each repository using `--roster`; this PR does not implement that
external runner change. Use a clean checkout at the configured SHA and
a separate output directory. Do not reuse a plugin pin for Registrar or vice versa.
Do not edit a pinned checkout to add profiles after verification.

No model acceptance, nightly rollout or release is claimed by this preparation.
Refs bead `bd_000-projects-qkhp`. To roll back, stop selecting the new roster and
revert these additive profiles; existing skill instructions and runtime stay intact.

## Author-local validation record

[eval-profile-validation.json](eval-profile-validation.json) records the exact
validator source/bundle and profile hashes used for the author-local schema and
scope checks. It is a retained execution record, not a signed attestation or
hosted-model result. The contract hashes above are dated source snapshots, not an
automatically maintained authority. Reproduce a contract hash from the recorded
source commit without consulting the working tree:

```sh
git show SOURCE_COMMIT:skills/brain/SKILL.md | sha256sum
```

Use the commit printed above in place of `SOURCE_COMMIT` and repeat for each skill.
Functional fixtures contain synthetic completed-tool transcripts; trigger-only
fixtures contain synthetic routing prompts. Neither lane proves deployed write
permissions or persistent memory settlement.
