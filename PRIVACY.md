# Privacy

unerr runs locally by default. With no account, it makes zero network calls —
the code graph, the file watcher, and every MCP tool run entirely on your
machine, forever.

Cloud sync is a separate, paid feature. It only turns on when you log in on a
paid plan. This page explains exactly what that sync sends, when, what it
never sends, and the three ways to turn it off.

## With no account: nothing leaves your machine

If you have never run `unerr login`, or you're on the free plan, unerr makes
no network requests at all. Everything — indexing, search, edits, the local
event log under `.unerr/events/` — stays on disk.

## What is sent, only when logged in on a paid plan

| Sent | Examples |
|---|---|
| Machine facts | OS, CPU architecture, hostname, unerr version, daemon uptime and memory |
| Repo inventory | The repo's folder path and name, a one-way hash of its git remote (or path), live status (running/stopped), process id, port, memory, and code-graph size (entity/edge counts) |
| Usage events | Which MCP tool ran, how long it took, session and turn boundaries, git branch and commit hash |
| Agent transcripts | A stripped summary event only — see below |

Every event goes through the same filter before it leaves your machine: any
field that could hold code, file content, a file path, a prompt, transcript
text, or a credential is dropped or clipped. This is why "repo inventory"
above says path and name, but "usage events" carries no paths — the inventory
row is the one deliberate exception, sent so your team dashboard can show
which repos are registered on which machine.

## What is never sent

- Source code, diffs, patches, or file contents
- File paths inside a repo (only the repo's own root path is sent, as
  inventory metadata — never a path to a file inside it)
- Prompts, raw agent transcript text, or tool output text
- Credentials, tokens, API keys, passwords, or emails found in your code

## When it is sent

Cloud sync runs on a timer in the background daemon (`unerrd`), roughly every
10 seconds for usage events and every 15 minutes for a machine heartbeat. It
only runs while you are logged in on a paid plan. Nothing is sent on demand
from a tool call, and nothing is sent synchronously — an agent's response
never waits on a network request.

## Three ways to turn it off

1. **Don't create an account.** This is the default. No login means no
   network calls, period.
2. **Set an environment variable**, even on a paid account:
   `UNERR_NO_TELEMETRY=1` or `DO_NOT_TRACK=1`. Either one stops every cloud
   push.
3. **Set a config key**, `"telemetry": false`:
   - In one repo's `.unerr/config.json` — stops sync for that repo only.
   - In `~/.unerr/config.json` — stops sync for every repo on the machine.
     This machine-wide setting always wins over a per-repo setting.
