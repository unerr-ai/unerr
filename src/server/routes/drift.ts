/**
 * N10 — Drift metrics endpoint for the Reasoning Quality dashboard pane.
 *
 * Surfaces nudge-v2 session state (Tier-1 emissions per kind, drift count,
 * Tier-2 escalations, last unerr-tool timestamp) so the UI can render a
 * "drift events this session" sparkline and "drift correction rate" KPI.
 *
 * Read-only — no side effects, no DB writes. Reads `.unerr/state/nudge-*.flags`
 * files directly. Falls back to empty data if no sessions have flag files yet.
 *
 * GET /api/drift/sessions  — aggregate across all known session flag files
 * GET /api/drift/current   — current session only (UNERR_SESSION_ID)
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";

export interface DriftRouteDeps {
  cwd: string;
}

interface NudgeFlags {
  tier0_emitted?: boolean;
  tier1_emitted_kinds?: string[];
  drift_count?: number;
  tier2_emitted?: boolean;
  last_unerr_tool_at?: string;
}

interface SessionDriftRow {
  session_id: string;
  tier0_emitted: boolean;
  tier1_kinds: string[];
  drift_count: number;
  tier2_emitted: boolean;
  last_unerr_tool_at: string | null;
}

function readFlags(path: string): NudgeFlags | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as NudgeFlags;
  } catch {
    return null;
  }
}

function listSessionFiles(stateDir: string): string[] {
  try {
    if (!existsSync(stateDir)) return [];
    return readdirSync(stateDir)
      .filter((f) => f.startsWith("nudge-") && f.endsWith(".flags"))
      .map((f) => join(stateDir, f));
  } catch {
    return [];
  }
}

function rowFor(file: string): SessionDriftRow | null {
  const flags = readFlags(file);
  if (!flags) return null;
  const id = file
    .split("/")
    .pop()!
    .replace(/^nudge-/, "")
    .replace(/\.flags$/, "");
  return {
    session_id: id,
    tier0_emitted: Boolean(flags.tier0_emitted),
    tier1_kinds: Array.isArray(flags.tier1_emitted_kinds)
      ? flags.tier1_emitted_kinds
      : [],
    drift_count: typeof flags.drift_count === "number" ? flags.drift_count : 0,
    tier2_emitted: Boolean(flags.tier2_emitted),
    last_unerr_tool_at: flags.last_unerr_tool_at ?? null,
  };
}

export function createDriftRoutes(deps: DriftRouteDeps): Hono {
  const app = new Hono();
  const stateDir = join(deps.cwd, ".unerr", "state");

  app.get("/sessions", (c) => {
    const rows: SessionDriftRow[] = [];
    for (const file of listSessionFiles(stateDir)) {
      const r = rowFor(file);
      if (r) rows.push(r);
    }
    const totalDrift = rows.reduce((s, r) => s + r.drift_count, 0);
    const corrected = rows.filter((r) => r.last_unerr_tool_at).length;
    return c.json({
      data: {
        sessions: rows,
        total_sessions: rows.length,
        total_drift_events: totalDrift,
        sessions_with_correction: corrected,
        correction_rate: rows.length > 0 ? corrected / rows.length : 0,
      },
    });
  });

  app.get("/current", (c) => {
    const id = process.env.UNERR_SESSION_ID ?? `pid-${process.pid}`;
    const file = join(stateDir, `nudge-${id}.flags`);
    const row = rowFor(file);
    return c.json({
      data: row ?? {
        session_id: id,
        tier0_emitted: false,
        tier1_kinds: [],
        drift_count: 0,
        tier2_emitted: false,
        last_unerr_tool_at: null,
      },
    });
  });

  return app;
}
