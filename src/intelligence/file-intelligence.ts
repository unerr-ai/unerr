/**
 * File-Level Intelligence Assembly — combines all entity intelligence for a file.
 *
 * S.1: Given a file path, assembles a comprehensive intelligence profile:
 *   - All entities in the file ranked by risk
 *   - Total blast radius (sum of all entity callers)
 *   - Dominant community
 *   - Top conventions that apply
 *   - Aggregate file risk level
 */

import type { IndexedEntity } from "./indexer/plugin-interface.js";

export interface FileEntityProfile {
  key: string;
  name: string;
  kind: string;
  riskLevel: string;
  fanIn: number;
  community: number;
}

export interface FileIntelligence {
  filePath: string;
  entities: FileEntityProfile[];
  topRiskEntities: FileEntityProfile[];
  totalBlastRadius: number;
  dominantCommunity: number;
  fileRiskLevel: "critical" | "high" | "medium" | "normal";
  entityCount: number;
}

/**
 * Assemble file-level intelligence from entity data.
 */
export function assembleFileIntelligence(
  filePath: string,
  entities: Array<{
    key: string;
    name: string;
    kind: string;
    file_path: string;
    risk_level?: string;
    fan_in?: number;
    community?: number;
  }>
): FileIntelligence {
  const fileEntities = entities.filter((e) => e.file_path === filePath);

  const profiles: FileEntityProfile[] = fileEntities.map((e) => ({
    key: e.key,
    name: e.name,
    kind: e.kind,
    riskLevel: e.risk_level ?? "normal",
    fanIn: e.fan_in ?? 0,
    community: e.community ?? -1,
  }));

  profiles.sort((a, b) => b.fanIn - a.fanIn);

  const topRiskEntities = profiles
    .filter((e) => e.riskLevel !== "normal")
    .slice(0, 3);

  const totalBlastRadius = profiles.reduce((sum, e) => sum + e.fanIn, 0);

  const communityVotes = new Map<number, number>();
  for (const e of profiles) {
    if (e.community >= 0) {
      communityVotes.set(
        e.community,
        (communityVotes.get(e.community) ?? 0) + 1
      );
    }
  }
  const dominantCommunity =
    communityVotes.size > 0
      ? [...communityVotes.entries()].sort((a, b) => b[1] - a[1])[0]![0]
      : -1;

  const maxRisk = profiles.reduce((max, e) => {
    const order = { critical: 4, high: 3, medium: 2, normal: 1 };
    const eLevel = order[e.riskLevel as keyof typeof order] ?? 1;
    return eLevel > max ? eLevel : max;
  }, 1);

  const fileRiskLevel: FileIntelligence["fileRiskLevel"] =
    maxRisk >= 4
      ? "critical"
      : maxRisk >= 3
        ? "high"
        : maxRisk >= 2
          ? "medium"
          : "normal";

  return {
    filePath,
    entities: profiles,
    topRiskEntities,
    totalBlastRadius,
    dominantCommunity,
    fileRiskLevel,
    entityCount: profiles.length,
  };
}
