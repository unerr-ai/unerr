/**
 * Cascade-guard route — verifies the "what was I protected from" feed:
 *   • firings group by session, then by the prompt that initiated them
 *     (joined by timestamp, since the prompt hook writes turn:0);
 *   • the enriched per-firing detail (entity + named callers + truncation,
 *     and boundary breaches) survives the round-trip to the UI shape;
 *   • totals carry a recent-window figure, not just a lifetime tally;
 *   • an unseeded store returns an empty feed, not an error.
 *
 * Seeds a real metrics store via the production BehaviorEventWriter — no
 * mocking of the read path.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGuardRoutes } from "../server/routes/guard.js";
import { BehaviorEventWriter } from "../tracking/behavior-events.js";
import { closeMetricsStore } from "../tracking/metrics-store.js";

let repoCwd: string;
let unerrDir: string;
const SID = "guard-sess";

function seed(): void {
  const beh = new BehaviorEventWriter(unerrDir, SID, { agent: "claude-code" });
  // Prompt recorded first so its timestamp precedes both firings — the join
  // attaches both firings to this prompt.
  beh.record({
    session_id: SID,
    turn: 1,
    type: "user_prompt_received",
    tool: null,
    entity_key: null,
    response_bytes: null,
    detail: {
      prompt: "rename the gzip extraction helper",
      length: 33,
      classified_as: "refactor",
    },
  });
  beh.record({
    session_id: SID,
    turn: 1,
    type: "cascade_guard",
    tool: null,
    entity_key: "src/downloader.ts",
    response_bytes: null,
    detail: {
      warnings: 1,
      total_at_risk: 13,
      change_types: ["parameter_renamed"],
      file_path: "src/downloader.ts",
      firings: [
        {
          entity: "extractGzSingle",
          entity_key: "0a83af3717aeaf66",
          change_type: "parameter_renamed",
          total_at_risk: 13,
          callers: [
            { file: "src/a.ts", entity: "foo", line: 5, is_test: false },
            { file: "src/b.ts", entity: "bar", line: 9, is_test: false },
          ],
          callers_truncated: 11,
        },
      ],
    },
  });
  beh.record({
    session_id: SID,
    turn: 1,
    type: "boundary_violation_flagged",
    tool: null,
    entity_key: "src/proxy/bridge.ts",
    response_bytes: null,
    detail: {
      violations: 1,
      target_layers: ["src/intelligence/"],
      file_path: "src/proxy/bridge.ts",
      breaches: [
        {
          source_file: "src/proxy/bridge.ts",
          source_layer: "src/proxy/",
          target_layer: "src/intelligence/",
          specifier: "../intelligence/edit-impact.js",
        },
      ],
    },
  });
}

beforeEach(() => {
  repoCwd = join(
    tmpdir(),
    `unerr-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  unerrDir = join(repoCwd, ".unerr");
  mkdirSync(unerrDir, { recursive: true });
  seed();
});

afterEach(() => {
  try {
    closeMetricsStore(unerrDir);
  } catch {
    /* ignore */
  }
  rmSync(repoCwd, { recursive: true, force: true });
});

interface FiringsBody {
  data: {
    sessions: Array<{
      session_id: string;
      agent: string;
      firing_count: number;
      prompts: Array<{
        prompt: string | null;
        firings: Array<{
          type: string;
          max_at_risk: number;
          entities: Array<{
            entity: string;
            callers: unknown[];
            callers_truncated: number;
          }>;
          breaches: Array<{ target_layer: string }>;
        }>;
      }>;
    }>;
    totals: {
      total_firings: number;
      cascade_firings: number;
      boundary_firings: number;
      recent_window: number;
      window_days: number;
    };
  };
}

describe("createGuardRoutes /firings", () => {
  it("groups firings by session → prompt and carries the enriched detail", async () => {
    const app = createGuardRoutes({ unerrDir });
    const res = await app.request("/firings");
    expect(res.status).toBe(200);

    const body = (await res.json()) as FiringsBody;
    const { sessions, totals } = body.data;

    expect(totals.total_firings).toBe(2);
    expect(totals.cascade_firings).toBe(1);
    expect(totals.boundary_firings).toBe(1);
    expect(totals.recent_window).toBe(2);

    expect(sessions).toHaveLength(1);
    const sess = sessions[0]!;
    expect(sess.session_id).toBe(SID);
    expect(sess.agent).toBe("claude-code");
    expect(sess.firing_count).toBe(2);

    // Both firings attach to the single initiating prompt.
    expect(sess.prompts).toHaveLength(1);
    expect(sess.prompts[0]!.prompt).toBe("rename the gzip extraction helper");

    const firings = sess.prompts[0]!.firings;
    expect(firings).toHaveLength(2);

    const cascade = firings.find((f) => f.type === "cascade_guard")!;
    expect(cascade.max_at_risk).toBe(13);
    expect(cascade.entities[0]!.entity).toBe("extractGzSingle");
    expect(cascade.entities[0]!.callers).toHaveLength(2);
    expect(cascade.entities[0]!.callers_truncated).toBe(11);

    const boundary = firings.find(
      (f) => f.type === "boundary_violation_flagged"
    )!;
    expect(boundary.breaches[0]!.target_layer).toBe("src/intelligence/");
  });

  it("returns an empty feed (not an error) when nothing has fired", async () => {
    const emptyDir = join(repoCwd, ".unerr-empty");
    mkdirSync(emptyDir, { recursive: true });
    const app = createGuardRoutes({ unerrDir: emptyDir });
    const res = await app.request("/firings");
    expect(res.status).toBe(200);

    const body = (await res.json()) as FiringsBody;
    expect(body.data.sessions).toEqual([]);
    expect(body.data.totals.total_firings).toBe(0);
    closeMetricsStore(emptyDir);
  });
});
