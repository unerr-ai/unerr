#!/usr/bin/env python3
"""Measure unerr's per-turn TAX/OVERHEAD across a Claude Code session.

Intake: a Claude Code SESSION ID (the uuid you see in the agent), or a direct
path to its transcript .jsonl. Resolves the transcript under
~/.claude/projects/**/<session-id>.jsonl, then reports:

  - per-turn token series (fresh / cache-read / cache-write / output), deduped
    by message.id (the raw transcript double-counts streamed rows)
  - the real-bill weighted units (fresh·1 + cache_write·1.25 + cache_read·0.1
    + output·5) and the cache hit rate H
  - unerr's fixed-prefix tax (instruction block + tools/list, from
    measure-overhead.mts) as a share of the bill
  - deny->retry forced round-trips (the largest avoidable tax)
  - tool-call adoption split (unerr MCP vs built-in vs host) and ur| signal counts

Writes a JSON summary to disk (so unerr shell compression never touches the
numbers) and prints a compact table to stderr.

Usage:
  python3 scripts/session-tax.py <session-id|transcript.jsonl> [out.json]

Baseline to beat (see .internal/roadmap/AGENT_TOOLING_OVERHEAD_ANALYSIS.md §9):
  H >= 0.95 ; fixed prefix <= ~6056 tok (~2.5% of bill) ; gross tax <= +10% on
  a trivial turn ; 0 false denies.
"""
import json
import os
import re
import sys
from collections import Counter
from glob import glob

# --- bill weighting (Anthropic-rate proxy) and unerr fixed surface ----------
RATE = {"fresh": 1.0, "cr": 0.1, "cw": 1.25, "out": 5.0}
UNERR_PREFIX_TOK = 6056  # instruction block 3348 + tools/list (5 advertised tools (+2 hidden)) 2708; keep in sync with measure-overhead.mts
CHARS_PER_TOK = 4.0      # crude estimator, matches unerr's estimateTokens ballpark

# Hard denies that FORCE a retry round-trip (the avoidable tax). These match the
# deny reason text unerr emits, as it appears echoed back in the next user turn.
HARD_DENY_PATS = [
    ("read_fullfile_deny", re.compile(r"full-file (is wasteful|built-in Read)|route code exploration through unerr|redirect.*file_read")),
    ("edit_blast_deny",    re.compile(r"caller\(s\) to update|signature change to .*caller|-32003")),
    ("webfetch_redirect",  re.compile(r"WebFetch.*(denied|redirect)|use fetch_url instead")),
]

UNERR_PREFIX = "mcp__unerr__"
BUILTIN_TOOLS = {"Bash", "Edit", "Read", "Write", "Glob", "Grep", "WebSearch", "WebFetch", "NotebookEdit"}


