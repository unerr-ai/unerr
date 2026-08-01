/**
 * StatusDashboard — Ink-rendered `unerr status` display.
 *
 * Shows repo info, branch context, proxy state, graph stats,
 * drift summary, health grade, and live latency.
 * Every display includes a deep link (§0.7 Constraint #8).
 */

import { Box, Text } from "ink";
import type React from "react";
import { type DriftCounts, DriftSummary } from "./DriftSummary.js";
import { GradeBadge } from "./GradeBadge.js";
import { KeyValue } from "./KeyValue.js";
import { ProgressBar } from "./ProgressBar.js";
import { Section } from "./Section.js";
import { useTheme } from "./Theme.js";

export interface StatusData {
  repoName: string;
  repoId?: string;
  branch: string;
  branchDetail?: string;
  proxyStatus: string;
  proxyRunning: boolean;
  graphInfo: string;
  drift?: DriftCounts;
  latency?: {
    localP50?: number;
    localP99?: number;
    localBudgetExceeded?: boolean;
  };
  liveToolCalls?: { local: number };
  indexingStatus?: string;
  deepLink?: string;
  ruleHealth?: {
    total: number;
    healthy: number;
    aging: number;
    decayed: number;
    dormant: number;
    warnings: Array<{
      key: string;
      name: string;
      decayScore: number;
      overrideRate: number;
    }>;
  };
  /** L12.2: Local Mode status enhancements */
  localMode?: {
    mode: "local";
    firewallStatus: string;
    firewallBlocked?: number;
    lastIndexed?: string;
    corrections?: number;
    communityCount?: number;
    conventionCount?: number;
    ruleCount?: number;
    hookStatus?: string;
    /** Layer 6 FE-F — shell hook + compression counters */
    shellCompression?: {
      events: number;
      tokensSavedApprox: number;
      preBashHookConfigured: boolean;
      recentEvents?: Array<{
        ts: string;
        command: string;
        category: string;
        savedPct: number;
        omniFallback: boolean;
      }>;
    };
    /** File-read optimization events from file-reads.jsonl */
    recentFileReadEvents?: Array<{
      ts: string;
      file: string;
      mode: string;
      savedPct: number;
    }>;
    skillCount?: number;
    skillNames?: string[];
    logPath?: string;
    ledgerEntryCount?: number;
    suggestions?: string[];
    cumulative?: {
      sessions: number;
      toolCalls: number;
      tokensSaved: number;
      violations: number;
      corrections: number;
    };
    /** When proxy is NOT running: last session snapshot */
    lastSession?: {
      endedAt: string;
      durationMin: number;
      toolCalls: number;
      violationsCaught: number;
      tokensSaved: number;
    };
  };
  /** Layer 10: Token flow session summary for status display. */
  tokenFlow?: {
    tokensSaved: number;
    tokensDelivered: number;
    efficiencyPct: number;
    byMechanism: Array<{
      mechanism: string;
      tokensSaved: number;
      pctOfTotal: number;
    }>;
    topTurn?: { tool: string; tokensSaved: number };
  };
}

