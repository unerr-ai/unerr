/**
 * Scores Track 4 runs across the four platform pillars: savings (reuses the
 * SWE-Effi token-bounded score), guardrails (fires + a break-prevention
 * cross-check), memory (warm unerr vs memory-wiped unerr on dependent tasks),
 * and cost. Pure functions over the recorded runs — no spawning, no I/O — so the
 * scoring math is unit-testable without a real agent run.
 *
 * @sem domain=benchmark role=scorer
 */
import {
  type AbComparison,
  type ArmScore,
  compareArms,
  scoreArm,
} from "../track3-e2e-ab/swe-effi.js";
import { armKeepsMemory, type ArmId, type RunRecord } from "./types.js";

/** Per-arm savings/resolve scores keyed by arm id. */
export type ArmScores = Record<ArmId, ArmScore>;

/**
 * One task where unerr's guardrail plausibly prevented a regression: the
 * baseline arm left the gate test red while the unerr arm passed AND a guardrail
 * fired during the unerr run. Not proof of causation, but a countable signal the
 * report names task-by-task rather than asserting in aggregate.
 */
export interface GuardrailSave {
  taskId: string;
  /** Guardrail-event types that fired during the unerr run on this task. */
  firedTypes: string[];
}

/**
 * One dependent task scored for memory carry-over: did warm unerr resolve it
 * while memory-wiped unerr did not? `dependsOn` being non-empty is what makes a
 * task a memory probe in the first place.
 */
export interface CarryOverResult {
  taskId: string;
  dependsOn: string[];
  warmResolved: boolean;
  wipedResolved: boolean;
  /** True when warm beat wiped — the carry-over paid off on this task. */
  memoryHelped: boolean;
}

/** The whole Track 4 scorecard. */
export interface Track4Report {
  scores: Partial<ArmScores>;
  /** baseline → unerr comparison (savings/resolve/turns/AUC). Null if either arm absent. */
  unerrVsBaseline: AbComparison | null;
  /** Total guardrail fires across all unerr runs. */
  guardrailFires: number;
  /** Tasks where a guardrail plausibly prevented a regression. */
  guardrailSaves: GuardrailSave[];
  /** Per-dependent-task memory carry-over outcomes (warm vs wiped unerr). */
  carryOver: CarryOverResult[];
  /** Count of dependent tasks where warm memory beat the wiped arm. */
  memoryWins: number;
  /** Sum of real USD cost per arm (0 on a subscription run). */
  costByArm: Partial<Record<ArmId, number>>;
}

/** Group runs by arm. */
function byArm(runs: RunRecord[]): Map<ArmId, RunRecord[]> {
  const m = new Map<ArmId, RunRecord[]>();
  for (const r of runs) {
    const list = m.get(r.arm) ?? [];
    list.push(r);
    m.set(r.arm, list);
  }
  return m;
}

/** Index runs by `${arm}:${taskId}` for direct cross-arm lookup. */
function indexByArmTask(runs: RunRecord[]): Map<string, RunRecord> {
  const m = new Map<string, RunRecord>();
  for (const r of runs) {
    m.set(`${r.arm}:${r.taskId}`, r);
  }
  return m;
}

/**
 * Cross-check for guardrail saves: for each task the baseline failed but unerr
 * passed, report it as a save when a guardrail fired during the unerr run.
 */
export function findGuardrailSaves(runs: RunRecord[]): GuardrailSave[] {
  const idx = indexByArmTask(runs);
  const saves: GuardrailSave[] = [];
  const taskIds = new Set(runs.map((r) => r.taskId));
  for (const taskId of taskIds) {
    const baseline = idx.get(`baseline:${taskId}`);
    const unerr = idx.get(`unerr:${taskId}`);
    if (!baseline || !unerr) continue;
    const passedWhereBaselineFailed = unerr.resolved && !baseline.resolved;
    const firedTypes = Object.keys(unerr.platform.eventsByType).filter(
      (t) => unerr.platform.guardrailFires > 0 && unerr.platform.eventsByType[t]
    );
    if (passedWhereBaselineFailed && unerr.platform.guardrailFires > 0) {
      saves.push({ taskId, firedTypes });
    }
  }
  return saves;
}

/**
 * Memory carry-over: compare warm `unerr` against `unerr-nomemory` on every
 * dependent task (one with a non-empty `dependsOn`). A win is warm resolving a
 * task the wiped arm did not.
 */
export function scoreCarryOver(runs: RunRecord[]): CarryOverResult[] {
  const idx = indexByArmTask(runs);
  const results: CarryOverResult[] = [];
  const seen = new Set<string>();
  for (const r of runs) {
    if (r.dependsOn.length === 0 || seen.has(r.taskId)) continue;
    const warm = idx.get(`unerr:${r.taskId}`);
    const wiped = idx.get(`unerr-nomemory:${r.taskId}`);
    if (!warm || !wiped) continue;
    seen.add(r.taskId);
    results.push({
      taskId: r.taskId,
      dependsOn: r.dependsOn,
      warmResolved: warm.resolved,
      wipedResolved: wiped.resolved,
      memoryHelped: warm.resolved && !wiped.resolved,
    });
  }
  return results;
}