def resolve_transcript(arg):
    """Accept a session id or a path; return the transcript path."""
    if os.path.isfile(arg):
        return arg
    home = os.path.expanduser("~/.claude/projects")
    hits = glob(os.path.join(home, "**", f"{arg}.jsonl"), recursive=True)
    if not hits:
        # also try the bare arg as a filename anywhere under projects
        hits = glob(os.path.join(home, "**", f"*{arg}*.jsonl"), recursive=True)
    if not hits:
        sys.exit(f"no transcript found for session id '{arg}' under {home}")
    # newest match wins if several
    return max(hits, key=os.path.getmtime)


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict):
                if isinstance(b.get("text"), str):
                    parts.append(b["text"])
                rc = b.get("content")
                if isinstance(rc, str):
                    parts.append(rc)
                elif isinstance(rc, list):
                    for x in rc:
                        if isinstance(x, dict) and isinstance(x.get("text"), str):
                            parts.append(x["text"])
        return "\n".join(parts)
    return ""


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = resolve_transcript(sys.argv[1])
    out = sys.argv[2] if len(sys.argv) > 2 else f"/tmp/unerr-session-tax-{os.path.basename(src).split('.')[0]}.json"

    per_turn = []
    turns = 0
    seen_ids = set()
    first_ts = last_ts = None
    user_prompts = 0
    tot = {"fresh": 0, "cr": 0, "cw": 0, "out": 0}
    deny_hits = Counter()
    ur_lines = Counter()
    unerr_calls = Counter()
    builtin_calls = Counter()
    other_calls = Counter()

    with open(src, errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except Exception:
                continue
            ts = ev.get("timestamp")
            if ts:
                first_ts = first_ts or ts
                last_ts = ts
            etype = ev.get("type")
            msg = ev.get("message") if isinstance(ev.get("message"), dict) else None

            if etype == "user" and msg and not ev.get("isMeta"):
                # a real typed prompt has text content and NO tool_result block
                # (tool-result user events carry tool_result blocks; hooks add to those)
                c = msg.get("content")
                has_text = isinstance(c, str) and c.strip() != ""
                has_tool_result = False
                if isinstance(c, list):
                    for b in c:
                        if isinstance(b, dict):
                            if b.get("type") == "tool_result":
                                has_tool_result = True
                            if b.get("type") == "text" and isinstance(b.get("text"), str) and b["text"].strip():
                                has_text = True
                if has_text and not has_tool_result:
                    user_prompts += 1

            if etype == "assistant" and msg:
                # classify tool calls in this assistant message
                for blk in (msg.get("content") or []):
                    if isinstance(blk, dict) and blk.get("type") == "tool_use":
                        name = blk.get("name", "")
                        if name.startswith(UNERR_PREFIX):
                            unerr_calls[name] += 1
                        elif name in BUILTIN_TOOLS:
                            builtin_calls[name] += 1
                        else:
                            other_calls[name] += 1
                # token usage, deduped by message id
                u = msg.get("usage") or {}
                mid = msg.get("id")
                if u and (mid is None or mid not in seen_ids):
                    if mid is not None:
                        seen_ids.add(mid)
                    turns += 1
                    fr = u.get("input_tokens", 0) or 0
                    cr = u.get("cache_read_input_tokens", 0) or 0
                    cw = u.get("cache_creation_input_tokens", 0) or 0
                    ou = u.get("output_tokens", 0) or 0
                    tot["fresh"] += fr
                    tot["cr"] += cr
                    tot["cw"] += cw
                    tot["out"] += ou
                    per_turn.append([turns, fr, cr, cw, ou])

            if etype == "user" and msg:
                txt = text_of(msg.get("content"))
                for name, pat in HARD_DENY_PATS:
                    if pat.search(txt):
                        deny_hits[name] += 1
                for tag in re.findall(r"ur\|(act|ctx|rsk|fct)", txt):
                    ur_lines[tag] += 1

    w = {k: tot[k] * RATE[k] for k in tot}
    total_w = sum(w.values())
    H = 100 * tot["cr"] / max(1, (tot["cr"] + tot["cw"] + tot["fresh"]))

    prefix_write_wu = UNERR_PREFIX_TOK * RATE["cw"]
    prefix_read_per_turn = UNERR_PREFIX_TOK * RATE["cr"]
    prefix_read_total = prefix_read_per_turn * max(0, turns - 1)
    prefix_tax_total = prefix_write_wu + prefix_read_total
    deny_total = sum(deny_hits.values())

    summary = {
        "source": src,
        "session_window": {"first_ts": first_ts, "last_ts": last_ts, "user_prompts": user_prompts},
        "turns": turns,
        "tokens": tot,
        "weighted_units": {k: round(v, 1) for k, v in w.items()},
        "total_weighted_units": round(total_w, 1),
        "cache_hit_rate_pct": round(H, 2),
        "avg_per_turn": {k: round(tot[k] / max(1, turns)) for k in tot},
        "first5_turns": per_turn[:5],
        "last3_turns": per_turn[-3:],
        "UNERR_TAX": {
            "fixed_prefix_tok": UNERR_PREFIX_TOK,
            "first_turn_write_wu": round(prefix_write_wu, 1),
            "subsequent_turn_read_wu": round(prefix_read_per_turn, 1),
            "prefix_tax_total_wu": round(prefix_tax_total, 1),
            "prefix_tax_pct_of_bill": round(100 * prefix_tax_total / max(1, total_w), 3),
        },
        "deny_retry_roundtrips": dict(deny_hits),
        "deny_retry_total": deny_total,
        "tool_calls": {
            "unerr": dict(unerr_calls),
            "unerr_total": sum(unerr_calls.values()),
            "builtin": dict(builtin_calls),
            "builtin_total": sum(builtin_calls.values()),
            "other": dict(other_calls),
        },
        "ur_signal_lines_in_results": dict(ur_lines),
    }
    with open(out, "w") as f:
        json.dump(summary, f, indent=2)

    # compact human table to stderr (stdout stays clean)
    p = lambda s: sys.stderr.write(s + "\n")
    p(f"session    : {os.path.basename(src)}")
    p(f"turns      : {turns}   prompts: {user_prompts}   window: {first_ts} -> {last_ts}")
    p(f"cache H    : {H:.1f}%   (baseline >= 95%)")
    p(f"prefix tax : {UNERR_PREFIX_TOK} tok = {summary['UNERR_TAX']['prefix_tax_pct_of_bill']}% of bill   (baseline <= ~2.5%)")
    p(f"deny retry : {deny_total} forced round-trips {dict(deny_hits)}   (baseline 0 false denies)")
    p(f"adoption   : unerr {sum(unerr_calls.values())} | builtin {sum(builtin_calls.values())} (Edit {builtin_calls.get('Edit',0)} vs file_edit {unerr_calls.get('mcp__unerr__file_edit',0)}; Read {builtin_calls.get('Read',0)} vs file_read {unerr_calls.get('mcp__unerr__file_read',0)})")
    p(f"wrote      : {out}")


if __name__ == "__main__":
    main()
