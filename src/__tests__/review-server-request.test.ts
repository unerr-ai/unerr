import { describe, expect, it } from "vitest";
import type { CloudClient, CloudResult } from "../cloud/client.js";
import {
  REVIEW_REQUEST_SCHEMA_VERSION,
  type ReviewServerResponse,
  buildReviewRequest,
  requestServerReview,
} from "../review/review-request.js";
import type { ChangeFile } from "../review/types.js";

/** A CloudClient stub that returns a fixed `postReviewRequest` result. */
function clientReturning(result: CloudResult<unknown>): CloudClient {
  return {
    postReviewRequest: async () => result,
  } as unknown as CloudClient;
}

describe("buildReviewRequest", () => {
  it("maps ChangeFiles to firewall-safe wire shapes, dropping null content", () => {
    const files: ChangeFile[] = [
      { path: "a.ts", kind: "modified", oldContent: "old", newContent: "new" },
      { path: "b.ts", kind: "added", oldContent: null, newContent: "fresh" },
      { path: "c.ts", kind: "deleted", oldContent: "gone", newContent: null },
    ];
    const req = buildReviewRequest({
      repo: "repo-hash",
      minSeverity: "medium",
      files,
      sessionId: "sess-1",
      intent: "rename the thing",
    });

    expect(req.schema_version).toBe(REVIEW_REQUEST_SCHEMA_VERSION);
    expect(req.repo).toBe("repo-hash");
    expect(req.session_id).toBe("sess-1");
    expect(req.intent).toBe("rename the thing");
    expect(req.min_severity).toBe("medium");
    expect(req.changes).toEqual([
      { target_file: "a.ts", old_content: "old", new_content: "new" },
      { target_file: "b.ts", new_content: "fresh" },
      { target_file: "c.ts", old_content: "gone" },
    ]);
  });

  it("omits optional session_id and intent when absent", () => {
    const req = buildReviewRequest({
      repo: "r",
      minSeverity: "high",
      files: [],
    });
    expect("session_id" in req).toBe(false);
    expect("intent" in req).toBe(false);
    expect(req.changes).toEqual([]);
  });
});

describe("requestServerReview (DORMANT path)", () => {
  const req = buildReviewRequest({
    repo: "r",
    minSeverity: "medium",
    files: [],
  });

  it("returns unavailable on a network failure", async () => {
    const client = clientReturning({
      ok: false,
      status: 0,
      network: true,
      error: { code: "network", message: "down" },
    });
    const res = await requestServerReview(client, req);
    expect(res.status).toBe("unavailable");
    expect(res.findings).toEqual([]);
    expect(res.reason).toContain("could not reach");
  });

  it("returns unavailable on a non-OK HTTP response", async () => {
    const client = clientReturning({
      ok: false,
      status: 503,
      error: { code: "unavailable", message: "later" },
    });
    const res = await requestServerReview(client, req);
    expect(res.status).toBe("unavailable");
    expect(res.reason).toContain("503");
  });

  it("passes through the server's unavailable status (the live default today)", async () => {
    const body: ReviewServerResponse = {
      status: "unavailable",
      findings: [],
      reason: "server-model review is not available yet",
    };
    const client = clientReturning({ ok: true, status: 200, data: body });
    const res = await requestServerReview(client, req);
    expect(res.status).toBe("unavailable");
    expect(res.findings).toEqual([]);
  });

  it("parses an ok response with findings", async () => {
    const body: ReviewServerResponse = {
      status: "ok",
      model: "unerr-review-1",
      findings: [
        {
          finding_key: "k1",
          checker_id: "c1",
          severity: "high",
          title: "leak",
          action: "remove the secret",
          target_file: "a.ts",
        },
      ],
    };
    const client = clientReturning({ ok: true, status: 200, data: body });
    const res = await requestServerReview(client, req);
    expect(res.status).toBe("ok");
    expect(res.model).toBe("unerr-review-1");
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]?.target_file).toBe("a.ts");
  });

  it("falls back to unavailable on a shapeless body", async () => {
    const client = clientReturning({
      ok: true,
      status: 200,
      data: { junk: 1 },
    });
    const res = await requestServerReview(client, req);
    expect(res.status).toBe("unavailable");
    expect(res.findings).toEqual([]);
  });
});
