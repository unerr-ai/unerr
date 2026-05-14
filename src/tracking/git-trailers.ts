/**
 * Sprint 10.5: Git Trailer Injection — prepare-commit-msg hook + UDS endpoint.
 *
 * Injects `Unerr-Ledger-Id`, `Unerr-Session`, `Unerr-Timeline-Branch` trailers
 * into commit messages via prepare-commit-msg hook.
 *
 * Two integration modes:
 *   1. Hook mode: Shell script calls UDS `/commit-context` endpoint
 *   2. Direct mode: CommitWatcher calls `getTrailers()` after commit detection
 *
 * Design authority: Phase 5.5 §1.4.1 (Git Trailer Injection)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ShadowLedger } from "./shadow-ledger.js";

/** stderr logger */
const _log = {
  info: (msg: string) => process.stderr.write(`[unerr:trailers] ${msg}\n`),
};

export interface CommitTrailers {
  /** Most recent ledger entry ID */
  ledgerId: string;
  /** Current session ID */
  sessionId: string;
  /** Timeline branch counter */
  timelineBranch: number;
  /** Current git branch */
  branch: string;
}

/**
 * Get trailers for the current commit context.
 * Called by the UDS `/commit-context` endpoint or directly by CommitWatcher.
 */
export function getCommitTrailers(
  ledger: ShadowLedger,
  timelineBranch: number,
  branch: string,
): CommitTrailers | null {
  const recent = ledger.getRecentEntries(1);
  if (recent.length === 0) return null;

  // biome-ignore lint/style/noNonNullAssertion: length > 0 checked above
  const latest = recent[0]!;

  return {
    ledgerId: latest.id,
    sessionId: ledger.getSessionId(),
    timelineBranch,
    branch,
  };
}

/**
 * Format trailers for git commit message injection.
 */
export function formatTrailers(trailers: CommitTrailers): string {
  return [
    `Unerr-Ledger-Id: ${trailers.ledgerId}`,
    `Unerr-Session: ${trailers.sessionId}`,
    `Unerr-Timeline-Branch: ${trailers.timelineBranch}`,
  ].join("\n");
}

/**
 * Install the prepare-commit-msg hook that calls the UDS endpoint.
 * Only installs if:
 *   1. The hook doesn't already exist or doesn't contain our marker
 *   2. The .git/hooks directory exists
 */
export function installPrepareCommitMsgHook(projectRoot: string): boolean {
  const hooksDir = join(projectRoot, ".git", "hooks");
  if (!existsSync(hooksDir)) {
    // Not a git repo or hooks dir missing
    return false;
  }

  const hookPath = join(hooksDir, "prepare-commit-msg");
  const marker = "# unerr-trailer-injection";

  // Check if hook already exists with our marker
  if (existsSync(hookPath)) {
    try {
      const existing = readFileSync(hookPath, "utf-8");
      if (existing.includes(marker)) {
        return true; // Already installed
      }
      // Hook exists but isn't ours — append our section
      const appendSection = `\n\n${marker}\n${generateHookScript()}`;
      writeFileSync(hookPath, existing + appendSection, { mode: 0o755 });
      _log.info(
        "Appended trailer injection to existing prepare-commit-msg hook",
      );
      return true;
    } catch {
      return false;
    }
  }

  // Create new hook
  const hookContent = `#!/bin/sh\n${marker}\n${generateHookScript()}`;
  try {
    writeFileSync(hookPath, hookContent, { mode: 0o755 });
    _log.info("Installed prepare-commit-msg hook for trailer injection");
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the prepare-commit-msg hook (or our section from it).
 */
export function uninstallPrepareCommitMsgHook(projectRoot: string): boolean {
  const hookPath = join(projectRoot, ".git", "hooks", "prepare-commit-msg");
  if (!existsSync(hookPath)) return true;

  try {
    const content = readFileSync(hookPath, "utf-8");
    const marker = "# unerr-trailer-injection";

    if (!content.includes(marker)) return true; // Not our hook

    // If the entire hook is ours, remove the file
    const lines = content.split("\n");
    const nonUnerrLines = lines.filter(
      (line) =>
        !line.includes(marker) &&
        !line.includes("unerr") &&
        !line.includes("Unerr-"),
    );

    // If only shebang remains, remove the file
    if (nonUnerrLines.length <= 1 && nonUnerrLines[0]?.startsWith("#!/")) {
      const { unlinkSync } = require("node:fs") as typeof import("node:fs");
      unlinkSync(hookPath);
    } else {
      // Remove our section
      const markerIdx = content.indexOf(marker);
      if (markerIdx > 0) {
        writeFileSync(hookPath, `${content.slice(0, markerIdx).trimEnd()}\n`, {
          mode: 0o755,
        });
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate the hook script body that queries the UDS endpoint.
 */
function generateHookScript(): string {
  return `# Inject unerr ledger trailers into commit message
COMMIT_MSG_FILE="$1"
SOCK=".unerr/state/proxy.sock"

if [ -S "$SOCK" ]; then
  TRAILERS=$(curl -s --unix-socket "$SOCK" http://localhost/commit-context 2>/dev/null)
  if [ -n "$TRAILERS" ] && [ "$TRAILERS" != "null" ]; then
    LEDGER_ID=$(echo "$TRAILERS" | grep -o '"ledgerId":"[^"]*"' | cut -d'"' -f4)
    SESSION_ID=$(echo "$TRAILERS" | grep -o '"sessionId":"[^"]*"' | cut -d'"' -f4)
    TIMELINE=$(echo "$TRAILERS" | grep -o '"timelineBranch":[0-9]*' | cut -d: -f2)
    if [ -n "$LEDGER_ID" ]; then
      echo "" >> "$COMMIT_MSG_FILE"
      echo "Unerr-Ledger-Id: $LEDGER_ID" >> "$COMMIT_MSG_FILE"
      echo "Unerr-Session: $SESSION_ID" >> "$COMMIT_MSG_FILE"
      echo "Unerr-Timeline-Branch: $TIMELINE" >> "$COMMIT_MSG_FILE"
    fi
  fi
fi`;
}

/**
 * Parse trailers from a commit message. Returns null if no unerr trailers found.
 */
export function parseTrailersFromMessage(
  commitMessage: string,
): CommitTrailers | null {
  const lines = commitMessage.split("\n");

  let ledgerId: string | null = null;
  let sessionId: string | null = null;
  let timelineBranch = 0;
  const branch = "unknown";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("Unerr-Ledger-Id:")) {
      ledgerId = trimmed.slice("Unerr-Ledger-Id:".length).trim();
    } else if (trimmed.startsWith("Unerr-Session:")) {
      sessionId = trimmed.slice("Unerr-Session:".length).trim();
    } else if (trimmed.startsWith("Unerr-Timeline-Branch:")) {
      timelineBranch = Number.parseInt(
        trimmed.slice("Unerr-Timeline-Branch:".length).trim(),
        10,
      );
    }
  }

  if (!ledgerId || !sessionId) return null;

  return { ledgerId, sessionId, timelineBranch, branch };
}
