/**
 * unerr status — check repo/proxy/graph/drift/ledger state.
 *
 * Renders a rich Ink dashboard to stderr with:
 *   - Repo info, branch, commits ahead/behind
 *   - Proxy state (running/stopped, PID)
 *   - Graph stats (entity count, edge count, age)
 *   - Health grade with progress bar
 *   - Drift summary
 *   - Live session latency if proxy is running
 *
 * All output to stderr to protect MCP stdout stream.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import React from "react";
import type { StatusData } from "../components/StatusDashboard.js";
import { getRemoteUrl } from "../utils/git.js";

/**
 * Contextual suggestions engine.
 * Surfaces actionable next steps based on current state.
 */
function buildSuggestions(data: {
  lastIndexed?: string;
  conventionCount?: number;
  skillCount?: number;
  proxyRunning: boolean;
  healthGrade?: string;
}): string[] {
  const suggestions: string[] = [];

  if (!data.lastIndexed) {
    suggestions.push("No index yet. Run 'unerr' to start indexing.");
  }
  if (data.conventionCount === 0 || data.conventionCount == null) {
    suggestions.push("Run 'unerr' to detect conventions and generate rules");
  }

  if (data.skillCount === 0 || data.skillCount == null) {
    suggestions.push(
      "No skills installed. Run 'unerr' to install agent skills."
    );
  }

  if (!data.proxyRunning) {
    suggestions.push("Run 'unerr' to start the proxy.");
  }

  return suggestions;
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Check repo, proxy, graph, drift, and ledger state")
    .action(async () => {
      const cwd = process.cwd();

      // ── Git Check ──────────────────────────────────────────────
      const { isGitRepo } = await import("../utils/git.js");
      if (!(await isGitRepo(cwd))) {
        process.stderr.write(
          "[unerr] Error: not inside a git repository.\n" +
            "  Run unerr from a project directory that has been initialized with git.\n"
        );
        process.exit(1);
      }

      const unerrDir = join(cwd, ".unerr");
      const localDataDir = join(cwd, ".unerr");

      // ── Repo Info ──────────────────────────────────────────────

      let repoId = "";

      const configPath = join(unerrDir, "config.json");
      if (existsSync(configPath)) {
        try {
          const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
            repoId?: string;
          };
          repoId = config.repoId ?? "";
        } catch {
          /* ignore */
        }
      }

      // ── Git Context ────────────────────────────────────────────

      let currentBranch = "unknown";
      let commitsAhead = 0;
      let commitsBehind: number | null = null;
      try {
        const { computeBranchContext } = await import(
          "../tracking/branch-context.js"
        );
        const ctx = await computeBranchContext(cwd);
        currentBranch = ctx.currentBranch;
        commitsAhead = ctx.commitsAhead;
        commitsBehind = ctx.commitsBehind;
      } catch {
        /* ignore */
      }

      const branchDetail =
        commitsBehind !== null
          ? `${currentBranch} (${commitsAhead} ahead, ${commitsBehind} behind)`
          : `${currentBranch} (${commitsAhead} ahead)`;

      // ── Repo Name ──────────────────────────────────────────────

      let repoFullName = repoId;
      const remote = await getRemoteUrl(cwd);
      if (remote) {
        const sshMatch = remote.match(/git@[^:]+:(.+?)(?:\.git)?$/);
        const httpMatch = remote.match(
          /(?:https?:\/\/)?(?:www\.)?[^/]+\/(.+?)(?:\.git)?$/
        );
        repoFullName = sshMatch?.[1] ?? httpMatch?.[1] ?? repoId;
      }

      // ── Proxy Status ───────────────────────────────────────────

      let proxyStatus = "Not running";
      let proxyRunning = false;
      const pidPath = join(unerrDir, "state", "proxy.pid");
      if (existsSync(pidPath)) {
        try {
          const pidStr = readFileSync(pidPath, "utf-8").trim();
          const pid = Number.parseInt(pidStr, 10);
          process.kill(pid, 0);
          proxyStatus = `Running (PID ${pid})`;
          proxyRunning = true;
        } catch {
          proxyStatus = "Not running (stale PID)";
        }
      }

      // ── Graph Stats ────────────────────────────────────────────
      // Derived from the snapshot envelope loaded in the Rule Health block
      // below. The only file the local indexer writes is
      // .unerr/snapshots/graph.msgpack.gz; the old manifests/<repoId>.json was
      // a server-pull artifact that is never written in local-first mode.

      let graphInfo = "No local graph";

      // ── Drift Stats ────────────────────────────────────────────

      let drift: StatusData["drift"] | undefined;
      const driftSummaryPath = join(unerrDir, "drift", "drift_summary.json");
      if (existsSync(driftSummaryPath)) {
        try {
          const summary = JSON.parse(
            readFileSync(driftSummaryPath, "utf-8")
          ) as {
            added?: number;
            modified?: number;
            deleted?: number;
          };
          drift = {
            modified: summary.modified ?? 0,
            added: summary.added ?? 0,
            deleted: summary.deleted ?? 0,
          };
        } catch {
          /* ignore */
        }
      }

      // ── Health Grade ───────────────────────────────────────────

      let healthGrade: string | undefined;
      let healthScore: number | undefined;
      const graphVersionPath = join(unerrDir, "state", "graph_version.json");
      if (existsSync(graphVersionPath)) {
        try {
          const gv = JSON.parse(readFileSync(graphVersionPath, "utf-8")) as {
            health_grade?: string;
            health_score?: number;
          };
          healthGrade = gv.health_grade;
          healthScore = gv.health_score;
        } catch {
          /* ignore */
        }
      }

      // ── Rule Health ───────────────────────────────────────────
      let ruleHealth: StatusData["ruleHealth"] | undefined;
      if (repoId) {
        try {
          const snapshotsDir = join(localDataDir, "snapshots");
          let snapshotPath = join(snapshotsDir, "graph.msgpack.gz");
          if (!existsSync(snapshotPath)) {
            snapshotPath = join(snapshotsDir, "graph.msgpack");
          }
          if (existsSync(snapshotPath)) {
            const { gunzipSync } = await import("node:zlib");
            const { unpack } = await import("msgpackr");
            const cozoModule = await import("cozo-node");
            const { CozoGraphStore } = await import(
              "../intelligence/local-graph.js"
            );

            // cozo-node's CozoDb constructor sits under `.default.CozoDb` once
            // esbuild wraps the CJS module, but is the named `.CozoDb` export
            // under raw ESM / vitest. The bare `.default` destructure handed
            // back the `{ CozoDb }` namespace object, so `new` threw and the
            // catch swallowed it (ruleHealth silently undefined). Same idiom
            // as standalone-load.ts / persistent-db.ts.
            const CozoDbConstructor = (
              cozoModule as { default?: { CozoDb: unknown }; CozoDb?: unknown }
            ).default
              ? (cozoModule as { default: { CozoDb: unknown } }).default.CozoDb
              : (cozoModule as { CozoDb: unknown }).CozoDb;
            const raw = readFileSync(snapshotPath);
            let buffer: Buffer;
            try {
              buffer = gunzipSync(raw);
            } catch {
              buffer = raw;
            }
            const db = new (CozoDbConstructor as any)();
            const graph = await CozoGraphStore.create(db);
            const envelope = unpack(buffer) as any;
            await graph.loadSnapshot(envelope);
            ruleHealth = await graph.getRuleHealthSummary();

            const entityCount = envelope?.entities?.length ?? 0;
            const edgeCount = envelope?.edges?.length ?? 0;
            let ageStr = "";
            if (typeof envelope?.generatedAt === "string") {
              const ageMs =
                Date.now() - new Date(envelope.generatedAt).getTime();
              const ageHours = Math.floor(ageMs / 3_600_000);
              if (ageHours < 1) ageStr = "indexed <1h ago";
              else if (ageHours < 24) ageStr = `indexed ${ageHours}h ago`;
              else ageStr = `indexed ${Math.floor(ageHours / 24)}d ago`;
            }
            graphInfo = `${entityCount.toLocaleString()} entities, ${edgeCount.toLocaleString()} edges${ageStr ? ` (${ageStr})` : ""}`;
          }
        } catch {
          /* ignore */
        }
      }

      // ── Live Session Stats + Latency ───────────────────────────

      let liveToolCalls: StatusData["liveToolCalls"] | undefined;
      let latency: StatusData["latency"] | undefined;
      const statsPath = join(unerrDir, "state", "session_stats.json");
      if (existsSync(statsPath) && proxyRunning) {
        try {
          const liveStats = JSON.parse(readFileSync(statsPath, "utf-8")) as {
            toolCallsLocal?: number;
            latency?: {
              local?: {
                p50: number;
                p95: number;
                p99: number;
                count: number;
              } | null;
            };
          };
          const localCalls = liveStats.toolCallsLocal ?? 0;
          if (localCalls > 0) {
            liveToolCalls = { local: localCalls };
          }
          const localL = liveStats.latency?.local;
          if (localL) {
            latency = {
              localP50: localL.p50,
              localP99: localL.p99,
              localBudgetExceeded: localL.p99 > 5,
            };
          }
        } catch {
          /* ignore */
        }
      }

      // ── Local Mode Status ────────────────────────────────────

      // Firewall status
      let firewallStatus = "Not active (proxy not running)";
      let firewallBlocked: number | undefined;
      if (proxyRunning) {
        firewallStatus = "Sealed (active)";
      }
      try {
        const firewallStatsPath = join(
          unerrDir,
          "state",
          "firewall_stats.json"
        );
        if (existsSync(firewallStatsPath)) {
          const fs = JSON.parse(readFileSync(firewallStatsPath, "utf-8")) as {
            blocked?: number;
          };
          firewallBlocked = fs.blocked ?? 0;
        }
      } catch {
        /* ignore */
      }

      // Last indexed
      let lastIndexed: string | undefined;
      const snapshotMetaPath = join(unerrDir, "state", "snapshot_meta.json");
      if (existsSync(snapshotMetaPath)) {
        try {
          const meta = JSON.parse(readFileSync(snapshotMetaPath, "utf-8")) as {
            indexedAt?: string;
            fileCount?: number;
            elapsedMs?: number;
          };
          if (meta.indexedAt) {
            const ageMs = Date.now() - new Date(meta.indexedAt).getTime();
            const ageHours = Math.floor(ageMs / 3_600_000);
            const ageStr =
              ageHours < 1
                ? "<1h ago"
                : ageHours < 24
                  ? `${ageHours}h ago`
                  : `${Math.floor(ageHours / 24)}d ago`;
            lastIndexed = ageStr;
            if (meta.fileCount) lastIndexed += ` (${meta.fileCount} files`;
            if (meta.elapsedMs)
              lastIndexed += ` in ${(meta.elapsedMs / 1000).toFixed(1)}s`;
            if (meta.fileCount) lastIndexed += ")";
          }
        } catch {
          /* ignore */
        }
      }

      // Corrections count
      let corrections: number | undefined;
      try {
        const corrPath = join(unerrDir, "state", "corrections_count.json");
        if (existsSync(corrPath)) {
          const cc = JSON.parse(readFileSync(corrPath, "utf-8")) as {
            count?: number;
          };
          corrections = cc.count;
        }
      } catch {
        /* ignore */
      }

      // Community, convention, rule counts from graph_version.json
      let communityCount: number | undefined;
      let conventionCount: number | undefined;
      let ruleCount: number | undefined;
      try {
        if (existsSync(graphVersionPath)) {
          const gv = JSON.parse(readFileSync(graphVersionPath, "utf-8")) as {
            community_count?: number;
            convention_count?: number;
            rule_count?: number;
          };
          communityCount = gv.community_count;
          conventionCount = gv.convention_count;
          ruleCount = gv.rule_count;
        }
      } catch {
        /* ignore */
      }

      // ── Hook Status (S6.6) ─────────────────────────────────────
      let hookStatus: string | undefined;
      try {
        const { isClaudeHookInstalled } = await import(
          "../config/hook-installer.js"
        );
        const { isConfigured } = await import("../config/mcp-config-writer.js");
        const { detectTools } = await import("../config/tool-detector.js");

        const tools = detectTools(cwd);
        const parts: string[] = [];

        if (isClaudeHookInstalled(cwd)) {
          parts.push("Claude hook: installed");
        }
        for (const tool of tools) {
          if (isConfigured(cwd, tool.ide)) {
            const name =
              tool.ide === "claude-code"
                ? "Claude Code"
                : tool.ide === "vscode"
                  ? "VS Code"
                  : tool.ide.charAt(0).toUpperCase() + tool.ide.slice(1);
            parts.push(`${name} MCP: configured`);
          }
        }
        if (parts.length > 0) {
          hookStatus = parts.join(", ");
        }
      } catch {
        /* ignore */
      }

      // Installed skills
      let skillCount: number | undefined;
      let skillNames: string[] | undefined;
      try {
        const { detectIde } = await import("../utils/detect.js");
        const { listInstalledSkills } = await import("../skills/resolver.js");
        const ide = await detectIde(cwd);
        const skills = listInstalledSkills(ide, cwd);
        skillCount = skills.length;
        skillNames = skills.map((s) => s.name);
      } catch {
        /* ignore */
      }

      // Ledger entry count
      let ledgerEntryCount: number | undefined;
      try {
        const ledgerPath = join(unerrDir, "ledger", "shadow.jsonl");
        if (existsSync(ledgerPath)) {
          const content = readFileSync(ledgerPath, "utf-8");
          ledgerEntryCount = content
            .split("\n")
            .filter((l) => l.trim().length > 0).length;
        }
      } catch {
        /* ignore */
      }

      // Log file path (latest log)
      let logPath: string | undefined;
      try {
        const logsDir = join(unerrDir, "logs");
        if (existsSync(logsDir)) {
          const { readdirSync, statSync } = await import("node:fs");
          const logs = readdirSync(logsDir)
            .filter((f) => f.startsWith("session-") && f.endsWith(".log"))
            .map((f) => ({
              name: f,
              mtime: statSync(join(logsDir, f)).mtimeMs,
            }))
            .sort((a, b) => b.mtime - a.mtime);
          if (logs[0]) {
            logPath = `.unerr/logs/${logs[0].name}`;
          }
        }
      } catch {
        /* ignore */
      }

      // Cumulative local stats
      let cumulative:
        | NonNullable<StatusData["localMode"]>["cumulative"]
        | undefined;
      try {
        const { loadCumulativeLocalStats } = await import(
          "../proxy/session-stats.js"
        );
        const cls = loadCumulativeLocalStats();
        if (cls.totalSessions > 0) {
          cumulative = {
            sessions: cls.totalSessions,
            toolCalls: cls.totalToolCalls,
            tokensSaved: cls.totalTokensSaved,
            violations: cls.totalViolationsCaught,
            corrections: cls.totalCorrectionsApplied,
          };
        }
      } catch {
        /* ignore */
      }

      // Last session summary (when proxy is NOT running)
      let lastSession:
        | NonNullable<StatusData["localMode"]>["lastSession"]
        | undefined;
      if (!proxyRunning) {
        try {
          const statsPath2 = join(unerrDir, "state", "session_stats.json");
          if (existsSync(statsPath2)) {
            const raw = JSON.parse(readFileSync(statsPath2, "utf-8")) as {
              sessionStartedAt?: string;
              updatedAt?: string;
              toolCallsLocal?: number;
              violationsCaught?: number;
            };
            const totalCalls = raw.toolCallsLocal ?? 0;
            if (totalCalls > 0) {
              const endTime = raw.updatedAt
                ? new Date(raw.updatedAt)
                : new Date();
              const startTime = raw.sessionStartedAt
                ? new Date(raw.sessionStartedAt)
                : endTime;
              const durationMin = Math.round(
                (endTime.getTime() - startTime.getTime()) / 60_000
              );
              const ageMs = Date.now() - endTime.getTime();
              const ageHours = Math.floor(ageMs / 3_600_000);
              const endedAtStr =
                ageHours < 1
                  ? "<1h ago"
                  : ageHours < 24
                    ? `${ageHours}h ago`
                    : `${Math.floor(ageHours / 24)}d ago`;
              lastSession = {
                endedAt: endedAtStr,
                durationMin: durationMin > 0 ? durationMin : 1,
                toolCalls: totalCalls,
                violationsCaught: raw.violationsCaught ?? 0,
                tokensSaved: totalCalls * 3200,
              };
            }
          }
        } catch {
          /* ignore */
        }
      }

      // Suggestions engine
      const suggestions = buildSuggestions({
        lastIndexed,
        conventionCount,
        skillCount,
        proxyRunning,
        healthGrade,
      });

      let shellCompression:
        | NonNullable<StatusData["localMode"]>["shellCompression"]
        | undefined;
      let preBashHookConfigured = false;
      try {
        const sp = join(cwd, ".claude", "settings.json");
        if (existsSync(sp)) {
          const raw = readFileSync(sp, "utf8");
          preBashHookConfigured =
            raw.includes("unerr hook pre-bash") ||
            raw.includes('"unerr hook pre-bash"');
        }
      } catch {
        /* ignore */
      }
      const { readShellCompressionAggregate } = await import(
        "../proxy/shell-stats.js"
      );
      const shellAgg = readShellCompressionAggregate(cwd);
      if (shellAgg || preBashHookConfigured) {
        shellCompression = {
          events: shellAgg?.totalEvents ?? 0,
          tokensSavedApprox: shellAgg?.tokensSavedApprox ?? 0,
          preBashHookConfigured,
        };
      }

      // Read recent compression events for detailed display
      const { readRecentCompressionLogs, readRecentFileReadLogs } =
        await import("../proxy/shell-compression-log.js");
      const recentCompressionEvents = readRecentCompressionLogs(cwd, 10);
      if (shellCompression && recentCompressionEvents.length > 0) {
        shellCompression.recentEvents = recentCompressionEvents;
      }

      // Read recent file-read optimization events
      const recentFileReadEvents = readRecentFileReadLogs(cwd, 10);

      const localModeData: StatusData["localMode"] = {
        mode: "local",
        firewallStatus,
        firewallBlocked,
        lastIndexed,
        corrections,
        communityCount,
        conventionCount,
        ruleCount,
        hookStatus,
        shellCompression,
        recentFileReadEvents:
          recentFileReadEvents.length > 0 ? recentFileReadEvents : undefined,
        skillCount,
        skillNames,
        logPath,
        ledgerEntryCount,
        suggestions,
        cumulative,
        lastSession,
      };

      // ── Render Ink Dashboard ───────────────────────────────────

      // Layer 10: Read token flow data for status display
      let tokenFlowData: StatusData["tokenFlow"] = undefined;
      try {
        const { readTokenFlowEvents, aggregateSession: aggSession } =
          await import("../tracking/token-flow.js");
        const events = readTokenFlowEvents(unerrDir);
        if (events.length > 0) {
          const latestSessionId = events[events.length - 1]?.session_id ?? "";
          const summary = aggSession(events, latestSessionId);
          if (summary.total_tokens_saved > 0) {
            tokenFlowData = {
              tokensSaved: summary.total_tokens_saved,
              tokensDelivered: summary.total_tokens_with,
              efficiencyPct: summary.efficiency_pct,
              byMechanism: Object.entries(summary.by_mechanism)
                .sort(([, a], [, b]) => b.tokens_saved - a.tokens_saved)
                .map(([mechanism, data]) => ({
                  mechanism,
                  tokensSaved: data.tokens_saved,
                  pctOfTotal: data.pct_of_total,
                })),
              topTurn: summary.top_turns[0]
                ? {
                    tool: summary.top_turns[0].tool,
                    tokensSaved: summary.top_turns[0].tokens_saved,
                  }
                : undefined,
            };
          }
        }
      } catch {
        /* non-critical */
      }

      const statusData: StatusData = {
        repoName: repoFullName || "(no repo)",
        repoId: repoId || undefined,
        branch: currentBranch,
        branchDetail,
        proxyStatus,
        proxyRunning,
        graphInfo,
        drift,
        healthGrade,
        healthScore,
        latency,
        liveToolCalls,
        ruleHealth,
        localMode: localModeData,
        tokenFlow: tokenFlowData,
      };

      // ── Cloud login state (optional — the CLI works fully logged out) ─
      // Read-only and local: no network call, never blocks. One line.
      try {
        const { loginStateLine } = await import("../cloud/login-state.js");
        process.stderr.write(`\n  Team:     ${loginStateLine()}\n`);

        // Plan line — read-only and offline (reads the signed cache only).
        const { effectiveTier } = await import("../cloud/entitlements.js");
        const tier = effectiveTier();
        process.stderr.write(`  Plan:     ${tier.plan}\n`);
        if (tier.source === "grace" && tier.reconnect_by) {
          const by = new Date(tier.reconnect_by).toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
          });
          process.stderr.write(
            `            running on a cached plan — reconnect by ${by}\n`
          );
        }
      } catch {
        /* ignore — cloud login is optional */
      }

      // ── Auto-update state (read-only, offline — reads persisted state) ─
      try {
        const { updateStatusLine } = await import(
          "../update/update-surface.js"
        );
        process.stderr.write(`  Update:   ${updateStatusLine()}\n`);
      } catch {
        /* ignore — update surface is additive */
      }

      try {
        const { StatusDashboard } = await import(
          "../components/StatusDashboard.js"
        );
        const { ThemeProvider } = await import("../components/Theme.js");
        const { renderToStderr } = await import("../components/render.js");

        const el = React.createElement(
          ThemeProvider,
          null,
          React.createElement(StatusDashboard, { data: statusData })
        );
        const inst = renderToStderr(el);
        inst.unmount();
      } catch {
        // Fallback to plain text
        const lm = statusData.localMode;
        let output = `
  Repo:     ${statusData.repoName}${statusData.repoId ? ` (${statusData.repoId})` : ""}
  Branch:   ${statusData.branchDetail}
  Mode:     Local (offline)
  Proxy:    ${statusData.proxyStatus}
  Graph:    ${statusData.graphInfo}
`;
        if (lm) {
          output += `  Firewall: ${lm.firewallStatus}${lm.firewallBlocked != null ? ` (${lm.firewallBlocked} blocked)` : ""}\n`;
          if (lm.lastIndexed) output += `  Indexed:  ${lm.lastIndexed}\n`;
          if (lm.communityCount)
            output += `  Communities: ${lm.communityCount} clusters\n`;
          if (lm.conventionCount)
            output += `  Conventions: ${lm.conventionCount} detected\n`;
          if (lm.ruleCount) output += `  Rules:    ${lm.ruleCount} active\n`;
          if (lm.hookStatus) output += `  Hooks:    ${lm.hookStatus}\n`;
          if (lm.skillCount != null) {
            output += `  Skills:   ${lm.skillCount} installed\n`;
            if (lm.skillNames) {
              for (const n of lm.skillNames) output += `    ${n}\n`;
            }
          }
          if (lm.ledgerEntryCount)
            output += `  Ledger:   ${lm.ledgerEntryCount} entries\n`;
          if (lm.logPath) output += `  Logs:     ${lm.logPath}\n`;
          if (!statusData.proxyRunning && lm.lastSession) {
            output += `\n  Last session (${lm.lastSession.endedAt}, ${lm.lastSession.durationMin} min):\n`;
            output += `    Tool calls: ${lm.lastSession.toolCalls} (all local)\n`;
            if (lm.lastSession.violationsCaught > 0)
              output += `    Violations: ${lm.lastSession.violationsCaught} caught\n`;
            if (lm.lastSession.tokensSaved > 0)
              output += `    Tokens:     ~${lm.lastSession.tokensSaved.toLocaleString()} saved\n`;
          }
          if (lm.cumulative && lm.cumulative.sessions > 0) {
            const c = lm.cumulative;
            output += "\n  This Week (Local Mode):\n";
            output += `    Sessions:     ${c.sessions}\n`;
            output += `    Tool calls:   ${c.toolCalls.toLocaleString()}\n`;
            output += `    Tokens saved: ~${c.tokensSaved.toLocaleString()}\n`;
            output += `    Violations:   ${c.violations} caught\n`;
          }
          if (lm.suggestions && lm.suggestions.length > 0) {
            output += "\n  Suggestions:\n";
            for (const s of lm.suggestions) output += `    · ${s}\n`;
          }
        }
        process.stderr.write(output);
      }
    });
}
