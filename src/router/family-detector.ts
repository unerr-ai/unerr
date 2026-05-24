/**
 * Family detector — maps session signals (file paths, directory names,
 * graph entities) to server families for advisory nudges.
 *
 * A "family" is a logical grouping that maps 1:1 to a proxied MCP server
 * alias (e.g., "gh" = GitHub family, "pg" = Postgres family).
 *
 * Detection is rule-based and deterministic (<1ms). No LLM calls.
 * Phase 1: advisory only (nudges). Phase 2 will promote to enforced masking.
 */

export interface FamilySignal {
  readonly family: string;
  readonly score: number;
  readonly reason: string;
}

export interface DetectionResult {
  readonly signals: readonly FamilySignal[];
  readonly primary: string | null;
  readonly secondary: readonly string[];
}

interface PatternRule {
  readonly family: string;
  readonly test: (path: string) => boolean;
  readonly weight: number;
  readonly label: string;
}

const PATH_RULES: readonly PatternRule[] = [
  // Database / SQL family
  {
    family: "pg",
    test: (p) => /\.(sql|psql)$/i.test(p),
    weight: 0.9,
    label: "SQL file",
  },
  {
    family: "pg",
    test: (p) => /\bdb\b/i.test(p),
    weight: 0.7,
    label: "db/ directory",
  },
  {
    family: "pg",
    test: (p) => /\bmigrations?\b/i.test(p),
    weight: 0.8,
    label: "migrations directory",
  },
  {
    family: "pg",
    test: (p) => /\bschema\b/i.test(p),
    weight: 0.7,
    label: "schema file",
  },
  {
    family: "pg",
    test: (p) => /\bprisma\b/i.test(p),
    weight: 0.6,
    label: "Prisma schema",
  },
  {
    family: "pg",
    test: (p) => /\bdrizzle\b/i.test(p),
    weight: 0.6,
    label: "Drizzle config",
  },
  {
    family: "pg",
    test: (p) => /\bknex\b/i.test(p),
    weight: 0.6,
    label: "Knex config",
  },
  {
    family: "pg",
    test: (p) => /\bsequelize\b/i.test(p),
    weight: 0.6,
    label: "Sequelize config",
  },
  {
    family: "pg",
    test: (p) => /\bseed(s|er)?\b/i.test(p),
    weight: 0.5,
    label: "seed data",
  },

  // GitHub / CI family
  {
    family: "gh",
    test: (p) => /\.github\b/i.test(p),
    weight: 0.9,
    label: ".github directory",
  },
  {
    family: "gh",
    test: (p) => /\bworkflows?\b/i.test(p),
    weight: 0.8,
    label: "GitHub workflows",
  },
  {
    family: "gh",
    test: (p) => /\bci\.ya?ml$/i.test(p),
    weight: 0.7,
    label: "CI config",
  },
  {
    family: "gh",
    test: (p) => /\bCODEOWNERS\b/i.test(p),
    weight: 0.6,
    label: "CODEOWNERS",
  },
  {
    family: "gh",
    test: (p) => /\bPULL_REQUEST_TEMPLATE\b/i.test(p),
    weight: 0.5,
    label: "PR template",
  },
  {
    family: "gh",
    test: (p) => /\bISSUE_TEMPLATE\b/i.test(p),
    weight: 0.5,
    label: "issue template",
  },
  {
    family: "gh",
    test: (p) => /\b\.git\b/i.test(p) && !/\.github/i.test(p),
    weight: 0.3,
    label: "git directory",
  },

  // Slack family
  {
    family: "slk",
    test: (p) => /\bslack\b/i.test(p),
    weight: 0.8,
    label: "slack-related file",
  },
  {
    family: "slk",
    test: (p) => /\bnotif(ication)?s?\b/i.test(p),
    weight: 0.3,
    label: "notification file",
  },
  {
    family: "slk",
    test: (p) => /\bwebhooks?\b/i.test(p),
    weight: 0.4,
    label: "webhook config",
  },

  // Kubernetes family
  {
    family: "k8s",
    test: (p) => /\bk8s\b/i.test(p),
    weight: 0.9,
    label: "k8s directory",
  },
  {
    family: "k8s",
    test: (p) => /\bkubernetes\b/i.test(p),
    weight: 0.9,
    label: "kubernetes directory",
  },
  {
    family: "k8s",
    test: (p) => /\bhelm\b/i.test(p),
    weight: 0.7,
    label: "Helm chart",
  },
  {
    family: "k8s",
    test: (p) => /\bkustomize\b/i.test(p),
    weight: 0.7,
    label: "Kustomize config",
  },
  {
    family: "k8s",
    test: (p) => /\bdeployments?\b.*\.ya?ml$/i.test(p),
    weight: 0.6,
    label: "deployment YAML",
  },

  // Docker family
  {
    family: "dkr",
    test: (p) => /\bDockerfile\b/i.test(p),
    weight: 0.9,
    label: "Dockerfile",
  },
  {
    family: "dkr",
    test: (p) => /\bdocker-compose\b/i.test(p),
    weight: 0.9,
    label: "docker-compose",
  },
  {
    family: "dkr",
    test: (p) => /\.dockerignore$/i.test(p),
    weight: 0.7,
    label: ".dockerignore",
  },

  // Sentry family
  {
    family: "snt",
    test: (p) => /\bsentry\b/i.test(p),
    weight: 0.8,
    label: "sentry config",
  },
  {
    family: "snt",
    test: (p) => /\berror.?tracking\b/i.test(p),
    weight: 0.5,
    label: "error tracking",
  },

  // Vercel / deployment family
  {
    family: "vrc",
    test: (p) => /\bvercel\.json$/i.test(p),
    weight: 0.9,
    label: "vercel.json",
  },
  {
    family: "vrc",
    test: (p) => /\b\.vercel\b/i.test(p),
    weight: 0.7,
    label: ".vercel directory",
  },

  // Cloud providers
  {
    family: "aws",
    test: (p) => /\baws\b/i.test(p),
    weight: 0.7,
    label: "AWS config",
  },
  {
    family: "aws",
    test: (p) => /\bcloudformation\b/i.test(p),
    weight: 0.8,
    label: "CloudFormation",
  },
  {
    family: "aws",
    test: (p) => /\bcdk\b/i.test(p),
    weight: 0.6,
    label: "AWS CDK",
  },
  {
    family: "aws",
    test: (p) => /\bsamconfig\b/i.test(p),
    weight: 0.7,
    label: "SAM config",
  },

  // Figma family
  {
    family: "fig",
    test: (p) => /\bfigma\b/i.test(p),
    weight: 0.8,
    label: "Figma reference",
  },
  {
    family: "fig",
    test: (p) => /\bdesign.?tokens?\b/i.test(p),
    weight: 0.5,
    label: "design tokens",
  },

  // Jira / project management family
  {
    family: "jra",
    test: (p) => /\bjira\b/i.test(p),
    weight: 0.8,
    label: "Jira reference",
  },

  // Linear family
  {
    family: "lin",
    test: (p) => /\blinear\b/i.test(p),
    weight: 0.7,
    label: "Linear reference",
  },

  // Redis family
  {
    family: "rds",
    test: (p) => /\bredis\b/i.test(p),
    weight: 0.8,
    label: "Redis config",
  },
  {
    family: "rds",
    test: (p) => /\bcache\b/i.test(p),
    weight: 0.3,
    label: "cache-related",
  },

  // MongoDB family
  {
    family: "mdb",
    test: (p) => /\bmongo(db)?\b/i.test(p),
    weight: 0.8,
    label: "MongoDB config",
  },

  // Stripe family
  {
    family: "str",
    test: (p) => /\bstripe\b/i.test(p),
    weight: 0.8,
    label: "Stripe integration",
  },
  {
    family: "str",
    test: (p) => /\bbilling\b/i.test(p),
    weight: 0.4,
    label: "billing module",
  },
  {
    family: "str",
    test: (p) => /\bpayments?\b/i.test(p),
    weight: 0.5,
    label: "payment module",
  },

  // Supabase family
  {
    family: "sup",
    test: (p) => /\bsupabase\b/i.test(p),
    weight: 0.9,
    label: "Supabase config",
  },

  // Firebase family
  {
    family: "fb",
    test: (p) => /\bfirebase\b/i.test(p),
    weight: 0.9,
    label: "Firebase config",
  },
  {
    family: "fb",
    test: (p) => /\bfirestore\b/i.test(p),
    weight: 0.8,
    label: "Firestore rules",
  },
];