export function StatusDashboard({
  data,
}: { data: StatusData }): React.ReactElement {
  const t = useTheme();

  const totalCalls = data.liveToolCalls ? data.liveToolCalls.local : 0;

  return (
    <Box flexDirection="column">
      <Section title="unerr status" />

      {/* Repo + Branch */}
      <KeyValue
        label="Repo"
        value={`${data.repoName}${data.repoId ? ` (${data.repoId})` : ""}`}
      />
      <KeyValue label="Branch" value={data.branchDetail ?? data.branch} />

      {/* Proxy */}
      <KeyValue
        label="Proxy"
        value={data.proxyStatus}
        valueColor={data.proxyRunning ? t.success : t.dim}
      />

      {/* Mode indicator (L4.4) */}
      {data.localMode && (
        <KeyValue
          label="Mode"
          value={
            data.localMode.mode === "local"
              ? "Local (offline)"
              : "Standard (connected)"
          }
          valueColor={data.localMode.mode === "local" ? t.success : undefined}
        />
      )}

      {/* Graph */}
      <KeyValue label="Graph" value={data.graphInfo} />

      {/* Rule Health */}
      {data.ruleHealth && data.ruleHealth.total > 0 && (
        <Box marginLeft={4} flexDirection="column">
          <Box>
            <Text color={t.dim}>Rules: </Text>
            <Text>{data.ruleHealth.total} active</Text>
            <Text color={t.dim}> </Text>
            <Text color={t.success}>● {data.ruleHealth.healthy} healthy</Text>
            <Text color={t.dim}> </Text>
            <Text color={t.warning}>● {data.ruleHealth.aging} aging</Text>
            <Text color={t.dim}> </Text>
            <Text color="red">● {data.ruleHealth.decayed} decayed</Text>
            <Text color={t.dim}> ○ {data.ruleHealth.dormant} dormant</Text>
          </Box>
          {data.ruleHealth.warnings.map((w) => (
            <Box key={w.key} marginLeft={2}>
              <Text color={t.warning}>
                ⚠ "{w.key}" — override rate {w.overrideRate}%, decay score{" "}
                {w.decayScore.toFixed(2)}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Drift */}
      {data.drift && (
        <Box marginLeft={4} marginTop={1}>
          <DriftSummary drift={data.drift} />
        </Box>
      )}

      {/* Live Session Stats (when proxy is running) */}
      {data.liveToolCalls && totalCalls > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <KeyValue label="Session" value={`${totalCalls} calls (all local)`} />
          <Box marginLeft={4}>
            <Text color={t.dim}>Local rate </Text>
            <ProgressBar value={1} width={20} color={t.success} showLabel />
          </Box>
        </Box>
      )}

      {/* Latency */}
      {data.latency && (
        <Box marginLeft={4}>
          <Text color={t.dim}>
            Latency
            {data.latency.localP50 != null
              ? ` p50=${data.latency.localP50.toFixed(1)}ms p99=${(data.latency.localP99 ?? 0).toFixed(1)}ms`
              : ""}
            {data.latency.localBudgetExceeded ? " ⚠ >5ms" : ""}
          </Text>
        </Box>
      )}

      {/* Indexing */}
      {data.indexingStatus && (
        <KeyValue label="Indexing" value={data.indexingStatus} />
      )}

      {/* Deep Link */}
      {data.deepLink && (
        <Box marginLeft={4} marginTop={1}>
          <Text color={t.dim}>Dashboard → {data.deepLink}</Text>
        </Box>
      )}

      {/* Local Mode Details (L12.2) */}
      {data.localMode?.mode === "local" && (
        <Box flexDirection="column" marginTop={1}>
          <KeyValue
            label="Firewall"
            value={
              data.localMode.firewallBlocked != null
                ? `${data.localMode.firewallStatus} (${data.localMode.firewallBlocked} blocked)`
                : data.localMode.firewallStatus
            }
            valueColor={t.success}
          />
          {data.localMode.lastIndexed && (
            <KeyValue label="Indexed" value={data.localMode.lastIndexed} />
          )}
          {data.localMode.communityCount != null &&
            data.localMode.communityCount > 0 && (
              <KeyValue
                label="Communities"
                value={`${data.localMode.communityCount} clusters`}
              />
            )}
          {data.localMode.conventionCount != null &&
            data.localMode.conventionCount > 0 && (
              <KeyValue
                label="Conventions"
                value={`${data.localMode.conventionCount} detected`}
              />
            )}
          {data.localMode.ruleCount != null && data.localMode.ruleCount > 0 && (
            <KeyValue
              label="Rules"
              value={`${data.localMode.ruleCount} active`}
            />
          )}
          {data.localMode.corrections != null &&
            data.localMode.corrections > 0 && (
              <KeyValue
                label="Corrections"
                value={`${data.localMode.corrections} learned patterns`}
              />
            )}
          {data.localMode.hookStatus && (
            <KeyValue label="Hooks / MCP" value={data.localMode.hookStatus} />
          )}
          {data.localMode.shellCompression && (
            <Box flexDirection="column">
              <KeyValue
                label="Shell compress"
                value={`${data.localMode.shellCompression.events} events · ~${data.localMode.shellCompression.tokensSavedApprox.toLocaleString()} tok saved · PreToolUse bash ${data.localMode.shellCompression.preBashHookConfigured ? "configured" : "not detected"}`}
              />
              {data.localMode.shellCompression.recentEvents &&
                data.localMode.shellCompression.recentEvents.length > 0 && (
                  <Box marginLeft={4} flexDirection="column">
                    <Text color={t.dim}>Recent compressions:</Text>
                    {data.localMode.shellCompression.recentEvents
                      .slice(0, 5)
                      .map((ev, i) => {
                        const cmdShort =
                          ev.command.length > 30
                            ? `${ev.command.slice(0, 27)}...`
                            : ev.command;
                        return (
                          <Text key={`${ev.ts}-${i}`} color={t.dim}>
                            {" "}
                            {cmdShort} → {ev.category} ({ev.savedPct}% saved
                            {ev.omniFallback ? ", omni" : ""})
                          </Text>
                        );
                      })}
                  </Box>
                )}
            </Box>
          )}
          {data.localMode.recentFileReadEvents &&
            data.localMode.recentFileReadEvents.length > 0 && (
              <Box flexDirection="column">
                <KeyValue
                  label="File reads"
                  value={`${data.localMode.recentFileReadEvents.length} recent optimizations`}
                />
                <Box marginLeft={4} flexDirection="column">
                  <Text color={t.dim}>Recent file reads:</Text>
                  {data.localMode.recentFileReadEvents
                    .slice(0, 5)
                    .map((ev, i) => {
                      const fileShort =
                        ev.file.length > 40
                          ? `...${ev.file.slice(-37)}`
                          : ev.file;
                      return (
                        <Text key={`${ev.ts}-${i}`} color={t.dim}>
                          {" "}
                          {fileShort} → {ev.mode} ({ev.savedPct}% saved)
                        </Text>
                      );
                    })}
                </Box>
              </Box>
            )}
          {data.localMode.skillCount != null && (
            <Box flexDirection="column">
              <KeyValue
                label="Skills"
                value={`${data.localMode.skillCount} installed`}
              />
              {data.localMode.skillNames &&
                data.localMode.skillNames.length > 0 && (
                  <Box marginLeft={4} flexDirection="column">
                    {data.localMode.skillNames.map((name) => (
                      <Text key={name} color={t.dim}>
                        {" "}
                        {name}
                      </Text>
                    ))}
                  </Box>
                )}
            </Box>
          )}
          {data.localMode.ledgerEntryCount != null &&
            data.localMode.ledgerEntryCount > 0 && (
              <KeyValue
                label="Ledger"
                value={`${data.localMode.ledgerEntryCount} entries`}
              />
            )}
          {data.localMode.logPath && (
            <KeyValue label="Logs" value={data.localMode.logPath} />
          )}
          {/* Last session when proxy is not running */}
          {!data.proxyRunning && data.localMode.lastSession && (
            <Box flexDirection="column" marginTop={1}>
              <Section
                title={`Last session (${data.localMode.lastSession.endedAt}, ${data.localMode.lastSession.durationMin} min)`}
              />
              <KeyValue
                label="  Tool calls"
                value={`${data.localMode.lastSession.toolCalls} (all local)`}
              />
              {data.localMode.lastSession.violationsCaught > 0 && (
                <KeyValue
                  label="  Violations"
                  value={`${data.localMode.lastSession.violationsCaught} caught`}
                />
              )}
              {data.localMode.lastSession.tokensSaved > 0 && (
                <KeyValue
                  label="  Tokens saved"
                  value={`~${data.localMode.lastSession.tokensSaved.toLocaleString()}`}
                />
              )}
            </Box>
          )}
          {data.localMode.cumulative &&
            data.localMode.cumulative.sessions > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Section title="This Week (Local Mode)" />
                <KeyValue
                  label="  Sessions"
                  value={String(data.localMode.cumulative.sessions)}
                />
                <KeyValue
                  label="  Tool calls"
                  value={data.localMode.cumulative.toolCalls.toLocaleString()}
                />
                <KeyValue
                  label="  Tokens saved"
                  value={`~${data.localMode.cumulative.tokensSaved.toLocaleString()}`}
                />
                <KeyValue
                  label="  Violations"
                  value={`${data.localMode.cumulative.violations} caught`}
                />
                {data.localMode.cumulative.corrections > 0 && (
                  <KeyValue
                    label="  Corrections"
                    value={`${data.localMode.cumulative.corrections} injected`}
                  />
                )}
              </Box>
            )}
          {/* Suggestions (L12.5) */}
          {data.localMode.suggestions &&
            data.localMode.suggestions.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Section title="Suggestions" />
                {data.localMode.suggestions.map((s) => (
                  <Text key={s} color={t.dim}>
                    {" "}
                    · {s}
                  </Text>
                ))}
              </Box>
            )}
        </Box>
      )}

      {/* Layer 10: Token Flow */}
      {data.tokenFlow && data.tokenFlow.tokensSaved > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Section title="Token Flow (this session)" />
          <KeyValue
            label="Tokens saved"
            value={`${data.tokenFlow.tokensSaved.toLocaleString()}`}
          />
          <KeyValue
            label="Tokens delivered"
            value={`${data.tokenFlow.tokensDelivered.toLocaleString()}`}
          />
          <KeyValue
            label="Efficiency"
            value={`${data.tokenFlow.efficiencyPct}%`}
          />
          {data.tokenFlow.byMechanism.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text color={t.dim}> By mechanism:</Text>
              {data.tokenFlow.byMechanism.map((m) => {
                const barLen = Math.max(1, Math.round(m.pctOfTotal / 5));
                const bar = "█".repeat(barLen) + "░".repeat(20 - barLen);
                return (
                  <Text key={m.mechanism} color={t.dim}>
                    {"    "}
                    <Text>{m.mechanism.padEnd(22)}</Text>
                    <Text color={t.success}>
                      {m.tokensSaved.toLocaleString().padStart(8)}
                    </Text>
                    {"  "}
                    <Text color={t.dim}>{`${m.pctOfTotal}%`.padStart(5)}</Text>
                    {"  "}
                    <Text color={t.success}>{bar}</Text>
                  </Text>
                );
              })}
            </Box>
          )}
          {data.tokenFlow.topTurn && (
            <Box marginTop={1}>
              <Text color={t.dim}>
                {"  Most efficient: "}
                <Text bold>{data.tokenFlow.topTurn.tool}</Text>
                {" → "}
                <Text color={t.success}>
                  {data.tokenFlow.topTurn.tokensSaved.toLocaleString()}
                </Text>
                {" saved"}
              </Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
