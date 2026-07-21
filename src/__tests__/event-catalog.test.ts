/**
 * EVENT_CATALOG drift guard — runtime assertions that the catalog stays in
 * sync with the source-of-truth unions and the CLI display maps.
 *
 * What is checked:
 *   1. Every SavingsEventKind (from KIND_CATEGORY) has a catalog entry.
 *   2. Every TokenFlowMechanism has a catalog entry with family:"mechanism".
 *   3. Every display key in PHRASING / TOKEN_FLOW_PHRASING resolves through
 *      the derived getPhrasing() map (verifies the derivation round-trips).
 *   4. Every BehaviorEventType literal is a catalog key.
 *
 * These tests catch drift that the compile-time guards in named-events.ts
 * cannot catch (e.g. a SavingsEventKind removed from KIND_CATEGORY but left
 * in the union, or a phrasing entry missing from the catalog).
 */

import { EVENT_CATALOG } from "@unerr-ai/contracts/events";
import { describe, expect, it } from "vitest";
import { eventBucket, getPhrasing } from "../tracking/named-events.js";
import { KIND_CATEGORY } from "../tracking/savings-events.js";

// ── 1. KIND_CATEGORY keys ⊆ catalog keys (family "savings") ─────────────

describe("EVENT_CATALOG — savings coverage", () => {
  it("every SavingsEventKind in KIND_CATEGORY has a catalog entry", () => {
    const missing: string[] = [];
    for (const kind of Object.keys(KIND_CATEGORY)) {
      if (!(kind in EVENT_CATALOG)) missing.push(kind);
    }
    expect(missing).toEqual([]);
  });

  it("every KIND_CATEGORY entry maps to family:'savings' in the catalog", () => {
    const wrong: string[] = [];
    for (const kind of Object.keys(KIND_CATEGORY)) {
      const entry = (EVENT_CATALOG as Record<string, { family: string }>)[kind];
      if (entry?.family !== "savings") wrong.push(kind);
    }
    expect(wrong).toEqual([]);
  });
});

// ── 2. TokenFlowMechanism keys ⊆ catalog keys (family "mechanism") ──────

describe("EVENT_CATALOG — mechanism coverage", () => {
  // Mechanisms listed in TokenFlowMechanism (token-flow.ts). We derive this
  // set from the catalog itself (family:"mechanism") and compare against the
  // runtime-observable list — the compile-time guard already covers the union
  // direction; this test catches entries removed from the catalog but kept in
  // the union.
  it("catalog contains family:'mechanism' entries for all known mechanisms", () => {
    const catalogMechanisms = new Set(
      Object.entries(EVENT_CATALOG)
        .filter(([, e]) => (e as { family: string }).family === "mechanism")
        .map(([k]) => k)
    );
    // These are the 11 TokenFlowMechanism values (from token-flow.ts).
    const expected = [
      "graph_query",
      "session_dedup",
      "shell_compression",
      "format_encoding",
      "smart_truncation",
      "file_read",
      "fetch_url",
      "behavior_automation",
      "persistent_memory",
      "context_bundle",
      "body_dedup",
    ];
    const missing = expected.filter((m) => !catalogMechanisms.has(m));
    expect(missing).toEqual([]);
  });
});

// ── 3. getPhrasing() round-trips for all display entries ─────────────────

