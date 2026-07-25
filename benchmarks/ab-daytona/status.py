#!/usr/bin/env python3
"""Live status of a running (or finished) harbor job.

Usage: status.py <JOB_DIR> [TOTAL_TASKS]

Reports three things:

  1. progress   — completed / resolved / errored against the task total
  2. cost       — harbor's own per-trial `agent_result.cost_usd` (exact)
  3. model mix  — cost split BY MODEL, read from `message.model` in the session
                  .jsonl. unerr sub-agents can spawn a different model than the
                  one under test, so a run is not necessarily single-model:
                  anything pricier than the main model is an escalation,
                  anything cheaper a de-escalation.

Costs are deduped on message.id — Claude Code writes one API response as one
.jsonl line per content block (thinking / text / tool_use) and repeats the full
message.usage on each, so summing lines charges a response 1-3x. Deduped sums
reproduce harbor's cost_usd to 6 decimals.

Stdlib only.
"""
import glob
import json
import os
import sys

# $/M tokens as (input, cache_write_5m, cache_read, output), sticker rates.
RATES = {
    "opus": (5.0, 6.25, 0.5, 25.0),
    "sonnet": (3.0, 3.75, 0.3, 15.0),
    "haiku": (1.0, 1.25, 0.1, 5.0),
}
# Rank for escalation/de-escalation, by output price.
TIER = {"haiku": 0, "sonnet": 1, "opus": 2}

# Sonnet 5 introductory discount (uniform 2/3 of sticker), through 2026-08-31.
SONNET_5_INTRO_FACTOR = 2.0 / 3.0

# (trial, n_extra_result_envelopes) for retried trials — spend harbor discards.
RETRIED: list[tuple[str, int]] = []


def family(model: str) -> str:
    m = (model or "").lower()
    for f in ("opus", "sonnet", "haiku"):
        if f in m:
            return f
    return "sonnet"


def _load(path: str):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def model_costs(trial_dir: str) -> dict[str, list]:
    """{model: [in, cache_w, cache_r, out, cost]} per model for one trial.

    Primary source is Claude Code's own `modelUsage` in the `type:"result"`
    envelope at the end of agent/claude-code.txt — it carries costUSD per model
    and is what harbor's cost_usd is built from. Deriving from the session
    .jsonl instead UNDER-counts: some API calls (web-search round trips, aux
    calls) never land there as assistant entries.
    """
    out: dict[str, list] = {}
    for f in glob.glob(os.path.join(trial_dir, "**", "claude-code.txt"), recursive=True):
        # A retried trial emits more than one result envelope. Harbor's
        # agent_result.cost_usd takes the FIRST, so take the first here too or
        # the split stops reconciling with the headline cost. RETRIED counts
        # the extras so the discarded spend is visible rather than silent.
        first = None
        extra = 0
        try:
            fh = open(f, encoding="utf-8", errors="ignore")
        except Exception:
            continue
        with fh:
            for line in fh:
                if '"modelUsage"' not in line:
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if o.get("type") != "result":
                    continue
                if first is None:
                    first = o
                else:
                    extra += 1
        if extra:
            RETRIED.append((os.path.basename(trial_dir), extra))
        for model, mu in ((first or {}).get("modelUsage") or {}).items():
            t = out.setdefault(model, [0, 0, 0, 0, 0.0])
            t[0] += mu.get("inputTokens", 0) or 0
            t[1] += mu.get("cacheCreationInputTokens", 0) or 0
            t[2] += mu.get("cacheReadInputTokens", 0) or 0
            t[3] += mu.get("outputTokens", 0) or 0
            t[4] += mu.get("costUSD", 0.0) or 0.0
    if out:
        return out
    return _model_costs_from_sessions(trial_dir)


