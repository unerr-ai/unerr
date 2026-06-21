import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createSessionDedup,
  xsessionRecordDelivered,
  xsessionWasDelivered,
} from "../proxy/session-dedup.js";

/**
 * Cross-session dedup — when a repo root (`cwd`) is supplied, the dedup set
 * persists to `.unerr/state/xsession-dedup.json` and seeds the next session so
 * identical context is not re-injected. Entries older than the warm TTL drop on
 * load so stale notes re-surface.
 */
describe("cross-session dedup", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "unerr-xsession-"));
  });

  it("a tracker without a cwd keeps no cross-session state", () => {
    const a = createSessionDedup();
    a.markDelivered("entity1", ["note:a"]);
    a.flush();
    expect(
      existsSync(join(cwd, ".unerr", "state", "xsession-dedup.json"))
    ).toBe(false);
  });

  it("a new tracker is seeded from the prior session's delivered set", () => {
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
    expect(xsessionWasDelivered(cwd, "__session_resume__", "h1")).toBe(false);
    xsessionRecordDelivered(cwd, "__session_resume__", ["h1"]);
    expect(xsessionWasDelivered(cwd, "__session_resume__", "h1")).toBe(true);
    // A tracker created afterward is seeded from the same record.
    const t = createSessionDedup({ cwd });
    expect(t.hasDelivered("__session_resume__", "h1")).toBe(true);
  });

  it("persisted file carries the schema + entity timestamps", () => {
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
