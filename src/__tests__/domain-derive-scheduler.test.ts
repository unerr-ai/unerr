/**
 * Layer 8 — DomainDeriveScheduler: the debounced live-edit domain re-derive.
 * Fake-timer tests pin the trailing-edge debounce, burst coalescing, the
 * in-flight follow-up guard, stop/null-db/error paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOMAIN_DERIVE_DEBOUNCE_MS,
  DomainDeriveScheduler,
} from "../intelligence/semantic/domain-derive-scheduler.js";

const RESULT = { propagated: 1, communities: 2, edges: 3 };
// Structural stand-in for AnnotationDb — never actually queried (deriveFn is stubbed).
const fakeDb = { run: async () => ({ rows: [] }) } as never;

describe("DomainDeriveScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces a burst of schedule() calls into one derive after the window", async () => {
    const derive = vi.fn(async () => RESULT);
    const s = new DomainDeriveScheduler({
      getDb: () => fakeDb,
      deriveFn: derive,
      debounceMs: 100,
    });
    s.schedule();
    s.schedule();
    s.schedule();
    expect(derive).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(derive).toHaveBeenCalledTimes(1);
  });

  it("does not derive before the debounce window elapses", async () => {
    const derive = vi.fn(async () => RESULT);
    const s = new DomainDeriveScheduler({
      getDb: () => fakeDb,
      deriveFn: derive,
      debounceMs: 100,
    });
    s.schedule();
    await vi.advanceTimersByTimeAsync(99);
    expect(derive).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(derive).toHaveBeenCalledTimes(1);
  });

  it("resets the timer on each schedule() (trailing edge)", async () => {
    const derive = vi.fn(async () => RESULT);
    const s = new DomainDeriveScheduler({
      getDb: () => fakeDb,
      deriveFn: derive,
      debounceMs: 100,
    });
    s.schedule();
    await vi.advanceTimersByTimeAsync(60);
    s.schedule(); // resets the window
    await vi.advanceTimersByTimeAsync(60); // 60 since last schedule — not yet
    expect(derive).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(40); // now 100 since last schedule
    expect(derive).toHaveBeenCalledTimes(1);
  });

  it("coalesces a schedule() during an in-flight derive into exactly one follow-up", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const derive = vi.fn(async () => {
      await gate;
      return RESULT;
    });
    const s = new DomainDeriveScheduler({
      getDb: () => fakeDb,
      deriveFn: derive,
      debounceMs: 100,
    });

    s.schedule();
    await vi.advanceTimersByTimeAsync(100); // fire #1 — now parked on the gate
    expect(derive).toHaveBeenCalledTimes(1);
    expect(s.isRunning).toBe(true);

    // A fresh save arrives mid-derive: arm + fire its timer while #1 is still
    // running → coalesced into a single follow-up request, not a second run.
    s.schedule();
    await vi.advanceTimersByTimeAsync(100);
    expect(derive).toHaveBeenCalledTimes(1);

    release(); // #1 completes → finally sees the request → schedules the follow-up
    await vi.advanceTimersByTimeAsync(0); // flush #1's continuation
    await vi.advanceTimersByTimeAsync(100); // fire #2
    expect(derive).toHaveBeenCalledTimes(2);
  });

  it("stop() cancels a pending derive and makes schedule() a no-op", async () => {
    const derive = vi.fn(async () => RESULT);
    const s = new DomainDeriveScheduler({
      getDb: () => fakeDb,
      deriveFn: derive,
      debounceMs: 100,
    });
    s.schedule();
    s.stop();
    await vi.advanceTimersByTimeAsync(200);
    expect(derive).not.toHaveBeenCalled();
    s.schedule(); // ignored after stop
    await vi.advanceTimersByTimeAsync(200);
    expect(derive).not.toHaveBeenCalled();
  });

  it("skips the derive when getDb returns null (graph not ready / retired)", async () => {
    const derive = vi.fn(async () => RESULT);
    const s = new DomainDeriveScheduler({
      getDb: () => null,
      deriveFn: derive,
      debounceMs: 100,
    });
    s.schedule();
    await vi.advanceTimersByTimeAsync(100);
    expect(derive).not.toHaveBeenCalled();
  });

  it("reports a derive failure via onError and never throws", async () => {
    const err = new Error("boom");
    const onError = vi.fn();
    const s = new DomainDeriveScheduler({
      getDb: () => fakeDb,
      deriveFn: async () => {
        throw err;
      },
      onError,
      debounceMs: 100,
    });
    s.schedule();
    await vi.advanceTimersByTimeAsync(100);
    expect(onError).toHaveBeenCalledWith(err);
  });

  it("passes the derive result to onDerive", async () => {
    const onDerive = vi.fn();
    const s = new DomainDeriveScheduler({
      getDb: () => fakeDb,
      deriveFn: async () => RESULT,
      onDerive,
      debounceMs: 100,
    });
    s.schedule();
    await vi.advanceTimersByTimeAsync(100);
    expect(onDerive).toHaveBeenCalledWith(RESULT);
  });

  it("flush() runs a derive immediately, bypassing the debounce", async () => {
    const derive = vi.fn(async () => RESULT);
    const s = new DomainDeriveScheduler({
      getDb: () => fakeDb,
      deriveFn: derive,
      debounceMs: 100,
    });
    await s.flush();
    expect(derive).toHaveBeenCalledTimes(1);
  });

  it("defaults to DOMAIN_DERIVE_DEBOUNCE_MS when no window is given", async () => {
    const derive = vi.fn(async () => RESULT);
    const s = new DomainDeriveScheduler({
      getDb: () => fakeDb,
      deriveFn: derive,
    });
    s.schedule();
    await vi.advanceTimersByTimeAsync(DOMAIN_DERIVE_DEBOUNCE_MS - 1);
    expect(derive).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(derive).toHaveBeenCalledTimes(1);
  });
});
