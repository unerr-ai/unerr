# L6 correlation-key spike — does the hook carry Claude's native session id?

**Question (docs/logbook-page-redesign.md §10.2):** Can we address the Claude
JSONL file directly via the agent's native `session_id` + `cwd` captured at the
`UserPromptSubmit` hook, or is a fallback (cwd→mangled-dir + verbatim prompt +
timestamp window) required?

**Short answer:** A fallback IS required for now. Claude Code's native
`session_id` and `cwd` ARE present in the raw hook payload, but the current code
does NOT store either on the `user_prompt_received` event — and it actively
prefers unerr's own 6-char hex session id over Claude's UUID.

## Findings (verbatim from the tree, 2026-05-25)

### 1. Is the payload carrying `session_id` + `cwd`? — YES (in `raw`)

- `src/hooks/adapters/claude-code.ts:54` returns `{ raw: payload, … }` — the
  adapter passes the entire Claude Code payload through untouched as `raw`.
  Claude Code's documented `UserPromptSubmit` payload includes `session_id`,
  `cwd`, `transcript_path`, `hook_event_name`, and `prompt`, so `raw.session_id`,
  `raw.cwd`, and `raw.transcript_path` are all reachable.
- `src/hooks/prompt-hooks.ts:547-550` reads the session id as:
  ```ts
  const sessionId =
    process.env.UNERR_SESSION_ID ??
    (raw.session_id as string | undefined) ??
    "unknown";
  ```
  So it CAN read `raw.session_id`, but `UNERR_SESSION_ID` (unerr's own 6-char
  hex from `log-paths.ts`) takes precedence. In the common case the value that
  flows downstream is the hex, NOT Claude's UUID.
- `cwd` at `prompt-hooks.ts:546` comes from `process.cwd()`, **not** the
  payload. `raw.cwd` is ignored.

### 2. Does `user_prompt_received` store them? — NO

- `src/hooks/prompt-capture.ts:66-92` (`recordUserPromptReceived`) writes the
  `user_prompt_received` behavior_events row. It stores:
  - column `session_id` = whatever `sessionId` was passed in (hex-preferred, see
    above) — so **not Claude's UUID** in practice.
  - `detail` = `{ length, classified_as, hook_payload_chars, prompt }`.
- Neither Claude's native `sessionId` (UUID) nor `cwd` nor `transcript_path` is
  persisted anywhere on the event. There is no column or detail field for them.

### 3. Consequence for L7

Because the JSONL file name IS Claude's `<session-uuid>.jsonl`, and that UUID is
not stored, we cannot address the file directly today. Two viable paths:

- **Preferred (later phase, NOT done here — hook/capture wiring is out of L6
  scope):** store `raw.session_id` (Claude UUID) and `raw.cwd` (and ideally
  `raw.transcript_path`, which is the JSONL path verbatim) on the
  `user_prompt_received` detail bag. `transcript_path` would make the file
  directly addressable with zero mangling/correlation.
- **Fallback that works NOW (no capture change):** the reader scopes by
  `mangleCwd(repoCwd)` to this repo's projects dir, then disambiguates among
  session files by (a) verbatim `promptText` match against user turns — Fix J
  already stores the exact prompt string — and/or (b) a `timeWindowMs` mtime/
  timestamp window. Both are implemented in
  `readClaudeTranscript({ repoCwd, promptText?, timeWindowMs? })`.

**Recommendation:** ship the fallback for L7's first cut; add the
`raw.session_id`/`raw.cwd`/`raw.transcript_path` capture as a small follow-up so
the trace becomes directly addressable and exact. The reader already accepts a
`sessionId` so that upgrade is a drop-in once capture lands.

> Per scope, this spike did NOT modify `prompt-hooks.ts` or `prompt-capture.ts`.
