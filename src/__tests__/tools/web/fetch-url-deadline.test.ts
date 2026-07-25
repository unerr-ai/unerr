/**
 * fetch_url overall wall-clock ceiling.
 *
 * Reproduces the offline hang: a `fetch()` whose AbortController never
 * interrupts a stalled DNS/connect syscall. Before the fix, fetchHtml only
 * checked totalDeadlineMs BETWEEN attempts, so a single stalled attempt blew
 * past the ceiling (observed ~960s). The per-attempt hard race (raceAttempt)
 * now bounds each attempt, so totalDeadlineMs actually holds; the bulk path is
 * additionally bounded per-slot by raceBatchDeadline.
 *
 * The stub `fetch` never settles AND ignores the abort signal — exactly the
 * syscall-stall case AbortController cannot end.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FETCH_PROTOCOL_LIMITS,
  runFetchUrl,
  runFetchUrlBatch,
} from "../../../tools/web/fetch-url-protocol.js";

const origFetch = globalThis.fetch;
const origLimits = { ...FETCH_PROTOCOL_LIMITS };

beforeEach(() => {
  // A fetch that never settles and ignores AbortController — the stalled-syscall
  // case. Only the hard per-attempt race can end it.
  globalThis.fetch = (() =>
    new Promise<never>(() => {})) as unknown as typeof fetch;
  // Shrink the deadlines so the bounded case resolves in well under a second.
  FETCH_PROTOCOL_LIMITS.baseTimeoutMs = 40;
  FETCH_PROTOCOL_LIMITS.totalDeadlineMs = 150;
  FETCH_PROTOCOL_LIMITS.batchDeadlineMs = 200;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  Object.assign(FETCH_PROTOCOL_LIMITS, origLimits);
});

describe("fetch_url overall deadline", () => {
  it("single URL: a stalled fetch returns deadline_exceeded within the ceiling, never hangs", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fetch-deadline-"));
    try {
      const start = Date.now();
      const r = await runFetchUrl(
        { url: "https://unreachable.invalid/x" },
        { cwd }
      );
      const elapsed = Date.now() - start;

      // Bounded — nowhere near the ~960s pre-fix hang.
      expect(elapsed).toBeLessThan(3000);
      expect(r.result_status).toBe("http_error");
      const err = r as { reason?: string };
      expect(err.reason).toBe("deadline_exceeded");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("bulk: stalled fetches return within the overall deadline with failure sentinels", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fetch-deadline-bulk-"));
    try {
      const start = Date.now();
      const batch = await runFetchUrlBatch(
        ["https://a.invalid/", "https://b.invalid/"],
        {},
        { cwd }
      );
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(3000);
      // Every URL failed → no OK payload; the batch still returns, never hangs.
      expect(batch.result_status).not.toBe("ok");
      if (batch.result_status === "ok") {
        expect(batch.ok).toBe(0);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
