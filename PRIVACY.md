# Privacy

unerr's code intelligence — the code graph, search, edits — runs entirely on
your machine and needs no account for any of it.

Two things still reach the network even with no account: a daily check for a
new unerr version, and, for a few languages, a one-time download of a parsing
tool. Neither is telemetry and neither sends anything about your account or
your code. Both are described in full in section 4. Outside those two and an
explicit action you take yourself — asking an agent to fetch a URL, or
turning on the optional MCP router to reach servers you've configured —
nothing else leaves an account-less machine on its own.

Cloud sync — usage telemetry, team conventions, fleet inventory — is a
separate, paid feature. It only sends data once you are logged in. This page
covers all of it: what cloud sync sends, the background plan check, the two
account-less network calls, and the three ways to turn cloud sync off.

## 1. Cloud sync — only once you are logged in on a paid plan

### What is sent

| Sent | Examples |
|---|---|
| Machine facts | OS, CPU architecture, hostname, unerr version, daemon uptime and memory |
| Repo inventory | The repo's folder path and name, a one-way hash of its git remote (or path), live status, process id, port, memory, and code-graph size (entity/edge counts) |
| Usage events | Which MCP tool ran, how long it took, session and turn boundaries, git branch and commit hash |
| Agent transcripts | A stripped summary event only — see below |

Every event goes through the same filter before it leaves your machine: any
field that could hold code, file content, a file path, a prompt, transcript
text, or a credential is dropped or clipped. The repo inventory row is the
one deliberate exception — it carries the repo's own path and name so your
team dashboard can show which repos are registered on which machine. A repo
that opts out (section 3) is left out of that inventory entirely.

### What is never sent

- Source code, diffs, patches, or file contents
- File paths inside a repo (only a repo's own root path is ever sent, as
  inventory metadata for that repo — never a path to a file inside it)
- Prompts, raw agent transcript text, or tool output text
- Credentials, tokens, API keys, passwords, or emails found in your code

### When it is sent

Cloud sync runs on a timer in the background daemon (`unerrd`): roughly
every 10 seconds for usage events, and every 15 minutes for a machine
heartbeat/inventory. Nothing is sent on demand from a tool call, and nothing
is sent synchronously — an agent's response never waits on a network
request.

## 2. Checking your plan — runs for any logged-in account, free included

If you are logged in, the CLI checks your plan roughly every 12 hours. This
is the only way an upgrade (free to paid) is noticed automatically, without
logging out and back in — so it runs on the free plan too. It sends your
account token and the CLI's version, nothing else: no usage data, no repo
names, no file paths.

Right after a successful plan check, if your plan includes shared team
conventions, the CLI also pulls that document the same way (a GET request,
same account token, same cadence).

## 3. Three ways to turn off account-linked network calls

1. **Don't create an account.** No login, no plan check, no cloud sync, no
   conventions pull. This is the default.
2. **Set an environment variable**, even on a paid, logged-in account:
   `UNERR_NO_TELEMETRY=1` or `DO_NOT_TRACK=1`. Either one stops cloud sync,
   the plan check, and the conventions pull.
3. **Set a config key**, `"telemetry": false`, in a `.unerr/config.json`:
   - In one repo's file — stops that repo's cloud sync (both its usage
     events and its row in the fleet inventory).
   - In the machine-wide file, `~/.unerr/config.json` — stops the plan
     check, the conventions pull, and cloud sync for every repo.
   - The two files are independent opt-outs, not an override: whichever one
     says `false` wins. A machine-wide `true` can never turn a repo's own
     `false` back on, and vice versa.

**Trade-off:** with either switch on, the CLI stops asking the server about
your plan. If you upgrade while a switch is set, the CLI won't notice until
you remove the switch (or run `unerr login` again).

## 4. Two network calls that run with no account at all

These are not telemetry and are not covered by the switches above — they
are how the CLI checks for its own updates and gets a parsing tool it
doesn't ship with. There is currently no setting to turn either one off.

- **Version check.** Once every 24 hours, the background daemon asks
  `registry.npmjs.org` for the latest published version of
  `@unerr-ai/unerr`. This is an anonymous, unauthenticated request — the
  same one your browser would make visiting the npm page for the package.
  It carries no account information and nothing about your code.
- **Language-tool download.** When you index a repo written in Go, Java,
  Rust, Ruby, or C/C++, and the matching parser (`scip-go`, `scip-java`,
  `rust-analyzer`, `scip-ruby`, `scip-clang`) isn't already on your machine,
  unerr downloads it once from that project's GitHub releases and caches it
  in `~/.unerr/bin/` for every repo to reuse. TypeScript and Python never
  trigger this — their parsers ship inside unerr. If the tool is already
  installed and on your `PATH`, unerr uses that instead and downloads
  nothing.
