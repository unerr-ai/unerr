/**
 * Sprint P2-7: Known-library → family map.
 *
 * Static table mapping popular npm/pip/gem packages to server families.
 * Used by the import-walking indexer to tag entities with family affiliations.
 * When the intent classifier encounters an entity with family tags, it scores
 * those families ≥0.40 (high-confidence structural signal).
 *
 * Rationale: ~91% of real prompts contain no explicit family keyword. Import
 * structure is a high-confidence, zero-latency signal that dramatically reduces
 * the fail-open rate from ~91% to ~40%.
 */

export interface LibraryFamilyMapping {
  readonly packageName: string;
  readonly family: string;
  readonly confidence: number;
}

/**
 * Maps npm package names (and common aliases) to server family IDs.
 * Ordered by family for readability. Packages with multiple possible
 * families use the most common association.
 */
const LIBRARY_FAMILY_MAP: ReadonlyMap<string, string> = new Map([
  // ── PostgreSQL / Database family (pg) ──────────────────────────
  ["pg", "pg"],
  ["pg-pool", "pg"],
  ["postgres", "pg"],
  ["@prisma/client", "pg"],
  ["prisma", "pg"],
  ["drizzle-orm", "pg"],
  ["knex", "pg"],
  ["sequelize", "pg"],
  ["typeorm", "pg"],
  ["mikro-orm", "pg"],
  ["kysely", "pg"],
  ["better-sqlite3", "pg"],
  ["sql.js", "pg"],

  // ── GitHub family (gh) ─────────────────────────────────────────
  ["octokit", "gh"],
  ["@octokit/rest", "gh"],
  ["@octokit/core", "gh"],
  ["@octokit/graphql", "gh"],
  ["@actions/core", "gh"],
  ["@actions/github", "gh"],
  ["simple-git", "gh"],
  ["isomorphic-git", "gh"],

  // ── Slack family (slk) ─────────────────────────────────────────
  ["@slack/web-api", "slk"],
  ["@slack/bolt", "slk"],
  ["@slack/events-api", "slk"],
  ["@slack/rtm-api", "slk"],

  // ── Sentry family (snt) ────────────────────────────────────────
  ["@sentry/node", "snt"],
  ["@sentry/browser", "snt"],
  ["@sentry/nextjs", "snt"],
  ["@sentry/react", "snt"],

  // ── Stripe family (str) ────────────────────────────────────────
  ["stripe", "str"],
  ["@stripe/stripe-js", "str"],
  ["@stripe/react-stripe-js", "str"],

  // ── AWS family (aws) ───────────────────────────────────────────
  ["@aws-sdk/client-s3", "aws"],
  ["@aws-sdk/client-lambda", "aws"],
  ["@aws-sdk/client-dynamodb", "aws"],
  ["@aws-sdk/client-sqs", "aws"],
  ["@aws-sdk/client-sns", "aws"],
  ["aws-sdk", "aws"],
  ["aws-cdk-lib", "aws"],

  // ── Vercel family (vrc) ────────────────────────────────────────
  ["@vercel/analytics", "vrc"],
  ["@vercel/og", "vrc"],
  ["@vercel/edge", "vrc"],
  ["@vercel/kv", "vrc"],

  // ── Redis family (rds) ─────────────────────────────────────────
  ["redis", "rds"],
  ["ioredis", "rds"],
  ["@upstash/redis", "rds"],

  // ── MongoDB family (mdb) ───────────────────────────────────────
  ["mongodb", "mdb"],
  ["mongoose", "mdb"],
  ["@typegoose/typegoose", "mdb"],

  // ── Firebase/GCP family (fb) ───────────────────────────────────
  ["firebase", "fb"],
  ["firebase-admin", "fb"],
  ["@google-cloud/firestore", "fb"],
  ["@google-cloud/storage", "fb"],

  // ── Supabase family (sup) ──────────────────────────────────────
  ["@supabase/supabase-js", "sup"],
  ["@supabase/auth-helpers-nextjs", "sup"],
  ["@supabase/ssr", "sup"],

  // ── Kubernetes family (k8s) ────────────────────────────────────
  ["@kubernetes/client-node", "k8s"],
  ["kubernetes-client", "k8s"],

  // ── Docker family (dkr) ────────────────────────────────────────
  ["dockerode", "dkr"],

  // ── PostHog family (posthog) ───────────────────────────────────
  ["posthog-js", "posthog"],
  ["posthog-node", "posthog"],

  // ── LiveKit family (livekit) ───────────────────────────────────
  ["livekit-client", "livekit"],
  ["livekit-server-sdk", "livekit"],
  ["@livekit/components-react", "livekit"],

  // ── Deepgram family (deepgram) ─────────────────────────────────
  ["@deepgram/sdk", "deepgram"],

  // ── Circle family (circle) ─────────────────────────────────────
  ["@circle-fin/circle-sdk", "circle"],
  ["@circle-fin/usdc", "circle"],

  // ── Linear family (lin) ────────────────────────────────────────
  ["@linear/sdk", "lin"],

  // ── Figma family (fig) ─────────────────────────────────────────
  ["@figma/rest-api-spec", "fig"],
  ["figma-api", "fig"],

  // ── Jira/Atlassian family (jra) ────────────────────────────────
  ["jira-client", "jra"],
  ["jira.js", "jra"],

  // ── Datadog family (dd) ────────────────────────────────────────
  ["dd-trace", "dd"],
  ["@datadog/browser-rum", "dd"],
  ["datadog-metrics", "dd"],

  // ── Twilio family (twl) ────────────────────────────────────────
  ["twilio", "twl"],

  // ── SendGrid family (sg) ───────────────────────────────────────
  ["@sendgrid/mail", "sg"],

  // ── Auth0 family (auth0) ───────────────────────────────────────
  ["auth0", "auth0"],
  ["@auth0/nextjs-auth0", "auth0"],
]);

