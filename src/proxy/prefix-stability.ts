import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openMetricsStore } from "../tracking/metrics-store.js";
import { resolveExecSessionContext } from "../tracking/session-records.js";

/**
 * Prefix / KV-cache stability accounting (Sprint 2, T2.5). Records whether the
 * static injected prefix (legend, conventions) was byte-identical to the prior
 * turn and how large it was, onto the EXISTING `compression_events` stream — no
 * new event type. A drop to prefix_stable=false flags a cache-bust regression.
 *
 * @sem domain=compression role=accounting
 */

const STATE_FILE = join(".unerr", "state", "prefix-stability.json");

interface PrefixStabilityState {
  /** sha256 of the last stable-prefix block emitted (truncated). */
  hash?: string;
}

function readState(file: string): PrefixStabilityState {
  try {
    if (!existsSync(file)) return {};
    const obj = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (obj && typeof obj === "object") return obj as PrefixStabilityState;
  } catch {
    /* fall through to empty */
  }
  return {};
}

function writeState(file: string, state: PrefixStabilityState): void {
  try {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(state));
  } catch {
    /* best-effort */
  }
}

/**
 * Record one stable-prefix emission. Compares the block's content hash to the
 * previous turn's; writes a `compression_events` row with `prefix_stable`
 * (1 when byte-identical to the prior turn, else 0) and `prefix_bytes` (the
 * UTF-8 size of the stable block). Best-effort — never throws, never breaks the
 * hook that injected the prefix.
 */
export function recordPrefixStability(cwd: string, stableBlock: string): void {
  if (!stableBlock) return;
  try {
    const statePath = join(cwd, STATE_FILE);
    const prev = readState(statePath);
    const hash = createHash("sha256")
      .update(stableBlock, "utf8")
      .digest("hex")
      .slice(0, 32);
    // First emission of a session has no prior to compare against → not stable.
    const stable = prev.hash !== undefined && prev.hash === hash;
    writeState(statePath, { hash });

    const ts = Date.now();
    const bytes = Buffer.byteLength(stableBlock, "utf8");
    const sc = resolveExecSessionContext(join(cwd, ".unerr"));
    openMetricsStore(join(cwd, ".unerr")).insertCompression({
      ts,
      ts_iso: new Date(ts).toISOString(),
      session_id: sc.session_id,
      native_session_id: sc.native_session_id,
      turn: sc.turn,
      agent: sc.agent,
      command: "prefix",
      category: "prefix_stability",
      confidence: 1,
      raw_bytes: bytes,
      compressed_bytes: bytes,
      saved_pct: 0,
      omni_fallback: 0,
      tee_file: null,
      event_kind: "compress",
      mechanism: "prefix_stability",
      prefix_stable: stable ? 1 : 0,
      prefix_bytes: bytes,
    });
  } catch {
    /* best-effort — accounting must never break prefix injection */
  }
}
