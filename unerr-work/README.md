# unerr-work

unerr for document work. No codebase, no code graph.

## What it adds

- `run_command` — runs a command and returns compressed output instead of the full dump.
- `fetch_url` — fetches one page or many, ranks the passages, returns only what the question needs.
- Five sub-agents that take work off the main thread so it keeps its context.

## Install in Cowork

Add the marketplace once. Updates then come from it.

1. Open **Customize** in the sidebar, then **Plugins**.
2. Under **Personal plugins**, click **+**, then **Add marketplace**.
3. Enter `unerr-ai/unerr`, then install **unerr-work**.

A marketplace you added yourself does not refresh silently. Press its
**Update** button, or have an admin add it at
`claude.ai/admin-settings/plugins` with sync turned on — that path pushes
every change to the whole team.

### Or upload the file

Choose the upload option on the Plugins page and pick `unerr-work.zip`,
written beside this folder. An uploaded copy never updates itself —
upload again to move to a new version.

## Load it in Claude Code

```bash
claude plugin marketplace add unerr-ai/unerr
claude plugin install unerr-work@unerr
```
