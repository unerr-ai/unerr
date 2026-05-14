/**
 * Shadow Ledger Redactor (ST-6).
 *
 * Strips known secret patterns from any `args_summary` payload before it lands
 * in `.unerr/ledger/shadow.jsonl`. Best-effort defence — patterns are tuned
 * for the obvious cases (API tokens, bearer headers, env-style assignments)
 * and DO NOT replace a real secret scanner. We deliberately stay regex-only
 * to keep the hot path under a millisecond.
 *
 * Replacement: `<redacted>` (visible in logs and the timeline UI so users know
 * a value was scrubbed).
 */

const REDACTION_PATTERNS: RegExp[] = [
  // Anthropic / OpenAI-style secret prefixes
  /sk-[a-zA-Z0-9_-]{16,}/g,
  /sk_(?:live|test)_[a-zA-Z0-9_-]{16,}/g,

  // GitHub personal access tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  /gh[opsur]_[A-Za-z0-9_]{20,}/g,

  // Slack tokens (xox*-...)
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,

  // AWS access key id
  /AKIA[0-9A-Z]{16}/g,

  // Google API keys
  /AIza[0-9A-Za-z_-]{30,}/g,

  // JWT-ish three-segment base64url
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,

  // Authorization headers (Bearer / Basic / Token)
  /(?:Bearer|Basic|Token)\s+[A-Za-z0-9._=/+-]{8,}/gi,

  // password|secret|token|api_key = value | : value
  /\b(?:password|passwd|secret|token|api[-_]?key)\s*[:=]\s*['"]?[^\s'"&]+/gi,

  // VAR=value style env assignments where VAR looks secret-like
  /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASS|PASSWORD|CRED|CREDENTIAL)\s*=\s*[^\s]+/g,

  // .env-style export FOO=secret
  /export\s+[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASS|PASSWORD|CRED|CREDENTIAL)=[^\s]+/g,
];

const REDACTED = "<redacted>";

export function redactString(input: string): string {
  if (typeof input !== "string" || input.length === 0) return input;
  let out = input;
  for (const re of REDACTION_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

/**
 * Walk an arg payload depth-first and redact every string value in place.
 * Arrays/objects are recursed; non-string scalars are returned unchanged.
 * The input is treated as immutable — a new object is returned for any
 * branch that contained a redaction (and the original for branches that
 * didn't, which keeps GC pressure low on clean inputs).
 */
export function redactArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    result[k] = redactValue(v);
  }
  return result;
}

function redactValue(v: unknown): unknown {
  if (typeof v === "string") return redactString(v);
  if (Array.isArray(v)) return v.map(redactValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
      out[k] = redactValue(vv);
    }
    return out;
  }
  return v;
}