def _model_costs_from_sessions(trial_dir: str) -> dict[str, list]:
    """Fallback for a trial with no result envelope (killed mid-run)."""
    out: dict[str, list] = {}
    pattern = os.path.join(trial_dir, "**", "sessions", "**", "*.jsonl")
    for f in glob.glob(pattern, recursive=True):
        seen: set = set()
        try:
            fh = open(f, encoding="utf-8", errors="ignore")
        except Exception:
            continue
        with fh:
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
                mid = msg.get("id") or o.get("requestId")
                if mid is not None:
                    if mid in seen:
                        continue
                    seen.add(mid)
                model = msg.get("model") or "unknown"
                t = out.setdefault(model, [0, 0, 0, 0, 0.0])
                v = (
                    u.get("input_tokens", 0) or 0,
                    u.get("cache_creation_input_tokens", 0) or 0,
                    u.get("cache_read_input_tokens", 0) or 0,
                    u.get("output_tokens", 0) or 0,
                )
                for i in range(4):
                    t[i] += v[i]
                r = RATES[family(model)]
                t[4] += sum(v[i] * r[i] for i in range(4)) / 1e6
    return out


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: status.py <JOB_DIR> [TOTAL_TASKS]", file=sys.stderr)
        return 64
    argv = [a for a in sys.argv[1:] if not a.startswith("--")]
    job = argv[0]
    total = int(argv[1]) if len(argv) > 1 else 89

    completed = resolved = errored = 0
    cost = 0.0
    by_model: dict[str, list] = {}
    unresolved: list[str] = []

    for path in sorted(glob.glob(os.path.join(job, "*", "result.json"))):
        d = _load(path)
        if not isinstance(d, dict) or d.get("finished_at") is None:
            continue
        completed += 1
        name = d.get("task_name") or os.path.basename(os.path.dirname(path))
        if d.get("exception_info"):
            errored += 1
        rewards = (d.get("verifier_result") or {}).get("rewards") or {}
        if rewards.get("reward") == 1.0:
            resolved += 1
        else:
            unresolved.append(name)
        ar = d.get("agent_result") or {}
        if ar.get("cost_usd"):
            cost += ar["cost_usd"]
        for model, t in model_costs(os.path.dirname(path)).items():
            agg = by_model.setdefault(model, [0, 0, 0, 0, 0.0])
            for i in range(4):
                agg[i] += t[i]
            agg[4] += t[4]

    # Harbor keeps live counts in the job-level result.json (written at START and
    # updated as trials land) — prefer them over globbing. finished_at stays None
    # until the whole job ends, so it is the only valid terminal signal.
    job_stats = _load(os.path.join(job, "result.json")) or {}
    live = job_stats.get("stats") or {}
    total = job_stats.get("n_total_trials") or total
    running = live.get("n_running_trials")
    pending = live.get("n_pending_trials")
    if running is None:
        running = max(0, len(glob.glob(os.path.join(job, "*", "config.json"))) - completed)

    pct = (100.0 * resolved / completed) if completed else 0.0
    state = "FINISHED" if job_stats.get("finished_at") else "running"

    if "--line" in sys.argv:
        # One compact line, for a periodic monitor.
        mix = ""
        if by_model:
            # Shares are of the modelUsage total, not harbor's cost — harbor
            # discards a retried trial's extra runs, so the two differ.
            mtot = sum(t[4] for t in by_model.values()) or cost
            main_model = max(by_model.items(), key=lambda kv: kv[1][4])[0]
            main_tier = TIER[family(main_model)]
            parts = []
            for model, t in sorted(by_model.items(), key=lambda kv: -kv[1][4]):
                share = 100.0 * t[4] / mtot if mtot else 0.0
                short = model.replace("claude-", "")
                tier = TIER[family(model)]
                if model == main_model:
                    parts.append(f"{short} {share:.0f}%")
                else:
                    kind = "ESC" if tier > main_tier else "DEESC"
                    parts.append(f"{kind} {short} {share:.1f}% (${t[4]:.2f})")
            mix = " | " + ", ".join(parts)
        billed = cost * SONNET_5_INTRO_FACTOR
        print(
            f"{completed}/{total} done, {running} run, {pending} pend | "
            f"resolved {resolved}/{completed} ({pct:.0f}%), err {errored} | "
            f"${cost:.2f} stk / ${billed:.2f} billed{mix}"
        )
        return 0
    print(f"\n=== {job}  [{state}] ===")
    tail = f"   {pending} pending" if pending is not None else ""
    print(f"  progress   {completed}/{total} completed   {running} in flight{tail}")
    print(f"  resolved   {resolved}/{completed} ({pct:.1f}%)   errored {errored}")
    print(f"  cost       ${cost:.2f} so far (harbor agent_result.cost_usd, sticker)")

    if by_model:
        mtot = sum(t[4] for t in by_model.values()) or cost
        main_model = max(by_model.items(), key=lambda kv: kv[1][4])[0]
        main_tier = TIER[family(main_model)]
        print("\n  by model (sticker rates):")
        for model, t in sorted(by_model.items(), key=lambda kv: -kv[1][4]):
            tier = TIER[family(model)]
            tag = (
                "main"
                if model == main_model
                else ("ESCALATION" if tier > main_tier else "de-escalation")
            )
            share = 100.0 * t[4] / mtot if mtot else 0.0
            print(
                f"    {model:<20} ${t[4]:>8.2f}  {share:>5.1f}%  "
                f"in={t[0]:>9,} cache_w={t[1]:>10,} cache_r={t[2]:>12,} "
                f"out={t[3]:>9,}   [{tag}]"
            )
        off = sum(t[4] for m, t in by_model.items() if m != main_model)
        if off:
            print(f"    -> {off / mtot * 100:.1f}% of spend was NOT the model under test")

        if "sonnet-5" in main_model:
            print(
                f"\n  sonnet-5 intro rate ($2/$10 through 2026-08-31) "
                f"-> billed ~${cost * SONNET_5_INTRO_FACTOR:.2f}"
            )

    if RETRIED:
        n = sum(e for _, e in RETRIED)
        print(f"\n  retried: {len(RETRIED)} trials, {n} extra run(s) — spend harbor's total excludes")

    if unresolved:
        print(f"\n  unresolved ({len(unresolved)}):")
        for n in unresolved[:20]:
            print(f"    {n}")
        if len(unresolved) > 20:
            print(f"    ... and {len(unresolved) - 20} more")
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
