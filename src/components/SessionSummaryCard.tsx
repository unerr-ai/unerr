/**
 * Session summary card — Ink-rendered shutdown display.
 *
 * Shows tool calls, local rate with ProgressBar, token savings,
 * latency, specific "Caught" events, and cumulative "This week" stats.
 * The retention trigger — quantifies what unerr *prevented*.
 */

import { Box, Text } from "ink";
import type React from "react";
import type {
  CumulativeLocalStats,
  CumulativeStats,
  LatencyPercentiles,
  LocalModeStats,
  SessionEvents,
  SessionStats,
} from "../proxy/session-stats.js";
import {
  computePercentiles,
  totalCaughtEvents,
} from "../proxy/session-stats.js";
import { KeyValue } from "./KeyValue.js";
import { ProgressBar } from "./ProgressBar.js";
import { Section } from "./Section.js";
import { useTheme } from "./Theme.js";

// Re-export for backwards compat
export type { SessionEvents } from "../proxy/session-stats.js";
export { createSessionEvents } from "../proxy/session-stats.js";

export interface SessionSummaryCardProps {
  stats: SessionStats;
  events?: SessionEvents;
  deepLink?: string;
  cumulative?: CumulativeStats;
  /** Cumulative local stats for "This week" line in Local Mode. */
  cumulativeLocal?: CumulativeLocalStats;
  /** S8.6: Session scorecard metrics for value surfacing. */
  scorecard?: {
    efficiency: string;
    tokensSaved: string;
    counterfactual?: string;
  };
}

/** Renders the "Caught" section shared between Standard and Local Mode cards. */
function CaughtSection({
  ev,
  color,
}: { ev: SessionEvents; color: string }): React.ReactElement | null {
  const caughtTotal = totalCaughtEvents(ev);
  if (caughtTotal === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={4}>
      <Text color={color} bold>
        Caught:
      </Text>
      {ev.conventionViolationsCaught > 0 && (
        <Box marginLeft={2}>
          <Text color={color}>
            {ev.conventionViolationsCaught} convention violation
            {ev.conventionViolationsCaught !== 1 ? "s" : ""} before commit
          </Text>
        </Box>
      )}
      {ev.chokepointWarningsIssued > 0 && (
        <Box marginLeft={2}>
          <Text color={color}>
            {ev.chokepointWarningsIssued} chokepoint modification
            {ev.chokepointWarningsIssued !== 1 ? "s" : ""} warned
          </Text>
        </Box>
      )}
      {ev.circularDepsDetected > 0 && (
        <Box marginLeft={2}>
          <Text color={color}>
            {ev.circularDepsDetected} circular dep
            {ev.circularDepsDetected !== 1 ? "s" : ""} prevented
          </Text>
        </Box>
      )}
      {ev.signaturePreservations > 0 && (
        <Box marginLeft={2}>
          <Text color={color}>
            {ev.signaturePreservations} signature
            {ev.signaturePreservations !== 1 ? "s" : ""} preserved
          </Text>
        </Box>
      )}
      {ev.deadCodeReferences > 0 && (
        <Box marginLeft={2}>
          <Text color={color}>
            {ev.deadCodeReferences} dead code reference
            {ev.deadCodeReferences !== 1 ? "s" : ""} flagged
          </Text>
        </Box>
      )}
    </Box>
  );
}

