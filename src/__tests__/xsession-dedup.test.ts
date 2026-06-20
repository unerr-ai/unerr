import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSessionDedup,
  xsessionRecordDelivered,
  xsessionWasDelivered,
} from "../proxy/session-dedup.js";

/**
 * Lever D (TOKEN_ECONOMICS_AND_SAVINGS §11.4) — cross-session prefix cache.
 * The dedup set persists to `.unerr/state/xsession-dedup.json` and seeds the
 * next session so identical context is not re-injected. Gated by
 * `UNERR_XSESSION_CACHE`; default OFF must behave exactly as the in-memory tier.
 */
// Computed key so biome's noDelete (which flags only static member deletes)
// stays happy; `process.env.X = undefined` is wrong — it stores "undefined".
const FLAG = "UNERR_XSESSION_CACHE";

describe("cross-session dedup (Lever D)", () => {
  let cwd: string;
  let saved: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "unerr-xsession-"));
    saved = process.env[FLAG];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  });

  it("off by default: a new tracker does NOT see a prior tracker's keys", () => {
    delete process.env[FLAG];
    const a = createSessionDedup({ cwd });
    a.markDelivered("entity1", ["note:a"]);
    a.flush();
    expect(
      existsSync(join(cwd, ".unerr", "state", "xsession-dedup.json"))
    ).toBe(false);
    const b = createSessionDedup({ cwd });
    expect(b.hasDelivered("entity1", "note:a")).toBe(false);
  });

  it("on: a new tracker is seeded from the prior session's delivered set", () => {
    process.env[FLAG] = "1";
    const a = createSessionDedup({ cwd });
    a.markDelivered("entity1", ["note:a", "note:b"]);
    a.flush();
    const b = createSessionDedup({ cwd });
    expect(b.hasDelivered("entity1", "note:a")).toBe(true);
    expect(b.hasDelivered("entity1", "note:b")).toBe(true);
    // filter() suppresses already-delivered keys across the session boundary.
    const passed = b.filter("entity1", { "note:a": 1, "note:c": 2 });
    expect(passed).toEqual({ "note:c": 2 });
  });

  it("cold entries (older than the warm TTL) re-surface", () => {
    process.env[FLAG] = "1";
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    // Persist with an aged clock so the entry is written cold.
    const a = createSessionDedup({ cwd, now: () => eightDaysAgo });
    a.markDelivered("entity1", ["note:a"]);
    a.flush();
    // A fresh tracker on the live clock drops the cold entry on seed.
    const b = createSessionDedup({ cwd });
    expect(b.hasDelivered("entity1", "note:a")).toBe(false);
  });

  it("direct hook helpers record + probe through the same file", () => {
    process.env[FLAG] = "1";
    expect(xsessionWasDelivered(cwd, "__session_resume__", "h1")).toBe(false);
    xsessionRecordDelivered(cwd, "__session_resume__", ["h1"]);
    expect(xsessionWasDelivered(cwd, "__session_resume__", "h1")).toBe(true);
    // A tracker created afterward is seeded from the same record.
    const t = createSessionDedup({ cwd });
    expect(t.hasDelivered("__session_resume__", "h1")).toBe(true);
  });

  it("hook helpers are no-ops when the flag is off", () => {
    delete process.env[FLAG];
    xsessionRecordDelivered(cwd, "e", ["k"]);
    expect(
      existsSync(join(cwd, ".unerr", "state", "xsession-dedup.json"))
    ).toBe(false);
    expect(xsessionWasDelivered(cwd, "e", "k")).toBe(false);
  });

  it("persisted file carries the schema + entity timestamps", () => {
    process.env[FLAG] = "1";
    const a = createSessionDedup({ cwd });
    a.markDelivered("entity1", ["note:a"]);
    a.flush();
    const file = JSON.parse(
      readFileSync(join(cwd, ".unerr", "state", "xsession-dedup.json"), "utf8")
    ) as {
      schema: number;
      entities: Record<string, { keys: string[]; ts: number }>;
    };
    expect(file.schema).toBe(1);
    expect(file.entities.entity1?.keys).toEqual(["note:a"]);
    expect(typeof file.entities.entity1?.ts).toBe("number");
  });
});
