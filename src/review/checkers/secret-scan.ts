/**
 * `secret_scan` checker (.internal/reviewer-architecture.md §3 Tier 1 #11, §11 P0.5).
 *
 * Table-stakes for the commit gate: a token, key, or credential in a changed
 * file. Self-contained — pure regex over `ChangeFile.newContent`, no graph. Each
 * pattern is anchored to a known credential format (low false-positive rate by
 * construction §9); the generic `key = "…"` pattern is deliberately conservative
 * (quoted, long, and not an obvious env-var / placeholder reference). Matches are
 * redacted in the evidence so the reviewer output never re-leaks the secret.
 */

import type { ReviewChecker } from "../checker.js";
import type { ReviewContext, ReviewFinding, Severity } from "../types.js";

interface SecretPattern {
  label: string;
  regex: RegExp;
}

/** Known credential formats. Order matters only for first-match reporting per line. */
const SECRET_PATTERNS: SecretPattern[] = [
  { label: "AWS access key id", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    label: "private key block",
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  },
  { label: "GitHub token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { label: "Slack token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: "Google API key", regex: /\bAIza[0-9A-Za-z\-_]{35}\b/ },
  { label: "Stripe secret key", regex: /\bsk_live_[0-9a-zA-Z]{24,}\b/ },
  {
    label: "hardcoded credential",
    // quoted, ≥12 chars, assigned to a key/secret/token/password identifier,
    // and not an env-var / interpolation / placeholder reference.
    regex:
      /(?:api[_-]?key|secret|token|password|passwd|pwd)["']?\s*[:=]\s*["'](?!\s*(?:\$|<|\{|process\.env|null|undefined|xxx|placeholder|your[_-]))[^"']{12,}["']/i,
  },
];

/** Mask all but the first 4 chars so the finding never re-leaks the value. */
function redact(match: string): string {
  if (match.length <= 4) return "****";
  return `${match.slice(0, 4)}${"*".repeat(Math.min(match.length - 4, 8))}`;
}

export class SecretScanChecker implements ReviewChecker {
  readonly id = "secret_scan";
  readonly tier = 1 as const;
  readonly defaultSeverity: Severity = "critical";

  async check(ctx: ReviewContext): Promise<ReviewFinding[]> {
    const findings: ReviewFinding[] = [];

    for (const file of ctx.changeSet.files) {
      if (file.kind === "deleted" || !file.newContent) continue;

      const lines = file.newContent.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        for (const pattern of SECRET_PATTERNS) {
          const m = line.match(pattern.regex);
          if (!m) continue;
          findings.push({
            checkerId: this.id,
            tier: 1,
            severity: "critical",
            anchor: { kind: "f", value: file.path, line: i + 1 },
            title: `${pattern.label} committed in ${file.path}:${i + 1}`,
            evidence: [
              `${file.path}:${i + 1} matches ${pattern.label}: ${redact(m[0])}`,
            ],
            action: `remove the ${pattern.label} from ${file.path}:${i + 1}, move it to an env var or secret store, and rotate the exposed credential`,
            needsModel: false,
          });
          break; // one finding per line is enough
        }
      }
    }

    return findings;
  }
}
