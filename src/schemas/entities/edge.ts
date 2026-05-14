/**
 * EdgeDoc schema — represents a relationship edge in the graph snapshot.
 *
 * Matches the CompactEdge interface in intelligence/local-graph.ts.
 * Includes CFG (control-flow graph) fields present on "calls" and
 * "mutates_state" edge types.
 */

import { z } from "zod";

export const EdgeDocSchema = z.object({
  from_key: z.string(),
  to_key: z.string(),
  type: z.string(),
  // CFG control-flow fields
  seq: z.number().optional(),
  cond: z.string().optional(),
  br: z.string().optional(),
  lp: z.boolean().optional(),
  lk: z.string().optional(),
  nd: z.number().optional(),
  tg: z.boolean().optional(),
  eh: z.boolean().optional(),
  mt: z.string().optional(),
  mm: z.string().optional(),
  mo: z.string().optional(),
});

export type EdgeDoc = z.infer<typeof EdgeDocSchema>;
