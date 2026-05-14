/**
 * EntityDoc schema — represents a code entity in the graph snapshot.
 *
 * Matches the CompactEntity interface in intelligence/local-graph.ts.
 */

import { z } from "zod";

export const EntityDocSchema = z.object({
  key: z.string(),
  kind: z.string(),
  name: z.string(),
  file_path: z.string(),
  start_line: z.number().optional(),
  signature: z.string().optional(),
  body: z.string().optional(),
  fan_in: z.number().optional(),
  fan_out: z.number().optional(),
  risk_level: z.enum(["high", "medium", "normal"]).optional(),
  purpose: z.string().optional(),
  taxonomy: z.string().optional(),
  feature_area: z.string().optional(),
  justification_confidence: z.number().optional(),
});

export type EntityDoc = z.infer<typeof EntityDocSchema>;
