# Your data

unerr writes what it learns about your repository into a folder inside that
repository. This page documents what is in it, what format it uses, and how to
read it yourself.

The short version: this data is yours, it stays on your machine, and the format
is stable and versioned. It leaves your machine only if you log in on a paid
plan, and then only in the filtered form described in
[PRIVACY.md](../PRIVACY.md).

## Where it lives

Everything sits under `.unerr/` in the root of each repository. Add that to your
`.gitignore`, since unerr commits nothing itself.

| Path | What it holds |
|---|---|
| `.unerr/graph.db` | The code map: every function, class, and call relationship unerr found. |
| `.unerr/events/*.jsonl` | The record of what your agents did, one JSON object per line. |
| `.unerr/ledger/shadow.jsonl` | Every tool call, append-only, in the order it happened. |
| `.unerr/cache/transcripts.jsonl` | Per-turn token counts from your agent, used for the cost metrics. |
| `.unerr/config.json` | This repository's settings, including the telemetry opt-out. |
| `.unerr/logs/` | Process logs. Rotated daily, kept 7 days. |
| `.unerr/state/` | Process id and socket for the running local process. |
| `.unerr/snapshots/`, `.unerr/scip/` | Cached index data, rebuilt from your source. |

A machine-wide folder at `~/.unerr/` holds the process registry, downloaded
language parsers, and machine-level logs. It never holds your code.

## The event format

`.unerr/events/` is the part worth knowing about. It records agent activity, and
it has the same shape whether it stays local or gets synced.

Each file holds one JSON object per line and is only ever appended to, so you
can tail it while work is happening. A torn last line, from reading mid-write,
gets skipped rather than breaking the read.

Files are split by writer. `proxy.jsonl` comes from the per-repository process,
`mcp-<pid>.jsonl` from an editor session, `hook-<pid>.jsonl` from an agent hook,
and `fleet.jsonl` carries machine-level rows. Splitting this way means two
processes never contend for one file.

Lines expire after 5 days, dropped by a rolling sweep. If you want a longer
history, copy the files somewhere else on a schedule. unerr will not do it for
you, and it will not stop you.

### The shared envelope

Every event carries these fields:

| Field | What it is |
|---|---|
| `schema_version` | The format version. Currently `1-0-11`. |
| `event_id` | A UUID generated on your machine, also the deduplication key. |
| `ts` | When the turn ended, ISO-8601. |
| `type` | Which kind of event this is. |
| `agent` | Which coding tool produced it, such as `claude-code` or `cursor`. |
| `repo` | A salted one-way hash of your git remote. Never a path. |
| `machine_fingerprint` | A salted one-way hash identifying this machine. Never a hostname, MAC address, or raw hardware id. |
| `detail` | The fields specific to this event type. |

Both hashes are one-way and salted, so they group rows together without
identifying anything. No user or organization field appears on the wire. When
you are logged in, identity comes from your token rather than the event body.

### The event types

Seventeen, in four groups:

- Usage: `token_flow`, `compression`, `behavior`, `file_read`,
  `session_summary`, `repo_activity`
- Traces: `transcript`, `ledger`, `router`
- State: `session`, `fact`, `timeline`, `state`, `drift`, `review_finding`
- Machine: `machine_inventory`, `machine_checkin`

### Versioning

The version string reads `MODEL-REVISION-ADDITION`. Adding an optional field
bumps the last number, and readers accept any `1-0-x`. An old copy of unerr and
a new one can therefore write into the same store without either breaking. A
change that genuinely broke the format would bump the first number, and would be
a different contract.

The schema is defined once, in the open, at
[unerr-ai/unerr-contracts](https://github.com/unerr-ai/unerr-contracts).

## Token field names

The raw per-turn counters live in `.unerr/cache/transcripts.jsonl`:

| unerr field | OpenTelemetry equivalent |
|---|---|
| `tokens_input` | `gen_ai.usage.input_tokens` |
| `tokens_output` | `gen_ai.usage.output_tokens` |
| `tokens_cache_create` | no stable equivalent yet |
| `tokens_cache_read` | no stable equivalent yet |

The first two line up with the [OpenTelemetry generative-AI
conventions](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/),
so exporting into an existing observability setup needs no translation table.
Those conventions are still marked experimental, so we track them rather than
claim compliance.

The two cache counters have no agreed name yet. We kept our own instead of
guessing at one that might land differently, and we will adopt the standard
names once they settle.

This transcript file sits outside `.unerr/events/` and nothing in it is ever
synced. The cost metrics are computed from it locally, and only their results
can leave.

## Reading your own data

The files are line-delimited JSON, so ordinary tools work:

```bash
# Every event from a given day onward
cat .unerr/events/*.jsonl | jq -c 'select(.ts > "2026-08-11")'

# Count events by type
cat .unerr/events/*.jsonl | jq -r '.type' | sort | uniq -c | sort -rn

# Every tool call in order
cat .unerr/ledger/shadow.jsonl | jq -r '"\(.ts) \(.tool)"'

# Token totals for the current session
cat .unerr/cache/transcripts.jsonl \
  | jq -s 'map(.tokens_input + .tokens_output) | add'
```

To export, copy the folder. There is no export command and no lock to work
around, because these are plain files and they belong to you.

To delete, remove the folder. unerr rebuilds the code map from your source on
the next run, so you lose the history rather than the functionality.

## What leaves your machine

Nothing, unless you log in on a paid plan.

Logged out or on the free plan, the only traffic is a daily version check
against the npm registry and a one-time parser download for certain languages.
Neither carries anything about your code or your account.

Syncing this data to a hosted dashboard is a paid feature, because it runs on
our servers and stores your history there. The client that does the syncing is
in this repository under Apache-2.0, so you can read exactly what it sends.
Whatever it sends is filtered first: any field that could carry source code, a
file path, a prompt, transcript text, or a credential is dropped or clipped
before it goes.

[PRIVACY.md](../PRIVACY.md) has the field-by-field detail and the three ways to
switch syncing off.
