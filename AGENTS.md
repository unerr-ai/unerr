<!-- unerr:start -->
## unerr — code navigation and editing tools

unerr serves this repo's live call graph, conventions, and edit guardrails over MCP.

For code in this repo:
- **Find / search:** `search_code({query})` — a task phrase ("where is retry handled") returns a recon bundle (focus body + callers + conventions in one call); a bare symbol returns ranked matches; `mode:'literal'|'regex'` replaces grep/rg.
- **Read:** `file_read({file_path})` · `{offset, limit}` · `{entity}` · `{outline:true}` — instead of cat/head/sed or built-in Read.
- **Edit:** `file_edit({old_string, new_string})` or `{content}` — no prior read needed.
- **Rename / signature change:** `get_references({key, include_text_occurrences:true})` — every use (callers + strings + config) in one call, then edit each site.
- **Web / docs:** `fetch_url({url})`, bulk `{urls:[...]}`.

Bash runs things (build, test, git, package managers); it is not for reading or searching code. When changing existing indexed code, start with one `search_code({query:"<task phrase>"})` recon call. Commands that can exceed 2 minutes run in the background with output to a log file.

Work that splits into independent slices can be delegated to the unerr sub-agents (`unerr-worker` for scoped edits, `unerr-junior` for read-only recon and verify-runs) — their descriptions state when each applies.

Tool responses may carry `ur|<tag>` signal lines; the body of each line names the concrete next step.

If unerr MCP is unavailable, errors, or reports no graph: use built-in Read/Grep/Glob for the rest of the session.

### `@sem` comments

Exported entities here carry a doc comment (1–2 sentences, what + why) ending `@sem domain=<tag> role=<tag>`. An edit that changes what an entity does updates its comment in the same edit; a new exported entity gets one before the next edit. Keep existing `@sem` lines unless the user removes them.

<!-- unerr:end -->
