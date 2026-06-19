# Security Policy

## Reporting a vulnerability

Please disclose privately first — **do not** open a public issue for a vulnerability. Email
**security@intentsolutions.io** (or use this repo's private GitHub Security Advisories). You'll get
an acknowledgement and a coordinated-disclosure timeline.

## What this plugin is, security-wise

The plugin is a **local stdio MCP server** that runs on your machine with the **same OS permissions
as any other program you install** — it is *not* sandboxed. It reads the folder you point it at,
runs the local `ico` / `qmd` tools, and reads + writes the local brain (`~/.teamkb` by default).
Nothing leaves the machine unless you opt in.

- **Compile egresses by design.** The compile step sends document text to the configured LLM
  provider. Use index-only mode for data that must not leave the machine. The plugin should make
  this explicit before it sends anything.
- **Engines are pinned.** Bundled `ico` / `qmd` / govern-kernel versions are fixed by
  `gsb.lock.json` and verified on install; the qmd binary + model weights are SHA-256-pinned and
  fail closed on mismatch.

## Audit trust model — read this before relying on it

The audit trail is **tamper-evident**, not tamper-proof:

- **Local mode** gives you **integrity + ordering** — the SHA-256 hash chain *detects* edits or
  reordering after the fact (`ico audit verify`).
- It does **not** provide tamper-proofing or cross-actor non-repudiation: a local writer with write
  access can edit an event *and* re-hash the chain forward, and verification passes again.
  Cross-actor guarantees require the external chain-head anchor.

Forbidden claims for local mode: *tamper-proof*, *immutable*, *non-repudiation*, *blockchain*.

— Intent Solutions · [intentsolutions.io](https://intentsolutions.io)
