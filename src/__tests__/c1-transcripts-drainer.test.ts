import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CloudClient } from "../cloud/client.js";
import {
  TRANSCRIPT_TEXT_CAP,
  buildTranscriptDrainers,
  clipTranscriptText,
} from "../cloud/drainers/transcripts.js";
import type { DrainerContext } from "../cloud/push-drainer.js";

function ctxFor(dir: string): DrainerContext {
  const client = {
    ingestTranscripts() {
      return Promise.resolve({
        ok: true,
        status: 200,
        data: { accepted: 0, rejected: 0 },
      });
    },
  } as unknown as CloudClient;
  return {
    repoPath: dir,
    unerrDir: dir,
    repoId: "repo_x",
    client,
    source: "unerr-cli@test",
  };
}

describe("c1 transcripts drainer (seam-only)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "c1-transcripts-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("registers no drainer when the repo has no metrics.db", async () => {
    // An empty .unerr dir has produced no transcript telemetry yet — the
    // builder opens nothing and contributes zero drainers (the real-read path
    // against a populated metrics.db is covered in cloud-cli-b-items.test.ts).
    const set = await buildTranscriptDrainers(ctxFor(dir));
    expect(set.drainers).toHaveLength(0);
    expect(set.dispose).toBeUndefined();
  });

  it("clipTranscriptText strips embedded code and caps at 16 KB", () => {
    const withCode = "reasoning prose\n```ts\nconst secret = 42;\n```\nmore";
    const clipped = clipTranscriptText(withCode);
    expect(clipped).not.toContain("const secret = 42");
    expect(clipped).toContain("reasoning prose");

    const huge = "x".repeat(TRANSCRIPT_TEXT_CAP + 5000);
    expect(clipTranscriptText(huge).length).toBeLessThanOrEqual(
      TRANSCRIPT_TEXT_CAP
    );
  });
});