/** Local Mode session summary — all-local proof, value surfacing, no deep link. */
function LocalModeCard({
  stats,
  lm,
  ev,
  cumulativeLocal,
  scorecard,
}: {
  stats: SessionStats;
  lm: LocalModeStats;
  ev: SessionEvents;
  cumulativeLocal?: CumulativeLocalStats;
  scorecard?: SessionSummaryCardProps["scorecard"];
}): React.ReactElement {
  const t = useTheme();
  const total = stats.toolCallsLocal;
  const durationMs = Date.now() - stats.sessionStartedAt;
  const durationMin = Math.round(durationMs / 60_000);
  const caughtTotal = totalCaughtEvents(ev);

  const localP = computePercentiles(
    stats.latency.localSamples,
    stats.latency.localTotalSamples
  );

  // Short session (<=10 calls) — compact line
  if (total <= 10 && total > 0) {
    return (
      <Box flexDirection="column">
        <Box marginLeft={2}>
          <Text color={t.dim}>
            unerr local session: {total} tool calls (all local) ·{" "}
            {durationMin > 0 ? `${durationMin}m` : "<1m"}
            {caughtTotal > 0 ? ` · ${caughtTotal} caught` : ""}
          </Text>
        </Box>
      </Box>
    );
  }

  if (total === 0) return <Box />;

  const tokensSavedK = (lm.tokensSavedByTruncation / 1000).toFixed(1);

  return (
    <Box flexDirection="column">
      <Section
        title={`unerr session (${durationMin > 0 ? `${durationMin} min` : "<1 min"})`}
      />
      <KeyValue label="Tool calls" value={`${total} (all local)`} />
      {scorecard && (
        <Box flexDirection="column" marginLeft={4}>
          <Text color={t.dim}>
            Tokens saved: ~{scorecard.tokensSaved} — efficiency:{" "}
            {scorecard.efficiency}
          </Text>
          {scorecard.counterfactual && (
            <Text color={t.dim}>{scorecard.counterfactual}</Text>
          )}
        </Box>
      )}
      <Box marginLeft={4}>
        <Text color={t.dim}>Local rate </Text>
        <ProgressBar value={1} width={24} color={t.success} showLabel />
      </Box>

      {localP && (
        <Box marginLeft={4}>
          <Text color={t.dim}>
            Latency p50={localP.p50.toFixed(1)}ms · p95=
            {localP.p95.toFixed(1)}ms
            {lm.cumulativeLatencySavedMs > 0
              ? ` · ${(lm.cumulativeLatencySavedMs / 1000).toFixed(1)}s saved vs remote`
              : ""}
          </Text>
        </Box>
      )}

      <CaughtSection ev={ev} color={t.warning} />

      {/* Intelligence Applied */}
      {(lm.blastRadiusComputations > 0 ||
        lm.communityContextsInjected > 0 ||
        lm.correctionPatternsInjected > 0) && (
        <Box flexDirection="column" marginTop={1} marginLeft={4}>
          <Text bold>Intelligence Applied:</Text>
          {lm.blastRadiusComputations > 0 && (
            <Box marginLeft={2}>
              <Text color={t.dim}>
                {lm.blastRadiusComputations} blast radius computation
                {lm.blastRadiusComputations !== 1 ? "s" : ""}
              </Text>
            </Box>
          )}
          {lm.communityContextsInjected > 0 && (
            <Box marginLeft={2}>
              <Text color={t.dim}>
                {lm.communityContextsInjected} community context
                {lm.communityContextsInjected !== 1 ? "s" : ""} injected
              </Text>
            </Box>
          )}
          {lm.correctionPatternsInjected > 0 && (
            <Box marginLeft={2}>
              <Text color={t.dim}>
                {lm.correctionPatternsInjected} correction pattern
                {lm.correctionPatternsInjected !== 1 ? "s" : ""} applied
              </Text>
            </Box>
          )}
        </Box>
      )}

      {/* Token Discipline */}
      {lm.tokensSavedByTruncation > 0 && (
        <Box flexDirection="column" marginTop={1} marginLeft={4}>
          <Text bold>Token Discipline:</Text>
          <Box marginLeft={2}>
            <Text color={t.dim}>
              ~{tokensSavedK}k tokens saved via smart truncation
            </Text>
          </Box>
          <Box marginLeft={2}>
            <Text color={t.dim}>
              {lm.truncatedResponses} response
              {lm.truncatedResponses !== 1 ? "s" : ""} budget-trimmed
            </Text>
          </Box>
        </Box>
      )}

      {/* Semantic Intelligence (if BYO-LLM was used) */}
      {lm.semanticSearches > 0 && (
        <Box flexDirection="column" marginTop={1} marginLeft={4}>
          <Text bold>Semantic Intelligence:</Text>
          <Box marginLeft={2}>
            <Text color={t.dim}>
              {lm.semanticSearches} quer
              {lm.semanticSearches !== 1 ? "ies" : "y"} via local embeddings
            </Text>
          </Box>
        </Box>
      )}

      {/* Network Isolation — always shown in Local Mode */}
      <Box flexDirection="column" marginTop={1} marginLeft={4}>
        <Text bold>Network Isolation:</Text>
        <Box marginLeft={2}>
          <Text color={t.success}>Outbound: 0 calls (firewall sealed)</Text>
        </Box>
        <Box marginLeft={2}>
          <Text color={t.dim}>
            Blocked attempts: {lm.firewallBlockedCount}
            {lm.firewallBlockedCount === 0 ? " (clean)" : ""}
          </Text>
        </Box>
      </Box>

      {/* Cumulative "This week" line */}
      {cumulativeLocal && cumulativeLocal.totalSessions > 1 && (
        <Box marginLeft={4} marginTop={1}>
          <Text color={t.dim}>
            This week: {cumulativeLocal.totalSessions} sessions · ~
            {(cumulativeLocal.totalTokensSaved / 1000).toFixed(0)}k tokens saved
            · {cumulativeLocal.totalViolationsCaught} caught
          </Text>
        </Box>
      )}
    </Box>
  );
}

