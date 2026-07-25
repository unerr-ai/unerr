#!/usr/bin/env python3
"""Paired trajectory + prefix analysis for the A/B arms.

Usage: trajectory.py <UNERR_JOB_DIR> <BASELINE_JOB_DIR> [--steps TASK|all]

Primary source is each trial's `agent/trajectory.json` (Harbor ATIF schema),
not the raw session .jsonl. The trajectory carries per-step `metrics`,
`tool_calls` (with arguments) and `observation` (the tool result the agent
actually saw), which is what makes route comparison and landed-token
accounting possible at all.

Three questions:

  1. ROUTE — did the arms do the same work? A different tool mix or turn count
     is a legitimate outcome, but it means the cost delta is mostly the route,
     not the tooling. Reported, never silently averaged away.

  2. PREFIX — split into the two things people conflate:

       SIZE = prompt_tokens on the FIRST agent step. Route-INDEPENDENT: system
              prompt + tool schemas + instruction files, before the agent has
              done anything. Comparable across arms even when the routes
              diverge completely. The honest "what does unerr add" number.

       COST = size x turns x cache-read rate. Route-DEPENDENT, so it is
              computed with EACH arm's own turn count. Averaging turn counts
              across arms bills a route divergence to the prefix.

  3. LANDED TOKENS — observation volume returned by tools, per arm, split by
     tool. This is what unerr is supposed to reduce at the source; splitting by
     tool stops a win on unerr's own tools hiding inside unchanged Bash volume.

Stdlib only.
"""
import json
import os
import sys
from collections import Counter, defaultdict

CACHE_READ_PER_M = 0.5  # $/M tokens, sticker cache-read rate
CHARS_PER_TOKEN = 4  # standard proxy, used only for observation volume