/** Build the full Track 4 scorecard from the recorded runs. */
export function buildReport(runs: RunRecord[]): Track4Report {
  const grouped = byArm(runs);
  const scores: Partial<ArmScores> = {};
  const costByArm: Partial<Record<ArmId, number>> = {};
  for (const [arm, armRuns] of grouped) {
    scores[arm] = scoreArm(arm, armRuns);
    costByArm[arm] = armRuns.reduce((a, r) => a + r.costUsd, 0);
  }

  const baseline = scores.baseline;
  const unerr = scores.unerr;
  const unerrVsBaseline =
    baseline && unerr ? compareArms(baseline, unerr) : null;

  const guardrailFires = runs
    .filter((r) => armKeepsMemory(r.arm) || r.arm === "unerr-nomemory")
    .reduce((a, r) => a + r.platform.guardrailFires, 0);

  const carryOver = scoreCarryOver(runs);

  return {
    scores,
    unerrVsBaseline,
    guardrailFires,
    guardrailSaves: findGuardrailSaves(runs),
    carryOver,
    memoryWins: carryOver.filter((c) => c.memoryHelped).length,
    costByArm,
  };
}

/** Render the scorecard as a markdown report. */
export function renderReport(report: Track4Report): string {
  const L: string[] = [];
  L.push("# Track 4 — Single-repo host-local A/B (full platform)");
  L.push("");

  L.push("## Savings & resolve (SWE-Effi scored)");
  const cmp = report.unerrVsBaseline;
  if (cmp) {
    L.push(`| Metric | Baseline | unerr | Δ |`);
    L.push(`|---|--:|--:|--:|`);
    L.push(
      `| Instances | ${cmp.baseline.n} | ${cmp.treatment.n} | |`
    );
    L.push(
      `| Resolve rate | ${(cmp.baseline.resolveRate * 100).toFixed(1)}% | ${(cmp.treatment.resolveRate * 100).toFixed(1)}% | ${(cmp.resolveRateDelta * 100).toFixed(1)}pp |`
    );
    L.push(
      `| Total input tokens | ${cmp.baseline.totalInputTokens.toLocaleString()} | ${cmp.treatment.totalInputTokens.toLocaleString()} | -${cmp.inputTokenReductionPct.toFixed(1)}% |`
    );
    L.push(
      `| Mean turns | ${cmp.baseline.meanTurns.toFixed(1)} | ${cmp.treatment.meanTurns.toFixed(1)} | ${cmp.meanTurnsDelta.toFixed(1)} |`
    );
    L.push(
      `| Token-bounded AUC | ${cmp.baseline.tokenBoundedAuc.toFixed(3)} | ${cmp.treatment.tokenBoundedAuc.toFixed(3)} | ${cmp.aucDelta.toFixed(3)} |`
    );
  } else {
    L.push("_baseline and unerr arms both required — one is missing._");
  }
  L.push("");

  L.push("## Guardrails");
  L.push(`Total guardrail fires across unerr runs: **${report.guardrailFires}**`);
  if (report.guardrailSaves.length > 0) {
    L.push("");
    L.push("Tasks where a guardrail plausibly prevented a regression");
    L.push("(baseline left the test red, unerr passed, a guardrail fired):");
    L.push("");
    L.push(`| Task | Guardrails fired |`);
    L.push(`|---|---|`);
    for (const s of report.guardrailSaves) {
      L.push(`| ${s.taskId} | ${s.firedTypes.join(", ") || "—"} |`);
    }
  } else {
    L.push("_No guardrail-attributed saves in this run._");
  }
  L.push("");

  L.push("## Memory carry-over (warm unerr vs memory-wiped unerr)");
  if (report.carryOver.length > 0) {
    L.push(
      `Dependent tasks where warm memory beat the wiped arm: **${report.memoryWins}/${report.carryOver.length}**`
    );
    L.push("");
    L.push(`| Task | Depends on | Warm | Wiped | Memory helped |`);
    L.push(`|---|---|:--:|:--:|:--:|`);
    for (const c of report.carryOver) {
      L.push(
        `| ${c.taskId} | ${c.dependsOn.join(", ")} | ${c.warmResolved ? "✓" : "✗"} | ${c.wipedResolved ? "✓" : "✗"} | ${c.memoryHelped ? "yes" : "no"} |`
      );
    }
  } else {
    L.push("_No dependent tasks — add tasks with `dependsOn` to probe memory._");
  }
  L.push("");

  L.push("## Cost");
  L.push(`| Arm | USD |`);
  L.push(`|---|--:|`);
  for (const arm of Object.keys(report.costByArm) as ArmId[]) {
    L.push(`| ${arm} | $${(report.costByArm[arm] ?? 0).toFixed(4)} |`);
  }
  L.push("");
  L.push(
    "_Cost is 0 on a Claude Code subscription run — the savings signal there is total input tokens and turns, not dollars._"
  );

  return L.join("\n");
}
