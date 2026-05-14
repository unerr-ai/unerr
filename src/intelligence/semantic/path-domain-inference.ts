/**
 * Path-Based Domain Inference — infers domain labels from file paths.
 *
 * Uses directory naming conventions to assign domain labels:
 *   src/auth/ → "authentication"
 *   src/payments/ → "payments"
 *   src/api/routes/ → "api"
 *   tests/ → "testing"
 */

export interface DomainLabel {
  domain: string;
  confidence: number;
  source: string;
}

const PATH_PATTERNS: Array<{
  pattern: RegExp;
  domain: string;
  confidence: number;
}> = [
  { pattern: /\bauth\b/i, domain: "authentication", confidence: 0.9 },
  {
    pattern: /\bpayment|billing|stripe|checkout\b/i,
    domain: "payments",
    confidence: 0.9,
  },
  { pattern: /\bapi\b/i, domain: "api", confidence: 0.8 },
  {
    pattern: /\broute|router|middleware\b/i,
    domain: "routing",
    confidence: 0.8,
  },
  {
    pattern: /\bdb|database|model|schema|migration\b/i,
    domain: "database",
    confidence: 0.85,
  },
  {
    pattern: /\btest|spec|__tests__|__test__\b/i,
    domain: "testing",
    confidence: 0.95,
  },
  {
    pattern: /\bconfig|settings|env\b/i,
    domain: "configuration",
    confidence: 0.8,
  },
  {
    pattern: /\blog|logger|telemetry|monitor\b/i,
    domain: "observability",
    confidence: 0.8,
  },
  {
    pattern: /\butil|helper|lib|common|shared\b/i,
    domain: "utilities",
    confidence: 0.7,
  },
  {
    pattern: /\bui|component|view|page|layout\b/i,
    domain: "frontend",
    confidence: 0.85,
  },
  {
    pattern: /\bstyle|css|theme|design\b/i,
    domain: "styling",
    confidence: 0.85,
  },
  {
    pattern: /\bsecurity|crypto|encrypt|token\b/i,
    domain: "security",
    confidence: 0.9,
  },
  {
    pattern: /\bemail|notification|message|queue\b/i,
    domain: "messaging",
    confidence: 0.8,
  },
  {
    pattern: /\bstorage|upload|file|asset|media\b/i,
    domain: "storage",
    confidence: 0.8,
  },
  { pattern: /\bcache|redis|memcache\b/i, domain: "caching", confidence: 0.9 },
  { pattern: /\bsearch|index|elastic\b/i, domain: "search", confidence: 0.85 },
  {
    pattern: /\bgraph|intelligence|semantic|embedding\b/i,
    domain: "intelligence",
    confidence: 0.9,
  },
  {
    pattern: /\bproxy|transport|protocol|mcp\b/i,
    domain: "infrastructure",
    confidence: 0.8,
  },
  {
    pattern: /\btracking|analytics|metric\b/i,
    domain: "tracking",
    confidence: 0.85,
  },
];

/**
 * Infer domain labels for a file path.
 * Returns all matching domains sorted by confidence.
 */
export function inferDomain(filePath: string): DomainLabel[] {
  const labels: DomainLabel[] = [];

  for (const { pattern, domain, confidence } of PATH_PATTERNS) {
    if (pattern.test(filePath)) {
      labels.push({ domain, confidence, source: "path-pattern" });
    }
  }

  labels.sort((a, b) => b.confidence - a.confidence);
  return labels;
}

/**
 * Get the primary domain for a file path.
 * Returns null if no domain pattern matches.
 */
export function getPrimaryDomain(filePath: string): string | null {
  const labels = inferDomain(filePath);
  return labels[0]?.domain ?? null;
}
