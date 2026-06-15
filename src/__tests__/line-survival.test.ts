import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BehaviorEventSink,
  type LineSurvivalRow,
  computeAndRecordLineSurvival,
  computeLineSurvival,
} from "../tracking/line-survival.js";
import { clearGitCache } from "../utils/git.js";

// ── temp-repo helpers ────────────────────────────────────────────────

function git(dir: string, args: string[], env?: Record<string, string>): void {
  execFileSync("git", args, {
    cwd: dir,
    stdio: "ignore",
    env: { ...process.env, ...env },
  });
}

function initRepo(dir: string): void {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.t"]);
  git(dir, ["config", "user.name", "tester"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

/** Commit the current tree; trailer present => AI-authored. */
function commit(dir: string, msg: string, ai: boolean): void {
  git(dir, ["add", "-A"]);
  const full = ai ? `${msg}\n\nUnerr-Session: sess_xyz\n` : msg;
  git(dir, ["commit", "-q", "-m", full]);
}

function write(dir: string, file: string, lines: number): void {
  const body = Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n");
  writeFileSync(join(dir, file), `${body}\n`);
}

function find(
  rows: LineSurvivalRow[],
  author: "ai" | "human",
  cohort: 30 | 90
): LineSurvivalRow {
  const r = rows.find(
    (x) => x.authored_by === author && x.cohort_days === cohort
  );
  if (!r) throw new Error(`missing row ${author}/${cohort}`);
  return r;
}

// ── tests ────────────────────────────────────────────────────────────

// Every case shells out to real `git` (init/config/add/commit/log/blame) via
// synchronous execFileSync. Under the parallel forks pool (~14 forks each
// spawning git at once) that subprocess contention legitimately overruns
// vitest's 5s default, so widen both the test and hook budgets for this file.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

describe("line-survival producer", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "line-survival-"));
    clearGitCache();
  });
  afterEach(() => {
    clearGitCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns [] for a non-git directory", async () => {
    const rows = await computeLineSurvival(dir);
    expect(rows).toEqual([]);
  });

  it("emits one row per (authored_by, cohort) — 4 rows", async () => {
    initRepo(dir);
    write(dir, "a.txt", 5);
    commit(dir, "ai add", true);
    const rows = await computeLineSurvival(dir);
    expect(rows).toHaveLength(4);
    const pairs = rows.map((r) => `${r.authored_by}/${r.cohort_days}`).sort();
    expect(pairs).toEqual(["ai/30", "ai/90", "human/30", "human/90"]);
  });

  it("counts AI-authored added lines via the Unerr-Session trailer", async () => {
    initRepo(dir);
    write(dir, "a.txt", 10);
    commit(dir, "ai add 10", true);
    const rows = await computeLineSurvival(dir);
    const ai30 = find(rows, "ai", 30);
    expect(ai30.lines_authored).toBe(10);
    expect(ai30.lines_still_present).toBe(10);
    // No human commits → human cells are zero.
    expect(find(rows, "human", 30).lines_authored).toBe(0);
  });

  it("attributes human commits to the human cohort", async () => {
    initRepo(dir);
    write(dir, "h.txt", 7);
    commit(dir, "human add 7", false);
    const rows = await computeLineSurvival(dir);
    expect(find(rows, "human", 30).lines_authored).toBe(7);
    expect(find(rows, "human", 30).lines_still_present).toBe(7);
    expect(find(rows, "ai", 30).lines_authored).toBe(0);
  });

  it("survival drops when a later commit rewrites earlier lines", async () => {
    initRepo(dir);
    // AI authors 6 lines ("line 0".."line 5").
    write(dir, "a.txt", 6);
    commit(dir, "ai add 6", true);
    // Human overwrites with 3 textually DIFFERENT lines (no overlap with the
    // AI content), so git-blame attributes none of the survivors to the AI
    // commit — the AI's original lines no longer exist verbatim in HEAD.
    writeFileSync(join(dir, "a.txt"), "alpha\nbeta\ngamma\n");
    commit(dir, "human rewrite to 3", false);

    const rows = await computeLineSurvival(dir);
    const ai30 = find(rows, "ai", 30);
    const human30 = find(rows, "human", 30);

    // AI authored 6 lines but none survive (all blamed to the human rewrite).
    expect(ai30.lines_authored).toBe(6);
    expect(ai30.lines_still_present).toBe(0);
    // Human added 3 surviving lines.
    expect(human30.lines_authored).toBe(3);
    expect(human30.lines_still_present).toBe(3);
  });

  it("computeAndRecordLineSurvival writes a row per cohort cell with C3 detail", async () => {
    initRepo(dir);
    write(dir, "a.txt", 4);
    commit(dir, "ai add 4", true);

    const captured: Array<Record<string, unknown>> = [];
    const sink: BehaviorEventSink = {
      insertBehaviorEvent(row) {
        captured.push(row);
        return captured.length;
      },
    };

    const rows = await computeAndRecordLineSurvival({
      cwd: dir,
      sink,
      sessionId: "sess_test",
      agent: "claude-code",
    });

    expect(rows).toHaveLength(4);
    expect(captured).toHaveLength(4);

    for (const row of captured) {
      expect(row.type).toBe("line_survival_rollup");
      expect(row.session_id).toBe("sess_test");
      expect(row.tool).toBeNull();
      expect(row.entity_key).toBeNull();
      const detail = JSON.parse(row.detail as string) as Record<
        string,
        unknown
      >;
      // Exactly the four C3 allow-list keys — nothing else.
      expect(Object.keys(detail).sort()).toEqual([
        "authored_by",
        "cohort_days",
        "lines_authored",
        "lines_still_present",
      ]);
      expect(["ai", "human"]).toContain(detail.authored_by);
      expect([30, 90]).toContain(detail.cohort_days);
      expect(typeof detail.lines_authored).toBe("number");
      expect(typeof detail.lines_still_present).toBe("number");
    }

    // The AI/30 cell carries the authored 4 surviving lines.
    const ai30 = captured
      .map((r) => JSON.parse(r.detail as string) as Record<string, unknown>)
      .find((d) => d.authored_by === "ai" && d.cohort_days === 30);
    expect(ai30?.lines_authored).toBe(4);
    expect(ai30?.lines_still_present).toBe(4);
  });

  it("emits no rows (and writes nothing) for a non-repo", async () => {
    const captured: unknown[] = [];
    const sink: BehaviorEventSink = {
      insertBehaviorEvent(row) {
        captured.push(row);
        return 1;
      },
    };
    const rows = await computeAndRecordLineSurvival({
      cwd: dir, // not a git repo
      sink,
      sessionId: "s",
    });
    expect(rows).toEqual([]);
    expect(captured).toHaveLength(0);
  });
});
