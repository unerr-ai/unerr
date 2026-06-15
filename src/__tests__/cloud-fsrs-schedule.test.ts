/**
 * FSRS spaced-recall scheduler — pure-math tests.
 *
 * Grounds the interval/retrievability math on the open-spaced-repetition FSRS
 * curve and checks the binary y/n review path moves the schedule the right way.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TARGET_RETENTION,
  initialSchedule,
  isDue,
  nextIntervalDays,
  orderByForgetting,
  retrievability,
  reviewSchedule,
} from "../cloud/fsrs-schedule.js";

const DAY = 86_400_000;

describe("retrievability", () => {
  it("is 1.0 right after review", () => {
    expect(retrievability(10, 0)).toBeCloseTo(1, 6);
  });

  it("equals the target retention after exactly `stability` days", () => {
    // The curve is pinned so R(S days, S) = 0.9.
    expect(retrievability(10, 10 * DAY)).toBeCloseTo(0.9, 6);
  });

  it("decays monotonically with elapsed time", () => {
    const r1 = retrievability(10, 5 * DAY);
    const r2 = retrievability(10, 20 * DAY);
    expect(r2).toBeLessThan(r1);
  });

  it("is 0 for a non-positive stability", () => {
    expect(retrievability(0, DAY)).toBe(0);
  });
});

describe("nextIntervalDays", () => {
  it("returns ~stability days at the default 0.9 retention", () => {
    // I(0.9, S) == S because the curve is pinned at R(S,S)=0.9.
    expect(nextIntervalDays(10, DEFAULT_TARGET_RETENTION)).toBe(10);
  });

  it("asks sooner for a lower target retention", () => {
    const at90 = nextIntervalDays(20, 0.9);
    const at70 = nextIntervalDays(20, 0.7);
    expect(at70).toBeGreaterThan(at90); // lower retention tolerated → longer gap
  });

  it("never schedules same-day (>= 1)", () => {
    expect(nextIntervalDays(0.1)).toBeGreaterThanOrEqual(1);
  });
});

describe("initialSchedule", () => {
  it("starts not-yet-reviewed and due one interval out", () => {
    const created = 1_000_000_000_000;
    const s = initialSchedule(created);
    expect(s.reviews).toBe(0);
    expect(s.last_review_ms).toBe(created);
    expect(s.due_at_ms).toBeGreaterThan(created);
    expect(isDue(s, created)).toBe(false);
    expect(isDue(s, s.due_at_ms)).toBe(true);
  });
});

describe("reviewSchedule", () => {
  const created = 1_000_000_000_000;

  it("remembered → stability grows and the next ask is further out", () => {
    const s0 = initialSchedule(created);
    const answeredAt = s0.due_at_ms;
    const s1 = reviewSchedule(s0, true, answeredAt);
    expect(s1.stability).toBeGreaterThan(s0.stability);
    expect(s1.reviews).toBe(1);
    expect(s1.due_at_ms - answeredAt).toBeGreaterThan(s0.due_at_ms - created);
  });

  it("forgot → stability collapses and the next ask is soon", () => {
    const s0 = initialSchedule(created);
    const answeredAt = s0.due_at_ms;
    const s1 = reviewSchedule(s0, false, answeredAt);
    expect(s1.stability).toBeLessThan(s0.stability);
    expect(s1.due_at_ms - answeredAt).toBeLessThanOrEqual(2 * DAY);
  });

  it("caps stability so a decision never stops resurfacing", () => {
    let s = initialSchedule(created);
    let t = created;
    for (let i = 0; i < 12; i++) {
      t = s.due_at_ms;
      s = reviewSchedule(s, true, t);
    }
    expect(s.stability).toBeLessThanOrEqual(120);
  });
});

describe("orderByForgetting", () => {
  it("puts the most-forgotten (lowest retrievability) first", () => {
    const now = 2_000_000_000_000;
    const fresh = { schedule: initialSchedule(now - DAY) }; // 1 day old
    const stale = { schedule: initialSchedule(now - 30 * DAY) }; // 30 days old
    const ordered = orderByForgetting([fresh, stale], now);
    expect(ordered[0]).toBe(stale);
    expect(ordered[1]).toBe(fresh);
  });

  it("does not mutate the input array", () => {
    const now = 2_000_000_000_000;
    const items = [
      { schedule: initialSchedule(now - DAY) },
      { schedule: initialSchedule(now - 30 * DAY) },
    ];
    const copy = [...items];
    orderByForgetting(items, now);
    expect(items).toEqual(copy);
  });
});