/**
 * Detect server families from a set of recently accessed file paths.
 *
 * Returns a DetectionResult with scored signals, a primary family,
 * and secondary families. Scores are aggregated per family (max of
 * matching rules, not sum — prevents one directory with many files
 * from dominating).
 */
export function detectFamilies(
  recentFiles: readonly string[],
  knownAliases?: ReadonlySet<string>
): DetectionResult {
  const familyScores = new Map<string, { score: number; reasons: string[] }>();

  for (const filePath of recentFiles) {
    for (const rule of PATH_RULES) {
      if (knownAliases && !knownAliases.has(rule.family)) continue;

      if (rule.test(filePath)) {
        const existing = familyScores.get(rule.family);
        if (existing) {
          if (rule.weight > existing.score) {
            existing.score = rule.weight;
          }
          if (!existing.reasons.includes(rule.label)) {
            existing.reasons.push(rule.label);
          }
        } else {
          familyScores.set(rule.family, {
            score: rule.weight,
            reasons: [rule.label],
          });
        }
      }
    }
  }

  const signals: FamilySignal[] = [];
  for (const [family, { score, reasons }] of familyScores) {
    signals.push({
      family,
      score,
      reason: reasons.join(", "),
    });
  }

  signals.sort((a, b) => b.score - a.score);

  const primary = signals.length > 0 ? signals[0]!.family : null;
  const secondary = signals
    .slice(1)
    .filter((s) => s.score >= 0.3)
    .map((s) => s.family);

  return { signals, primary, secondary };
}

/**
 * Detect families from a single file path.
 * Convenience wrapper for single-file context.
 */
export function detectFamilyForFile(
  filePath: string,
  knownAliases?: ReadonlySet<string>
): DetectionResult {
  return detectFamilies([filePath], knownAliases);
}