describe("EVENT_CATALOG — getPhrasing() round-trip", () => {
  it("every behavior display entry resolves to the catalog verb+object via getPhrasing", () => {
    const failures: string[] = [];
    for (const [key, entry] of Object.entries(EVENT_CATALOG)) {
      const e = entry as {
        family: string;
        surface: string;
        verb?: string;
        object?: string;
        plural?: string;
      };
      if (e.family !== "behavior" || e.surface !== "display" || !e.verb)
        continue;
      const phrasing = getPhrasing(key);
      if (phrasing.verb !== e.verb || phrasing.object !== e.object) {
        failures.push(
          `${key}: expected {verb:"${e.verb}", object:"${e.object}"} ` +
            `got {verb:"${phrasing.verb}", object:"${phrasing.object}"}`
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it("every mechanism display entry resolves via getPhrasing('tokenflow.<key>')", () => {
    const failures: string[] = [];
    for (const [key, entry] of Object.entries(EVENT_CATALOG)) {
      const e = entry as {
        family: string;
        surface: string;
        verb?: string;
        object?: string;
      };
      if (e.family !== "mechanism" || e.surface !== "display" || !e.verb)
        continue;
      const phrasing = getPhrasing(`tokenflow.${key}`);
      if (phrasing.verb !== e.verb || phrasing.object !== e.object) {
        failures.push(
          `tokenflow.${key}: expected {verb:"${e.verb}", object:"${e.object}"} ` +
            `got {verb:"${phrasing.verb}", object:"${phrasing.object}"}`
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it("unknown event type falls back to DEFAULT_PHRASING", () => {
    const p = getPhrasing("not_a_real_event_xyz");
    expect(p.verb).toBe("recorded");
    expect(p.object).toBe("thing");
    expect(p.plural).toBe("things");
  });
});

// ── 4. BehaviorEventType literals are all catalog keys ───────────────────

describe("EVENT_CATALOG — behavior coverage", () => {
  it("known BehaviorEventType values are present in the catalog", () => {
    // Spot-check the key types that were in the original PHRASING map.
    const knownDisplayTypes = [
      "graph_query_served",
      "full_read_avoided",
      "loop_broken",
      "cascade_guard",
      "drift_consumed",
      "intervention_halted",
      "intervention_warned",
      "defuddle_selector_skipped",
      "caller_check_enforced",
      "stale_edit_prevented",
      "convention_applied",
      "cache_hit",
      "cross_session_resume",
      "cascade_warning_consumed",
      "confirmation_expired",
      "presence_ambient_marker",
      "resume_blockers_surfaced",
      "review_finding_surfaced",
      "code_edit_applied",
      "delegated_edit",
      "delegated_sweep",
    ];
    const missing = knownDisplayTypes.filter((t) => !(t in EVENT_CATALOG));
    expect(missing).toEqual([]);
  });

  it("internal BehaviorEventType values are present in the catalog", () => {
    const knownInternalTypes = [
      "user_prompt_received",
      "boundary_violation_flagged",
      "incomplete_work_flagged",
      "cross_repo_access",
      "cross_repo_drift",
      "savings_event",
    ];
    const missing = knownInternalTypes.filter((t) => !(t in EVENT_CATALOG));
    expect(missing).toEqual([]);
  });

  it("reconciled real event kind is cataloged; non-event trail strings are excluded", () => {
    // line_survival_rollup is a real behavior event (insertBehaviorEvent).
    expect(EVENT_CATALOG).toHaveProperty("line_survival_rollup");
    // history (a session_summary detail discriminant) and search_code (a tool
    // name in RECON_SEQUENCE) are NOT event kinds — they must not be cataloged.
    expect(EVENT_CATALOG).not.toHaveProperty("history");
    expect(EVENT_CATALOG).not.toHaveProperty("search_code");
  });
});

// ── R-sprint reporting kinds (Cap A/B/C) surface correctly ──────────────

describe("EVENT_CATALOG — new capability reporting kinds", () => {
  const cat = EVENT_CATALOG as Record<
    string,
    { surface: string; bucket: string; verb?: string }
  >;

  it("body_dedup (Cap C) is a displayed savings mechanism", () => {
    expect(cat.body_dedup?.surface).toBe("display");
    expect(cat.body_dedup?.bucket).toBe("saved");
    // Derives a real token-flow phrasing (not the DEFAULT fallback).
    expect(eventBucket("tokenflow.body_dedup")).toBe("saved");
    expect(getPhrasing("tokenflow.body_dedup").verb).toBe("reused");
  });

  it("loop_redirect (Cap B) is a soft prevention — bucketed but not a hard stop", () => {
    expect(cat.loop_redirect?.surface).toBe("display");
    expect(eventBucket("loop_redirect")).toBe("prevented");
    expect(getPhrasing("loop_redirect").verb).toBe("redirected");
  });

  it("trace_captured / trace_recalled (Cap A) are remembered-bucket events", () => {
    expect(eventBucket("trace_captured")).toBe("remembered");
    expect(eventBucket("trace_recalled")).toBe("remembered");
    expect(getPhrasing("trace_captured").verb).toBe("captured");
    expect(getPhrasing("trace_recalled").verb).toBe("recalled");
  });
});
