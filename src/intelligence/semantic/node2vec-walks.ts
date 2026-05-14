/**
 * Node2Vec Random Walk Generator — seeded walks on the entity graph.
 *
 * Produces random walk sequences that capture graph structure.
 * Uses biased random walks (Node2Vec with p/q parameters) to balance
 * between BFS-like (local) and DFS-like (exploration) behavior.
 *
 * Seeded for deterministic, reproducible walks.
 */

export interface WalkConfig {
  walkLength: number;
  walksPerNode: number;
  p: number;
  q: number;
  seed: number;
}

const DEFAULT_CONFIG: WalkConfig = {
  walkLength: 40,
  walksPerNode: 10,
  p: 1.0,
  q: 1.0,
  seed: 42,
};

export type AdjacencyList = Map<string, string[]>;

/**
 * Seeded PRNG (xorshift32). Deterministic given same seed.
 */
function createRng(seed: number): () => number {
  let state = seed | 0;
  if (state === 0) state = 1;

  return () => {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

/**
 * Generate random walks from a graph.
 * Returns array of walks, where each walk is a sequence of entity keys.
 */
export function generateWalks(
  adjacency: AdjacencyList,
  config: Partial<WalkConfig> = {},
): string[][] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const rng = createRng(cfg.seed);
  const nodes = [...adjacency.keys()];
  const walks: string[][] = [];

  for (let w = 0; w < cfg.walksPerNode; w++) {
    for (const startNode of nodes) {
      const walk = [startNode];
      let current = startNode;
      let prev: string | null = null;

      for (let step = 1; step < cfg.walkLength; step++) {
        const neighbors = adjacency.get(current) ?? [];
        if (neighbors.length === 0) break;

        if (prev === null) {
          const idx = Math.floor(rng() * neighbors.length);
          const next = neighbors[idx]!;
          walk.push(next);
          prev = current;
          current = next;
        } else {
          const weights: number[] = [];
          for (const neighbor of neighbors) {
            if (neighbor === prev) {
              weights.push(1 / cfg.p);
            } else if ((adjacency.get(prev) ?? []).includes(neighbor)) {
              weights.push(1);
            } else {
              weights.push(1 / cfg.q);
            }
          }

          const totalWeight = weights.reduce((a, b) => a + b, 0);
          let r = rng() * totalWeight;
          let chosen = neighbors[0]!;

          for (let i = 0; i < weights.length; i++) {
            r -= weights[i]!;
            if (r <= 0) {
              chosen = neighbors[i]!;
              break;
            }
          }

          walk.push(chosen);
          prev = current;
          current = chosen;
        }
      }

      walks.push(walk);
    }
  }

  return walks;
}

/**
 * Build adjacency list from edge data.
 */
export function buildAdjacencyFromEdges(
  edges: Array<{ from_key: string; to_key: string }>,
): AdjacencyList {
  const adj: AdjacencyList = new Map();

  for (const edge of edges) {
    if (!adj.has(edge.from_key)) adj.set(edge.from_key, []);
    if (!adj.has(edge.to_key)) adj.set(edge.to_key, []);
    adj.get(edge.from_key)?.push(edge.to_key);
    adj.get(edge.to_key)?.push(edge.from_key);
  }

  return adj;
}
