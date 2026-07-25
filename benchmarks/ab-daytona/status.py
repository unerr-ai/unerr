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
import re
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


# Recovery-pointer grammars a compressed tool result offers:
#   tee   — src/proxy/shell-compressor.ts:588
#           "[full output <KB>KB: file_read({file_path:'<path>', offset:0, limit:200})]"
#   cache — src/proxy/reversible-cache.ts CACHE_MARKER_PREFIX/LEGEND
#           "ur|cache-ref ..." alongside a "cache_ref:'<hash>'" (or JSON "cache_ref":"<hash>")
_TEE_PTR_RE = re.compile(r"\[full output[^\n]*?file_read\(\{file_path:'([^']+)'")
_CACHE_REF_RE = re.compile(r"cache_ref['\"]?\s*:\s*['\"]([^'\"]+)['\"]")
_UR_CACHE_REF_RE = re.compile(r"ur\|cache-ref")


def _recovery_pointer_keys(content: str) -> list[str]:
    """Recovery-pointer keys (tee path / cache_ref hash) offered in one tool result."""
    keys: list[str] = []
    for m in _TEE_PTR_RE.finditer(content):
        keys.append(m.group(1))
    for m in _CACHE_REF_RE.finditer(content):
        if m.group(1) not in keys:
            keys.append(m.group(1))
    if not keys and _UR_CACHE_REF_RE.search(content):
        # Marker present with no parseable key — still count the offer so the
        # ratio isn't silently undercounted; it can never register as followed.
        keys.append("ur|cache-ref")
    return keys


def trial_metrics(trial_dir: str) -> tuple[float | None, int, int]:
    """(turn-1 prefix tokens, recovery pointers offered, recovery pointers followed).

    Reads agent/trajectory.json (ATIF schema). Prefix is metrics.prompt_tokens on
    the FIRST source=="agent" step. A recovery pointer offered in one step's
    observation is "followed" if a LATER agent step has a file_read tool_call
    whose arguments reference the same path / cache_ref.
    """
    traj_paths = glob.glob(os.path.join(trial_dir, "**", "trajectory.json"), recursive=True)
    if not traj_paths:
        return None, 0, 0
    d = _load(traj_paths[0])
    if not isinstance(d, dict):
        return None, 0, 0
    steps = d.get("steps") or []

    prefix_tokens = None
    offers: list[tuple[int, str]] = []
    reads_by_step: dict[int, list[str]] = {}

    for idx, s in enumerate(steps):
        if not isinstance(s, dict) or s.get("source") != "agent":
            continue
        if prefix_tokens is None:
            pt = (s.get("metrics") or {}).get("prompt_tokens")
            if isinstance(pt, (int, float)):
                prefix_tokens = pt

        for tc in s.get("tool_calls") or []:
            if (tc.get("function_name") or "") in ("mcp__unerr__file_read", "file_read"):
                reads_by_step.setdefault(idx, []).append(json.dumps(tc.get("arguments") or {}))

        for r in (s.get("observation") or {}).get("results") or []:
            content = r.get("content")
            if isinstance(content, str):
                offers.extend((idx, key) for key in _recovery_pointer_keys(content))

    if not offers:
        return prefix_tokens, 0, 0

    followed = sum(
        1
        for off_idx, key in offers
        if any(
            key in haystack
            for step_idx, haystacks in reads_by_step.items()
            if step_idx > off_idx
            for haystack in haystacks
        )
    )
    return prefix_tokens, len(offers), followed


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
    prefix_sum = 0.0
    prefix_n = 0
    recovery_offered = 0
    recovery_followed = 0

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
        pt, off, fol = trial_metrics(os.path.dirname(path))
        if pt is not None:
            prefix_sum += pt
            prefix_n += 1
        recovery_offered += off
        recovery_followed += fol

    prefix_mean = (prefix_sum / prefix_n) if prefix_n else None
    recovery_ratio = (recovery_followed / recovery_offered) if recovery_offered else None

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
        pfx = f" | pfx {prefix_mean:,.0f}tok" if prefix_mean is not None else ""
        rec = (
            f" | rec {recovery_followed}/{recovery_offered} ({recovery_ratio * 100:.0f}%)"
            if recovery_ratio is not None
            else " | rec n/a"
        )
        print(
            f"{completed}/{total} done, {running} run, {pending} pend | "
            f"resolved {resolved}/{completed} ({pct:.0f}%), err {errored} | "
            f"${cost:.2f} stk / ${billed:.2f} billed{mix}{pfx}{rec}"
        )
        return 0
    print(f"\n=== {job}  [{state}] ===")
    tail = f"   {pending} pending" if pending is not None else ""
    print(f"  progress   {completed}/{total} completed   {running} in flight{tail}")
    print(f"  resolved   {resolved}/{completed} ({pct:.1f}%)   errored {errored}")
    print(f"  cost       ${cost:.2f} so far (harbor agent_result.cost_usd, sticker)")
    if prefix_mean is not None:
        print(f"  prefix     {prefix_mean:,.0f} tok mean turn-1 prompt (n={prefix_n} trials)")
    if recovery_ratio is not None:
        print(
            f"  recovery   {recovery_followed}/{recovery_offered} pointers followed "
            f"({recovery_ratio * 100:.1f}%)"
        )
    else:
        print("  recovery   n/a (no recovery pointers offered)")

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
