# Onboarding — Bob's Big Brain

This repository targets **plugin** setup in Claude Code or Cowork. The public website explains
the product; it does not host your personal brain.

**Product and beta limits:** [Bob’s Big Brain](https://intentsolutions.io/bbb/).
**Setup:** [installation guide](https://intentsolutions.io/bbb/install/).
The prompts below describe this repository’s source; check the
[status page](https://intentsolutions.io/bbb/status/) for distribution limits.

| Path               | Who               | Needs                                                                                 | Mode                                                                 |
| ------------------ | ----------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Team**           | Invited teammates | Operator-provided network access, API URL, tenant and personal token + desktop Claude | Remote team brain via `~/.teamkb/team.json`                          |
| **Local (public)** | Anyone            | Desktop Claude plus one-time native dependency setup                                  | In-process personal brain on your machine — no team network or token |

| Where you run Claude          | Works?                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| **Claude Code** or **Cowork** | Documented setup targets; this guide does not establish a tested client or operating-system matrix. |
| **Claude Desktop**            | Requires separate client validation and manual MCP configuration.                                   |
| **claude.ai web / phone**     | No.                                                                                                 |

Team path only: obtain the API URL, exact tenant, personal token and network-access
instructions privately from your team operator. If your team uses Tailscale, use
the operator’s invitation and confirm the assigned tailnet. A public example
cannot supply your team’s connection values.

---

## Team path (invite-only)

1. Team network access, verified using the operator’s instructions
2. Desktop Claude
3. Plugin install plus `team.json` with the operator-provided URL, token and exact tenant
4. Search a known team topic with `/brain <keywords>` and inspect its returned citations
5. Optional: standing order in `~/.claude/CLAUDE.md` / `AGENTS.md` so Claude searches first

### Paste to Claude (team)

```
Install and connect me to my team's Bob's Big Brain. Run these steps in order. Stop and tell me if any step errors.

1) Add and install the plugin from the repository’s public marketplace:
   claude plugin marketplace add jeremylongshore/bobs-big-brain-plugin
   claude plugin marketplace update governed-second-brain
   claude plugin install governed-second-brain@governed-second-brain

2) Write my team connection file at ~/.teamkb/team.json (Windows: %USERPROFILE%\.teamkb\team.json · Linux: ~/.teamkb/team.json) with restrictive permissions (mode 600). Use this shape, replacing ALL three placeholders with values supplied privately by my team operator. If any value is missing, stop and ask for it. Do not infer a URL or tenant, invent a token, or write a placeholder as configuration. Handle the token without echoing it into chat or command history:

{
  "apiUrl": "PASTE-OPERATOR-API-URL",
  "apiToken": "PASTE-YOUR-TOKEN-HERE",
  "tenantId": "PASTE-OPERATOR-TENANT"
}

3) Tell me to fully quit and reopen Claude Code or Cowork. After restart, help me search for a known team topic using keywords and inspect the returned citations. Empty results require investigation; do not treat them as proof of a successful connection.

Prereqs: operator-provided team network access and connection values, plus desktop Claude. Do not rewrite the plugin manifest. Public marketplace only.
```

For connectivity troubleshooting, use the operator’s health-check instructions. A
healthy service alone does not verify your token, tenant or access to team knowledge.

---

## Local path (public / personal)

No team network or token. The plugin runs in-process over `~/.teamkb` on your
machine. Local mode needs one-time native dependency provisioning; see the
[installation guide](https://intentsolutions.io/bbb/install/) and current beta limits.

### Paste to Claude (local)

```
Install Bob's Big Brain (Governed Second Brain) for me as a LOCAL personal brain on this machine. Run these steps in order. Stop and tell me if any step errors.

1) Add and install the plugin from the repository’s public marketplace:
   claude plugin marketplace add jeremylongshore/bobs-big-brain-plugin
   claude plugin marketplace update governed-second-brain
   claude plugin install governed-second-brain@governed-second-brain

2) Keep me in LOCAL mode only:
   - Do NOT create ~/.teamkb/team.json
   - Do NOT set TEAMKB_API_URL, TEAMKB_API_TOKEN, or TEAMKB_TENANT_ID
   - If team.json already exists and I want local-only, tell me how to rename or remove it (do not delete without my confirmation)

3) Tell me to fully quit and reopen Claude Code or Cowork.

4) After restart, help me verify the governed-brain tools are available (brain_status or /brain). An empty local brain is normal on first install — I will feed it with /brain-save.

Do not rewrite the plugin manifest. Do not invent tokens. Do not connect me to any remote team API.
```

Empty brain on first install is **normal**. Capture with `/brain-save`, then search with keywords.

### Your own brain root and tenant (forkers / BYO brain)

Forkers can run their own governed brain entirely on-device. Leave
`TEAMKB_API_URL` unset, choose a private brain root, and choose a tenant name:

```bash
export TEAMKB_BASE_PATH="$HOME/.teamkb-my-fork"
export TEAMKB_TENANT_ID="my-fork"
npx governed-second-brain init "$HOME/my-notes" --index-only \
  --base "$TEAMKB_BASE_PATH" --tenant "$TEAMKB_TENANT_ID"
```

This uses no API key or network. The qmd index is derived at
`$TEAMKB_BASE_PATH/qmd-index/$TEAMKB_TENANT_ID`; `brain_govern` refreshes it
from the governed Markdown export. `brain_status` shows the resolved tenant
and qmd path, which is the quickest way to catch a wrong-root or wrong-tenant
configuration before grounding `/brain` on the fork's own corpus.

---

## Day to day

- **`/brain …`** — read (keywords, not full sentences)
- **`/brain-save …`** — write (team: governed for everyone; local: stays on your machine)

Installing and configuring the plugin makes the tools available. A standing
order in your client’s instructions can ask it to search first; installation
alone does not establish that behavior. See the [brain skill](../skills/brain/SKILL.md).

---

## How mode resolution works

```
real environment variable  →  ~/.teamkb/team.json  →  (absent → local mode)
```

`team.json` shape (team only, mode `600`):

```json
{
  "apiUrl": "PASTE-OPERATOR-API-URL",
  "apiToken": "PASTE-YOUR-TOKEN-HERE",
  "tenantId": "PASTE-OPERATOR-TENANT"
}
```

The JSON above is a template, not a working connection. Supply the operator’s exact
values, including `tenantId`. This setup procedure requires an explicit tenant even though
the runtime can select a default when it is omitted
that does not match your team. A present-but-malformed `team.json` refuses to
start instead of silently falling back to local. Valid JSON containing incorrect
connection values can still fail authentication or search.

---

## Troubleshooting (paste to Claude)

Check the [installation guide](https://intentsolutions.io/bbb/install/) and your
operator’s private instructions. Common team-mode causes:

- **Rotated token** → ask your operator for reissue
- **Wrong or missing `tenantId`** → verify the exact tenant with your operator
- **Missing team network access** → API unreachable
- **Unhelpful search results** → try distinctive topic keywords and inspect the citations

---

## Team operator notes

- Public marketplace: `jeremylongshore/bobs-big-brain-plugin` → no org membership / `gh` login required
- Give teammates their API URL, exact tenant, personal token and network instructions privately. Keep tokens out of public pages and scripts.
- For file-based configuration, keep the token in `team.json` with mode `600`. Avoid copying it into client manifests, shell history or chat.
- Public product and setup pages live at https://intentsolutions.io/bbb/. Keep deployment-specific instructions in your team’s private documentation.
- The legacy macOS `.command` remains in-tree; it is not the public installation entry point.
