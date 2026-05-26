/**
 * Weekly Summary Accumulator — unified cross-session stats persistence.
 *
 * S8.4: Persists session metrics to ~/.unerr/stats.json.
 * Replaces the separate cumulative-stats.json and cumulative-local-stats.json.
 *
 * Features:
 *   - Weekly auto-reset (Monday boundary)
 *   - All-time counters that persist across resets
 *   - Feeds into `unerr stats` command and session guard
 */

export interface WeeklyStats {
  weekStart: string;
  sessions: number;
  tokensSaved: number;
  toolCalls: number;
  violationsCaught: number;
  chokepointWarnings: number;
  correctionsApplied: number;
  blastRadiusComputed: number;
  avgEfficiency: number;
  avgLatencyP50: number;
  /** Layer 10: Cumulative tokens saved per mechanism this week. */
  tokensByMechanism?: Record<string, number>;
}

export interface AllTimeStats {
  firstSessionDate: string;
  totalSessions: number;
  totalTokensSaved: number;
  totalViolationsCaught: number;
}

export interface UnifiedStats {
  version: 1;
  weekly: WeeklyStats;
  allTime: AllTimeStats;
  lastUpdated: string;
}

function getWeekStart(): string {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now);
  monday.setDate(diff);
  return monday.toISOString().slice(0, 10);
}

function getStatsPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
  return `${home}/.unerr/stats.json`;
}

function createEmptyWeekly(weekStart: string): WeeklyStats {
  return {
    weekStart,
    sessions: 0,
    tokensSaved: 0,
    toolCalls: 0,
    violationsCaught: 0,
    chokepointWarnings: 0,
    correctionsApplied: 0,
    blastRadiusComputed: 0,
    avgEfficiency: 0,
    avgLatencyP50: 0,
  };
}

function createEmptyAllTime(): AllTimeStats {
  return {
    firstSessionDate: new Date().toISOString(),
    totalSessions: 0,
    totalTokensSaved: 0,
    totalViolationsCaught: 0,
  };
}

export function loadStats(): UnifiedStats {
  const currentWeek = getWeekStart();
  try {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const raw = JSON.parse(
      readFileSync(getStatsPath(), "utf-8")
    ) as UnifiedStats;

    if (raw.version !== 1) {
      return {
        version: 1,
        weekly: createEmptyWeekly(currentWeek),
        allTime: createEmptyAllTime(),
        lastUpdated: new Date().toISOString(),
      };
    }

    // Reset weekly if new week, preserve all-time
    if (raw.weekly.weekStart !== currentWeek) {
      raw.weekly = createEmptyWeekly(currentWeek);
    }

    return raw;
  } catch {
    return {
      version: 1,
      weekly: createEmptyWeekly(currentWeek),
      allTime: createEmptyAllTime(),
      lastUpdated: new Date().toISOString(),
    };
  }
}

export interface SessionAccumulatorInput {
  tokensSaved: number;
  toolCalls: number;
  violationsCaught: number;
  chokepointWarnings: number;
  correctionsApplied: number;
  blastRadiusComputed: number;
  efficiency: number;
  latencyP50: number;
  /** Layer 10: Per-mechanism token savings from this session. */
  tokensByMechanism?: Record<string, number>;
}

/**
 * Accumulate a session's metrics into the unified stats file.
 * Returns the updated stats for display.
 */
export function accumulateSession(
  input: SessionAccumulatorInput
): UnifiedStats {
  const stats = loadStats();

  // Weekly
  stats.weekly.sessions += 1;
  stats.weekly.tokensSaved += input.tokensSaved;
  stats.weekly.toolCalls += input.toolCalls;
  stats.weekly.violationsCaught += input.violationsCaught;
  stats.weekly.chokepointWarnings += input.chokepointWarnings;
  stats.weekly.correctionsApplied += input.correctionsApplied;
  stats.weekly.blastRadiusComputed += input.blastRadiusComputed;

  // Rolling average for efficiency and latency
  const n = stats.weekly.sessions;
  stats.weekly.avgEfficiency =
    stats.weekly.avgEfficiency * ((n - 1) / n) + input.efficiency * (1 / n);
  stats.weekly.avgLatencyP50 =
    stats.weekly.avgLatencyP50 * ((n - 1) / n) + input.latencyP50 * (1 / n);

  // Layer 10: Accumulate per-mechanism token savings
  if (input.tokensByMechanism) {
    if (!stats.weekly.tokensByMechanism) stats.weekly.tokensByMechanism = {};
    for (const [mech, saved] of Object.entries(input.tokensByMechanism)) {
      stats.weekly.tokensByMechanism[mech] =
        (stats.weekly.tokensByMechanism[mech] ?? 0) + saved;
    }
  }

  // All-time
  stats.allTime.totalSessions += 1;
  stats.allTime.totalTokensSaved += input.tokensSaved;
  stats.allTime.totalViolationsCaught += input.violationsCaught;

  stats.lastUpdated = new Date().toISOString();

  persistStats(stats);
  return stats;
}

function persistStats(stats: UnifiedStats): void {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const filePath = getStatsPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(stats, null, 2));
  } catch {
    // Non-critical — don't break session shutdown
  }
}

/**
 * Format stats for the `unerr stats` command output.
 */
export function formatStatsReport(stats: UnifiedStats): string {
  const w = stats.weekly;
  const a = stats.allTime;

  const lines: string[] = [
    "",
    "── unerr stats ────────────────────────────────",
    "",
    "  This week:",
    `    Sessions:       ${w.sessions}`,
    `    Tool calls:     ${w.toolCalls}`,
    `    Tokens saved:   ~${formatTokenCount(w.tokensSaved)}`,
    `    Efficiency:     ${Math.round(w.avgEfficiency)}%`,
    `    Violations:     ${w.violationsCaught} caught`,
  ];

  if (w.blastRadiusComputed > 0) {
    lines.push(`    Blast radius:   ${w.blastRadiusComputed} computations`);
  }

  // Layer 10: Mechanism breakdown
  if (w.tokensByMechanism && Object.keys(w.tokensByMechanism).length > 0) {
    lines.push("");
    lines.push("  By mechanism:");
    const sorted = Object.entries(w.tokensByMechanism).sort(
      ([, a], [, b]) => b - a
    );
    const totalMech = sorted.reduce((s, [, v]) => s + v, 0);
    for (const [mech, saved] of sorted) {
      const pct = totalMech > 0 ? Math.round((saved / totalMech) * 100) : 0;
      const barLen = Math.max(1, Math.round(pct / 5));
      const bar = "█".repeat(barLen) + "░".repeat(20 - barLen);
      lines.push(
        `    ${mech.padEnd(22)} ${formatTokenCount(saved).padStart(6)}  ${String(pct).padStart(3)}%  ${bar}`
      );
    }
  }

  lines.push("");
  lines.push("  All time:");
  lines.push(`    Sessions:       ${a.totalSessions}`);
  lines.push(`    Tokens saved:   ~${formatTokenCount(a.totalTokensSaved)}`);
  lines.push(`    Violations:     ${a.totalViolationsCaught} caught`);
  lines.push(`    Since:          ${a.firstSessionDate.slice(0, 10)}`);
  lines.push("");
  lines.push("───────────────────────────────────────────────");
  lines.push("");

  return lines.join("\n");
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
