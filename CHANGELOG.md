# Changelog

All notable changes to the **Governed Second Brain** plugin are documented here. This is the
installable Claude Code + Cowork plugin (a local stdio MCP server); the engines it bundles
(`ico` / `qmd` / govern kernel) carry their own changelogs in their repos. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project aims at
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Governance scaffolding: `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`
  (Contributor Covenant 2.1), and this `CHANGELOG.md`.
- Retrieval roadmap recorded in the plugin guidance — `brain_search` stays BM25 (qmd search) now;
  a lean native sqlite-vec semantic path (EmbeddingGemma-300M) is eval-gated. (#1)

### Fixed

- README footer link uses the canonical trailing-slash root (`intentsolutions.io/`). (#2)

## [0.1.6]

### Added

- MCP server declared **inline in `plugin.json`** (`mcpServers`) so the marketplace sync — which
  drops a root `.mcp.json` — still registers the local server.

## [0.1.5]

### Changed

- DB-backed tools **fail actionably** on a non-installer install (detect a missing native dependency
  and emit an install hint) instead of throwing an opaque error.

## [0.1.4]

### Added

- `gsb.lock.json` reproducible pin (exact ICO × INTKB × qmd × plugin tuple) with a hermetic
  full-chain CI smoke against the pinned set.
- External **audit-chain anchor** — govern commits the chain head; `brain_audit_verify` checks it.
- npm **provenance** via the CI release workflow + a qmd version check.

### Changed

- All version strings aligned to a single source (the `validate-plugin` marketplace-tier gate).

— Jeremy Longshore · [intentsolutions.io](https://intentsolutions.io)
