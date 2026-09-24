# Synthetic golden-set contribution surface

This directory is the plugin's one intentionally small, stranger-PR-able
contribution surface. A contributor can copy `TEMPLATE.json`, add synthetic
cases, and run the fixture against the committed local runtime without Jeremy's
brain, a team endpoint, an API key, or network access.

## Contract

Each fixture is JSON with:

- `format`: exactly `bobs-big-brain/golden-set/v1`.
- `name` and `description`: short human-readable identifiers.
- `cases`: one to twenty ordered cases. Every case has a kebab-case `id`, a
  `title`, `content`, one supported memory `category`, and an `expectedStatus`.

The runner recognizes these deterministic local outcomes:

- `promoted` — the candidate became a durable curated memory.
- `inbox` — deterministic policy kept the candidate in the review inbox.
- `duplicate` — the candidate matched an earlier promoted case.

Cases run in file order inside one isolated tenant. That ordering is important
when a later case intentionally checks duplicate detection.

## Make a contribution

1. Copy `TEMPLATE.json` to a new fixture name under this directory.
2. Use invented systems, schedules, labels, and facts only. Never copy a real
   brain export, personal data, partner data, credentials, local paths, or
   private hostnames into a fixture.
3. Run the validator and runner from the repository root:

   ```bash
   node scripts/run-golden-set.mjs contrib/golden-set/v1/your-fixture.json
   ```

4. In the PR description, pin the runtime/base commit SHA that produced the
   result and include the exact command plus its pass/fail output. Expect a
   fixture to break when governance behavior changes; update the expected
   outcome only when the behavior change is intentional and explain why.
5. Keep the PR limited to the fixture, its explanation, and any accompanying
   deterministic test change. The runner is zero-egress and must remain so.

The checked-in `synthetic-local-v1.json` is the reference example. It exercises
promotion, the short-content policy queue, and duplicate detection using only
made-up text.
