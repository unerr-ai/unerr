#!/usr/bin/env python3
"""Print a harbor job's token/cost summary to stdout, so the Fly machine logs
carry the numbers even when nothing is uploaded.

Usage: summarize.py <JOB_DIR> [MODEL]

Reads harbor's OWN accounting, in this order:

  1. <JOB>/result.json          -> stats.cost_usd + n_*_tokens   (job total)
  2. <JOB>/*/result.json        -> agent_result.cost_usd          (per trial)
  3. session .jsonl             -> summed message.usage           (fallback only)

Levels 1 and 2 are what harbor got from Claude Code's own `total_cost_usd`, so
they are exact. Level 3 exists only for a job killed before harbor wrote any
result.json, and it must dedupe: Claude Code writes one API response as one
.jsonl line PER CONTENT BLOCK (thinking / text / tool_use), and every one of
those lines repeats the full message.usage, so summing lines charges a response
1-3x. Deduping on message.id reproduces harbor's cost_usd to 6 decimals
(verified against 8 runs, both models).

Reported cost is at sticker rates. Claude Sonnet 5 bills at an introductory
$2/$10 through 2026-08-31 -- a uniform 2/3 of sticker across all four token
classes -- so for sonnet-5 this prints the adjusted figure too.
"""
import glob
import json
import os
import sys

# $/M tokens as (input, cache_write_5m, cache_read, output).
# cache_write_5m = 1.25x input, cache_read = 0.1x input. Fallback path only.
RATES = {
    "opus": (5.0, 6.25, 0.5, 25.0),
    "sonnet": (3.0, 3.75, 0.3, 15.0),
}

# Sonnet 5 introductory discount, uniform across token classes. Drop this and
# the call sites after 2026-08-31, when sonnet-5 reverts to sticker.
SONNET_5_INTRO_FACTOR = 2.0 / 3.0
SONNET_5_INTRO_UNTIL = "2026-08-31"


def price_key(model: str) -> str:
    return "opus" if "opus" in model else "sonnet"


def _load(path: str):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def per_trial_rows(job: str) -> list[tuple[str, dict]]:
    """(task_name, agent_result) for every trial harbor recorded."""
    rows = []
    for path in sorted(glob.glob(os.path.join(job, "*", "result.json"))):
        d = _load(path)
        if not isinstance(d, dict):
            continue
        ar = d.get("agent_result")
        if isinstance(ar, dict) and ar.get("cost_usd") is not None:
            rows.append((d.get("task_name") or os.path.basename(os.path.dirname(path)), ar))
    return rows


def fallback_from_sessions(job: str, pk: str) -> tuple[list, list, float]:
    """Sum message.usage from session .jsonl, deduped on message.id."""
    r_in, r_cw, r_cr, r_out = RATES[pk]
    files = glob.glob(os.path.join(job, "**", "sessions", "**", "*.jsonl"), recursive=True)
    if not files:
        files = glob.glob(os.path.join(job, "**", "*.jsonl"), recursive=True)

    rows = []
    g = [0, 0, 0, 0]  # input, cache_write, cache_read, output
    for f in sorted(files):
        t = [0, 0, 0, 0]
        seen: set = set()
        try:
            with open(f, encoding="utf-8", errors="ignore") as fh:
                for line in fh:
                    if '"usage"' not in line:
                        continue
                    try:
                        o = json.loads(line)
                    except Exception:
                        continue
                    msg = o.get("message") or {}
                    u = msg.get("usage") or o.get("usage")
                    if not isinstance(u, dict):
                        continue
                    # One response, one charge -- see the module docstring.
                    mid = msg.get("id") or o.get("requestId")
                    if mid is not None:
                        if mid in seen:
                            continue
                        seen.add(mid)
                    t[0] += u.get("input_tokens", 0) or 0
                    t[1] += u.get("cache_creation_input_tokens", 0) or 0
                    t[2] += u.get("cache_read_input_tokens", 0) or 0
                    t[3] += u.get("output_tokens", 0) or 0
        except Exception:
            continue
        if sum(t) == 0:
            continue
        cost = (t[0] * r_in + t[1] * r_cw + t[2] * r_cr + t[3] * r_out) / 1e6
        rows.append((os.path.relpath(f, job), t, cost))
        for i in range(4):
            g[i] += t[i]
    total = (g[0] * r_in + g[1] * r_cw + g[2] * r_cr + g[3] * r_out) / 1e6
    return rows, g, total


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: summarize.py <JOB_DIR> [MODEL]", file=sys.stderr)
        return 64
    job = sys.argv[1]
    model = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("MODEL", "claude-opus-4-8")
    is_sonnet_5 = "sonnet-5" in model

    job_result = _load(os.path.join(job, "result.json")) or {}
    stats = job_result.get("stats") or {}
    trials = per_trial_rows(job)
    total = stats.get("cost_usd")
    source = "harbor result.json"

    if total is None and trials:
        total = sum(ar["cost_usd"] for _, ar in trials)
        source = "harbor per-trial agent_result"

    print(f"\n=== token/cost summary — {job} ===")

    if total is not None:
        for name, ar in trials:
            print(
                f"  {name}\n"
                f"    in={ar.get('n_input_tokens', 0):>9,}  "
                f"cached={ar.get('n_cache_tokens', 0):>11,}  "
                f"out={ar.get('n_output_tokens', 0):>8,}   ${ar['cost_usd']:.4f}"
            )
        done = stats.get("n_completed_trials", len(trials))
        errored = stats.get("n_errored_trials", 0)
        print(
            f"  TOTAL  in={stats.get('n_input_tokens', 0):,}  "
            f"cached={stats.get('n_cache_tokens', 0):,}  "
            f"out={stats.get('n_output_tokens', 0):,}   ${total:.4f}"
        )
        print(f"  trials: {done} completed, {errored} errored   [source: {source}]")
    else:
        pk = price_key(model)
        rows, g, total = fallback_from_sessions(job, pk)
        print(f"  [no harbor result.json — falling back to session .jsonl at {pk} rates]")
        if not rows:
            print("  (no session .jsonl with usage found)")
        for rel, t, cost in rows:
            print(f"  {rel}")
            print(
                f"    in={t[0]:>9,}  cache_w={t[1]:>10,}  "
                f"cache_r={t[2]:>11,}  out={t[3]:>8,}   ${cost:.4f}"
            )
        print(
            f"  TOTAL  in={g[0]:,}  cache_w={g[1]:,}  "
            f"cache_r={g[2]:,}  out={g[3]:,}   ${total:.4f}"
        )

    if is_sonnet_5 and total:
        billed = total * SONNET_5_INTRO_FACTOR
        print(
            f"  sonnet-5 intro rate ($2/$10 through {SONNET_5_INTRO_UNTIL}) "
            f"-> billed ${billed:.4f}"
        )
    print("=== end summary ===\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
