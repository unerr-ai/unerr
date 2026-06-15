import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { CloudClient } from "../cloud/client.js";
import { assembleDrainers } from "../cloud/drainers/index.js";
import type { DrainerContext } from "../cloud/push-drainer.js";

/** A context pointed at an empty `.unerr` dir — every store is absent. */
function emptyCtx(unerrDir: string): DrainerContext {
  return {
    repoPath: "/repo/a",
    unerrDir,
    repoId: "repo-id",
    client: {} as unknown as CloudClient,
    source: "unerr-cli@test",
  };
}

describe("assembleDrainers", () => {
  let unerrDir: string;
  beforeEach(async () => {
    unerrDir = await mkdtemp(join(tmpdir(), "unerr-registry-"));
  });

  it("tolerates a repo with no stores yet — returns drainers, never throws", async () => {
    // No metrics.db / facts.db / jsonl exist in a fresh temp dir. Every builder
    // must degrade to zero drainers (or a no-op drainer) without throwing.
    const set = await assembleDrainers(emptyCtx(unerrDir));
    expect(Array.isArray(set.drainers)).toBe(true);
    // Each returned drainer reports "nothing pending" rather than crashing.
    for (const d of set.drainers) {
      await expect(d.read({})).resolves.toBeDefined(); // null is a valid resolve
    }
    await set.dispose?.();
  });

  it("every returned drainer has a unique cursor key", async () => {
    const set = await assembleDrainers(emptyCtx(unerrDir));
    const keys = set.drainers.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    await set.dispose?.();
  });
});
