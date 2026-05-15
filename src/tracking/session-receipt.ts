/**
 * Session Receipt — the viral artifact.
 *
 * Layer 10 TF-C.4: Produces a formatted, screenshot-worthy receipt on session
 * disconnect showing token savings with full mechanism attribution.
 *
 * Output goes to stderr (stdout is MCP JSON-RPC only).
 */

import type { MechanismSummary, SessionTokenSummary } from "./token-flow.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const EMERALD = "\x1b[38;2;52;211;153m";
const CYAN = "\x1b[38;2;34;211;238m";
const VIOLET = "\x1b[38;2;139;92;246m";
const MUTED = "\x1b[38;2;161;161;170m";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function padRight(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

export interface SessionReceiptInput {
  summary: SessionTokenSummary;
  durationMs: number;
  toolCalls: number;
  weeklyTokensSaved?: number;
  weeklySessions?: number;
}

/**
 * Format a session receipt as a bordered box for stderr display.
 * Returns the complete ANSI-formatted string.
 */
export function formatSessionReceipt(input: SessionReceiptInput): string {
  const { summary, durationMs, toolCalls } = input;
  const W = 47;
  const durationMin = Math.max(1, Math.round(durationMs / 60_000));

  const lines: string[] = [];
  const border = (s: string) =>
    `  ${DIM}│${RESET} ${s}${" ".repeat(Math.max(0, W - stripAnsi(s).length - 1))}${DIM}│${RESET}`;
  const empty = () => border("");

  lines.push(`  ${DIM}┌${"─".repeat(W)}┐${RESET}`);
  lines.push(border(`${VIOLET}${BOLD}unerr${RESET} session receipt`));
  lines.push(empty());
  lines.push(border(`Duration:     ${CYAN}${durationMin} minutes${RESET}`));
  lines.push(border(`Tool calls:   ${CYAN}${toolCalls}${RESET}`));
  lines.push(
    border(
      `Tokens saved:     ${EMERALD}${formatTokens(summary.total_tokens_saved).padEnd(10)}${RESET}`
    )
  );
  lines.push(
    border(
      `Tokens delivered: ${CYAN}${formatTokens(summary.total_tokens_with).padEnd(10)}${RESET}`
    )
  );
  lines.push(
    border(`Efficiency:       ${EMERALD}${summary.efficiency_pct}%${RESET}`)
  );
  lines.push(empty());

  // Mechanism breakdown — top 4
  const mechs = Object.entries(summary.by_mechanism)
    .sort(([, a], [, b]) => b.tokens_saved - a.tokens_saved)
    .slice(0, 4);

  if (mechs.length > 0) {
    lines.push(border(`${MUTED}Top savings:${RESET}`));
    for (const [mech, data] of mechs) {
      const pctStr = `(${Math.round(data.pct_of_total)}%)`;
      lines.push(
        border(
          `  ${padRight(mech, 20)} ${EMERALD}${formatTokens(data.tokens_saved).padStart(6)}${RESET}  ${MUTED}${pctStr}${RESET}`
        )
      );
    }
    lines.push(empty());
  }

  // Most efficient turn
  if (summary.top_turns.length > 0) {
    const top = summary.top_turns[0]!;
    lines.push(
      border(
        `${MUTED}Most efficient:${RESET} ${BOLD}${top.tool}${RESET} ${MUTED}→${RESET} ${EMERALD}${formatTokens(top.tokens_saved)}${RESET} saved`
      )
    );
  }

  // Weekly context
  if (input.weeklyTokensSaved && input.weeklyTokensSaved > 0) {
    const weekLabel = `This week: ${formatTokens(input.weeklyTokensSaved)} saved across ${input.weeklySessions ?? 0} sessions`;
    lines.push(border(`${MUTED}${weekLabel}${RESET}`));
  }

  lines.push(`  ${DIM}└${"─".repeat(W)}┘${RESET}`);

  return `\n${lines.join("\n")}\n`;
}

/**
 * Print the session receipt to stderr.
 * Safe to call in shutdown — never throws.
 */
export function printSessionReceipt(input: SessionReceiptInput): void {
  try {
    const receipt = formatSessionReceipt(input);
    process.stderr.write(receipt);
  } catch {
    /* best effort — never block shutdown */
  }
}

function stripAnsi(s: string): string {
  const ESC = "\x1b";
  const CSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z~]`, "g");
  return s.replace(CSI, "");
}