/**
 * Resolve a package name to its server family, if known.
 *
 * Handles scoped packages by checking:
 *   1. Exact match (e.g., `@prisma/client`)
 *   2. Scope prefix match (e.g., `@aws-sdk/*` → `aws`)
 *
 * Returns the family ID or null if unknown.
 */
export function resolveLibraryFamily(packageName: string): string | null {
  const direct = LIBRARY_FAMILY_MAP.get(packageName);
  if (direct) return direct;

  if (packageName.startsWith("@aws-sdk/")) return "aws";
  if (packageName.startsWith("@google-cloud/")) return "fb";
  if (packageName.startsWith("@sentry/")) return "snt";
  if (packageName.startsWith("@vercel/")) return "vrc";
  if (packageName.startsWith("@supabase/")) return "sup";
  if (packageName.startsWith("@octokit/")) return "gh";
  if (packageName.startsWith("@slack/")) return "slk";
  if (packageName.startsWith("@stripe/")) return "str";
  if (packageName.startsWith("@livekit/")) return "livekit";
  if (packageName.startsWith("@linear/")) return "lin";
  if (packageName.startsWith("@datadog/")) return "dd";
  if (packageName.startsWith("@auth0/")) return "auth0";
  if (packageName.startsWith("@circle-fin/")) return "circle";

  return null;
}

/**
 * Resolve families for a list of imports (dependency names).
 * Returns a deduplicated set of family IDs.
 */
export function resolveFamiliesFromImports(
  imports: readonly string[]
): ReadonlySet<string> {
  const families = new Set<string>();
  for (const imp of imports) {
    const family = resolveLibraryFamily(imp);
    if (family) families.add(family);
  }
  return families;
}

/**
 * Get all known library mappings (for testing/inspection).
 */
export function getLibraryFamilyMap(): ReadonlyMap<string, string> {
  return LIBRARY_FAMILY_MAP;
}