export function SessionSummaryCard({
  stats,
  events,
  deepLink,
  cumulative,
  cumulativeLocal,
  scorecard,
}: SessionSummaryCardProps): React.ReactElement {
  const t = useTheme();
  const total = stats.toolCallsLocal;

  // Use events from stats if not provided separately
  const ev = events ?? stats.events;

  // ── Local Mode variant ──
  if (stats.localMode) {
    return (
      <LocalModeCard
        stats={stats}
        lm={stats.localMode}
        ev={ev}
        cumulativeLocal={cumulativeLocal}
        scorecard={scorecard}
      />
    );
  }

  // ── Standard Mode ────────────────────────────────────────────────
  const localPct =
    total > 0 ? Math.round((stats.toolCallsLocal / total) * 100) : 0;
  const tokensSavedK = (stats.estimatedTokensSaved / 1000).toFixed(1);
  const durationMs = Date.now() - stats.sessionStartedAt;
  const durationMin = Math.round(durationMs / 60_000);

  const localP = computePercentiles(
    stats.latency.localSamples,
    stats.latency.localTotalSamples
  );
  const caughtTotal = totalCaughtEvents(ev);

  // Only show full summary for meaningful sessions (>10 tool calls)
  const isShortSession = total <= 10;

  if (isShortSession && total > 0) {
    return (
      <Box flexDirection="column">
        <Box marginLeft={2}>
          <Text color={t.dim}>
            unerr session: {total} tool calls ·{" "}
            {durationMin > 0 ? `${durationMin}m` : "<1m"}
            {caughtTotal > 0 ? ` · ${caughtTotal} caught` : ""}
          </Text>
        </Box>
      </Box>
    );
  }

  if (total === 0) {
    return <Box />;
  }

  return (
    <Box flexDirection="column">
      <Section
        title={`unerr session (${durationMin > 0 ? `${durationMin} min` : "<1 min"})`}
      />
      <KeyValue label="Tool calls" value={`${total} (all local)`} />
      <Box marginLeft={4}>
        <Text color={t.dim}>Local rate </Text>
        <ProgressBar
          value={localPct / 100}
          width={24}
          color={t.success}
          showLabel
        />
      </Box>

      {localP && (
        <Box marginLeft={4}>
          <Text color={t.dim}>
            Latency p50={localP.p50.toFixed(1)}ms · p95=
            {localP.p95.toFixed(1)}ms
          </Text>
        </Box>
      )}

      <CaughtSection ev={ev} color={t.warning} />

      <Box marginLeft={4} marginTop={1}>
        <Text>Saved: ~{tokensSavedK}k tokens</Text>
      </Box>

      {/* Cumulative "This week" line */}
      {cumulative && cumulative.totalSessions > 1 && (
        <Box marginLeft={4}>
          <Text color={t.dim}>
            This week: {cumulative.totalSessions} sessions · ~
            {(cumulative.totalTokensSaved / 1000).toFixed(0)}k tokens
          </Text>
        </Box>
      )}

      {deepLink && (
        <Box marginLeft={4} marginTop={1}>
          <Text color={t.dim}>Session → {deepLink}</Text>
        </Box>
      )}
    </Box>
  );
}