def load_trajectory(trial_dir: str) -> dict | None:
    p = os.path.join(trial_dir, "agent", "trajectory.json")
    try:
        with open(p, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def read_trial(trial_dir: str) -> dict | None:
    """Route + usage + landed-token volume for one trial."""
    traj = load_trajectory(trial_dir)
    if not traj:
        return None

    steps = [s for s in traj.get("steps") or [] if s.get("source") == "agent"]
    if not steps:
        return None

    # Main-thread only for prefix/turn accounting: a sub-agent turn carries its
    # own prefix and its own cache, so folding it in corrupts both numbers.
    main = [s for s in steps if not (s.get("extra") or {}).get("is_sidechain")]
    side = len(steps) - len(main)
    if not main:
        return None

    tools: list[str] = []
    targets: list[str] = []
    landed: dict[str, int] = defaultdict(int)

    for s in steps:
        by_id = {}
        for tc in s.get("tool_calls") or []:
            name = tc.get("function_name") or "?"
            tools.append(name)
            by_id[tc.get("tool_call_id")] = name
            a = tc.get("arguments") or {}
            tgt = a.get("command") or a.get("file_path") or a.get("query") or a.get("pattern")
            if tgt:
                targets.append(f"{name}:{str(tgt)[:70]}")
        for r in (s.get("observation") or {}).get("results") or []:
            landed[by_id.get(r.get("source_call_id"), "?")] += len(r.get("content") or "")

    fm = traj.get("final_metrics") or {}
    fx = fm.get("extra") or {}
    m0 = main[0].get("metrics") or {}

    return {
        "turns": len(main),
        "sidechain_turns": side,
        "prefix_tokens": m0.get("prompt_tokens", 0) or 0,
        "cache_read_total": fx.get("total_cache_read_input_tokens", 0) or 0,
        "cache_write_total": fx.get("total_cache_creation_input_tokens", 0) or 0,
        "output_total": fm.get("total_completion_tokens", 0) or 0,
        "cost_usd": fm.get("total_cost_usd", 0.0) or 0.0,
        "tools": tools,
        "targets": targets,
        "tool_counts": Counter(tools),
        "landed": dict(landed),
        "landed_total": sum(landed.values()),
    }


def resolved(trial_dir: str) -> float | None:
    """Verifier reward, or None if UNGRADED.

    None (crashed / still running) is not the same as a graded 0.0. Collapsing
    them makes an infrastructure failure read as a wrong answer.
    """
    try:
        with open(os.path.join(trial_dir, "result.json"), encoding="utf-8") as fh:
            r = json.load(fh)
    except Exception:
        return None
    v = ((r.get("verifier_result") or {}).get("rewards") or {}).get("reward")
    return float(v) if isinstance(v, (int, float)) else None


def trials(job_dir: str) -> dict[str, str]:
    out = {}
    for entry in sorted(os.listdir(job_dir)):
        d = os.path.join(job_dir, entry)
        if os.path.isdir(d) and os.path.exists(os.path.join(d, "config.json")):
            out[entry.rsplit("__", 1)[0]] = d
    return out


def route_overlap(a: list[str], b: list[str]) -> tuple[float, float]:
    sa, sb = set(a), set(b)
    jac = len(sa & sb) / len(sa | sb) if (sa or sb) else 1.0
    ca, cb = Counter(a), Counter(b)
    inter = sum(min(ca[k], cb[k]) for k in set(ca) | set(cb))
    total = max(sum(ca.values()), sum(cb.values())) or 1
    return jac, inter / total


def fmt_tools(c: Counter, top: int = 7) -> str:
    return " ".join(f"{k}:{v}" for k, v in c.most_common(top)) if c else "-"


def show_steps(trial_dir: str, label: str, limit: int = 45) -> None:
    t = read_trial(trial_dir)
    if not t:
        print(f"  {label}: no trajectory")
        return
    print(f"\n  --- {label}: {t['turns']} main turns, {t['sidechain_turns']} sidechain ---")
    for i, tgt in enumerate(t["targets"][:limit], 1):
        print(f"    {i:>3}. {tgt}")
    if len(t["targets"]) > limit:
        print(f"    ... +{len(t['targets']) - limit} more")


def main() -> int:
    argv = sys.argv[1:]
    steps_for = None
    if "--steps" in argv:
        i = argv.index("--steps")
        steps_for = argv[i + 1] if i + 1 < len(argv) else "all"
        argv = argv[:i] + argv[i + 2 :]
    if len(argv) < 2:
        print(__doc__)
        return 2
    unerr_dir, base_dir = argv[0], argv[1]

    u_trials, b_trials = trials(unerr_dir), trials(base_dir)
    shared = sorted(set(u_trials) & set(b_trials))
    if not shared:
        print("no tasks present in BOTH arms")
        print(f"  unerr:    {sorted(u_trials)}")
        print(f"  baseline: {sorted(b_trials)}")
        return 1

    only_u = sorted(set(u_trials) - set(b_trials))
    only_b = sorted(set(b_trials) - set(u_trials))
    if only_u or only_b:
        print(f"! unpaired, ignored — unerr-only={only_u} baseline-only={only_b}\n")

    if steps_for:
        for task in shared:
            if steps_for in (task, "all"):
                print(f"\n{'=' * 92}\nSTEPS — {task}\n{'=' * 92}")
                show_steps(u_trials[task], "unerr")
                show_steps(b_trials[task], "baseline")
        return 0

    W = 96
    print("=" * W)
    print("ROUTE — did both arms do the same work?")
    print("=" * W)

    rows = []
    for task in shared:
        u, b = read_trial(u_trials[task]), read_trial(b_trials[task])
        if not u or not b:
            miss = "unerr" if not u else "baseline"
            print(f"{task:<32} — no trajectory in {miss} arm (running / errored)\n")
            continue
        ur, br = resolved(u_trials[task]), resolved(b_trials[task])

        def rw(v):
            return "-" if v is None else f"{v:.0f}"

        print(f"{task:<32} {'turns':>6} {'rw':>3}  tools")
        print(f"{'  unerr':<32} {u['turns']:>6} {rw(ur):>3}  {fmt_tools(u['tool_counts'])}")
        print(f"{'  baseline':<32} {b['turns']:>6} {rw(br):>3}  {fmt_tools(b['tool_counts'])}")
        jac, mix = route_overlap(u["tools"], b["tools"])
        ratio = u["turns"] / b["turns"] if b["turns"] else float("inf")
        verdict = "SAME-ISH" if jac >= 0.6 and 0.75 <= ratio <= 1.33 else "DIVERGED"
        print(f"{'  route':<32} tool-set {jac:.2f} | mix {mix:.2f} | turns {ratio:.2f}x  -> {verdict}\n")
        rows.append((task, u, b, ur, br, verdict))

    if not rows:
        print("Nothing paired yet.")
        return 1

    print("=" * W)
    print("PREFIX — size is route-independent; cost is not")
    print("=" * W)
    print(f"{'task':<30} {'size_u':>8} {'size_b':>8} {'delta':>8} {'turns_u':>8} {'$carry':>8}  route")
    print("-" * W)
    total_carry = 0.0
    for task, u, b, _ur, _br, verdict in rows:
        d = u["prefix_tokens"] - b["prefix_tokens"]
        carry = d * u["turns"] * CACHE_READ_PER_M / 1_000_000
        total_carry += carry
        print(
            f"{task:<30} {u['prefix_tokens']:>8,} {b['prefix_tokens']:>8,} "
            f"{d:>+8,} {u['turns']:>8} {carry:>8.4f}  {verdict}"
        )
    deltas = [u["prefix_tokens"] - b["prefix_tokens"] for _t, u, b, *_ in rows]
    print("-" * W)
    print(
        f"mean prefix delta {sum(deltas) / len(deltas):>+10,.0f} tok   "
        f"spread {max(deltas) - min(deltas):,}   total carry ${total_carry:.4f}"
    )
    print(
        "\n  delta should be near-CONSTANT across tasks (fixed schema + instruction tax).\n"
        "  A wide spread means turn-1 was not comparable — check before quoting.\n"
        "  $carry uses each arm's OWN turn count; a DIVERGED route moves it without\n"
        "  the prefix changing at all.\n"
    )

    print("=" * W)
    print("LANDED TOKENS — tool output that actually entered context (chars/4)")
    print("=" * W)
    all_tools = sorted({k for _t, u, b, *_ in rows for k in list(u["landed"]) + list(b["landed"])})
    print(f"{'tool':<30} {'unerr':>12} {'baseline':>12} {'ratio':>8}")
    print("-" * W)
    for tool in all_tools:
        tu = sum(u["landed"].get(tool, 0) for _t, u, _b, *_ in rows) // CHARS_PER_TOKEN
        tb = sum(b["landed"].get(tool, 0) for _t, _u, b, *_ in rows) // CHARS_PER_TOKEN
        print(f"{tool:<30} {tu:>12,} {tb:>12,} {(f'{tu / tb:.2f}x' if tb else '—'):>8}")
    lu = sum(u["landed_total"] for _t, u, _b, *_ in rows) // CHARS_PER_TOKEN
    lb = sum(b["landed_total"] for _t, _u, b, *_ in rows) // CHARS_PER_TOKEN
    print("-" * W)
    print(f"{'TOTAL':<30} {lu:>12,} {lb:>12,} {(f'{lu / lb:.2f}x' if lb else '—'):>8}")

    print("\n" + "=" * W)
    print("TOTALS")
    print("=" * W)
    for label, idx, ridx in (("unerr", 1, 3), ("baseline", 2, 4)):
        cr = sum(r[idx]["cache_read_total"] for r in rows)
        cw = sum(r[idx]["cache_write_total"] for r in rows)
        op = sum(r[idx]["output_total"] for r in rows)
        tn = sum(r[idx]["turns"] for r in rows)
        cost = sum(r[idx]["cost_usd"] for r in rows)
        graded = [r[ridx] for r in rows if r[ridx] is not None]
        solved = sum(1 for v in graded if v > 0)
        tail = f" ({len(rows) - len(graded)} ungraded)" if len(graded) != len(rows) else ""
        print(
            f"{label:<9} turns {tn:>4}  cacheRead {cr:>11,}  cacheWrite {cw:>9,}  "
            f"out {op:>7,}  ${cost:>7.4f}  solved {solved}/{len(graded)}{tail}"
        )
    cru = sum(r[1]["cache_read_total"] for r in rows)
    crb = sum(r[2]["cache_read_total"] for r in rows)
    cu = sum(r[1]["cost_usd"] for r in rows)
    cb = sum(r[2]["cost_usd"] for r in rows)
    print()
    if crb:
        print(f"cacheRead  unerr/baseline: {cru / crb:.2f}x")
    if cb:
        print(f"cost       unerr/baseline: {cu / cb:.2f}x")
    print("\nSuccess-adjusted cost is the metric (arXiv 2607.12161). Cheaper-but-failed")
    print("does not count — compare cost only across arms that solved the same tasks.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
