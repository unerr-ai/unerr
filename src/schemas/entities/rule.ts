/**
 * RuleDoc schema — represents a code rule in the graph snapshot.
 *
 * Matches the CompactRule interface in intelligence/local-graph.ts.
 */

import { z } from "zod";

export const RuleDocSchema = z.object({
  key: z.string(),
  name: z.string(),
  scope: z.string(),
  severity: z.string(),
  engine: z.string(),
  query: z.string(),
  message: z.string(),
  file_glob: z.string(),
  enabled: z.boolean(),
  repo_id: z.string(),
});

export type RuleDoc = z.infer<typeof RuleDocSchema>;
