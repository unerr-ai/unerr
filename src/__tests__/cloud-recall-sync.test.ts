/**
 * Anti-forgetting recall round-trip (C5) — orchestration tests.
 *
 * Covers: the paid gate (no network when free/logged-out), the stable
 * `client_answer_id` (deterministic, dedups on retry), HR-2 note stripping,
 * the 404 → not_found mapping, and the weekly-recap display.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  CloudClient,
  CloudResult,
  RecallAnswerAck,
  RecallPromptList,
} from "../cloud/client.js";
import { stripCodeBearingProse } from "../cloud/decision-record.js";
import { deterministicId } from "../cloud/event-id.js";
import {
  type WeeklyRecap,
  answerRecallPrompt,
  fetchRecallPrompts,
  fetchWeeklyRecap,
  recallAnswerId,
  renderWeeklyRecap,
} from "../cloud/recall-sync.js";

// Mock the entitlement gate so we control paid/free without a credential file.
vi.mock("../cloud/entitlements.js", () => ({
  canSyncRecall: vi.fn(),
}));
import { canSyncRecall } from "../cloud/entitlements.js";
const mockGate = vi.mocked(canSyncRecall);

function okPrompts(
  prompts: RecallPromptList["prompts"]
): CloudResult<RecallPromptList> {
  return { ok: true, status: 200, data: { prompts } };
}
function okAck(ack: RecallAnswerAck): CloudResult<RecallAnswerAck> {
  return { ok: true, status: 200, data: ack };
}
function errStatus(status: number): CloudResult<never> {
  return { ok: false, status, error: { code: "x", message: "boom" } };
}
function networkErr(): CloudResult<never> {
  return {
    ok: false,
    status: 0,
    network: true,
    error: { code: "n", message: "offline" },
  };
}

/** A minimal CloudClient stub — only the methods recall-sync calls. */
function stubClient(overrides: Partial<CloudClient> = {}): CloudClient {
  return {
    getRecallPrompts: vi.fn(),
    postRecallAnswer: vi.fn(),
    request: vi.fn(),
    ...overrides,
  } as unknown as CloudClient;
}

describe("paid gate", () => {
  it("fetchRecallPrompts makes ZERO network calls when not entitled", async () => {
    mockGate.mockReturnValue(false);
    const getRecallPrompts = vi.fn();
    const client = stubClient({ getRecallPrompts });
    const out = await fetchRecallPrompts(client);
    expect(out.result).toBe("gated");
    expect(getRecallPrompts).not.toHaveBeenCalled();
  });

  it("answerRecallPrompt makes ZERO network calls when not entitled", async () => {
    mockGate.mockReturnValue(false);
    const postRecallAnswer = vi.fn();
    const client = stubClient({ postRecallAnswer });
    const out = await answerRecallPrompt(client, {
      prompt: { id: "p1" },
      remembered: true,
    });
    expect(out.result).toBe("gated");
    expect(postRecallAnswer).not.toHaveBeenCalled();
  });

  it("fetchWeeklyRecap makes ZERO network calls when not entitled", async () => {
    mockGate.mockReturnValue(false);
    const request = vi.fn();
    const client = stubClient({ request });
    const out = await fetchWeeklyRecap(client);
    expect(out.result).toBe("gated");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("fetchRecallPrompts (entitled)", () => {
  it("returns the prompts on 200", async () => {
    mockGate.mockReturnValue(true);
    const getRecallPrompts = vi.fn().mockResolvedValue(
      okPrompts([
        {
          id: "p1",
          prompt: "why X?",
          decision_ref: "d1",
          due_at: null,
          created_at: "2026-01-01",
        },
      ])
    );
    const out = await fetchRecallPrompts(stubClient({ getRecallPrompts }));
    expect(out).toEqual({
      result: "ok",
      prompts: [
        {
          id: "p1",
          prompt: "why X?",
          decision_ref: "d1",
          due_at: null,
          created_at: "2026-01-01",
        },
      ],
    });
  });

  it("maps offline to network", async () => {
    mockGate.mockReturnValue(true);
    const getRecallPrompts = vi.fn().mockResolvedValue(networkErr());
    const out = await fetchRecallPrompts(stubClient({ getRecallPrompts }));
    expect(out.result).toBe("network");
  });
});

describe("client_answer_id (B4-client)", () => {
  it("is deterministic for the same prompt — retries dedup", () => {
    const a = recallAnswerId({ id: "prompt-42" });
    const b = recallAnswerId({ id: "prompt-42" });
    expect(a).toBe(b);
  });

  it("differs per prompt", () => {
    expect(recallAnswerId({ id: "p1" })).not.toBe(recallAnswerId({ id: "p2" }));
  });

  it("is the UUIDv5 of the prompt identity (never random)", () => {
    expect(recallAnswerId({ id: "p1" })).toBe(
      deterministicId("recall_answer", "p1")
    );
    // v5 shape: version nibble is 5, variant nibble in [8,9,a,b].
    const id = recallAnswerId({ id: "p1" });
    expect(id[14]).toBe("5");
    expect("89ab").toContain(id[19]);
  });

  it("is sent on the POST body so the server upserts on it", async () => {
    mockGate.mockReturnValue(true);
    const postRecallAnswer = vi
      .fn()
      .mockResolvedValue(
        okAck({ answer_id: "srv1", prompt_id: "p1", remembered: true })
      );
    const out = await answerRecallPrompt(stubClient({ postRecallAnswer }), {
      prompt: { id: "p1" },
      remembered: true,
    });
    expect(out.result).toBe("ok");
    const sent = postRecallAnswer.mock.calls[0]?.[0];
    expect(sent?.client_answer_id).toBe(recallAnswerId({ id: "p1" }));
    expect(sent?.prompt_id).toBe("p1");
    expect(sent?.remembered).toBe(true);
  });
});

describe("answerRecallPrompt error mapping", () => {
  it("maps a 404 (foreign/unknown prompt) to not_found — no hot retry loop", async () => {
    mockGate.mockReturnValue(true);
    const postRecallAnswer = vi.fn().mockResolvedValue(errStatus(404));
    const out = await answerRecallPrompt(stubClient({ postRecallAnswer }), {
      prompt: { id: "ghost" },
      remembered: false,
    });
    expect(out.result).toBe("not_found");
  });
});

describe("HR-2 note stripping on the answer", () => {
  it("withholds a code-bearing note by default", async () => {
    mockGate.mockReturnValue(true);
    const postRecallAnswer = vi
      .fn()
      .mockResolvedValue(
        okAck({ answer_id: "s", prompt_id: "p1", remembered: true })
      );
    await answerRecallPrompt(stubClient({ postRecallAnswer }), {
      prompt: { id: "p1" },
      remembered: true,
      note: "chose the path src/cloud/client.ts approach",
    });
    const sent = postRecallAnswer.mock.calls[0]?.[0];
    expect(sent?.note).toBeUndefined();
  });

  it("sends a plain-prose note", async () => {
    mockGate.mockReturnValue(true);
    const postRecallAnswer = vi
      .fn()
      .mockResolvedValue(
        okAck({ answer_id: "s", prompt_id: "p1", remembered: true })
      );
    await answerRecallPrompt(stubClient({ postRecallAnswer }), {
      prompt: { id: "p1" },
      remembered: true,
      note: "we picked the upsert route to avoid double counting",
    });
    const sent = postRecallAnswer.mock.calls[0]?.[0];
    expect(sent?.note).toBe(
      "we picked the upsert route to avoid double counting"
    );
  });

  it("stripCodeBearingProse flags paths, fences, calls, and generics", () => {
    expect(stripCodeBearingProse("see src/cloud/client.ts")).toBeUndefined();
    expect(stripCodeBearingProse("use `gate()` here")).toBeUndefined();
    expect(stripCodeBearingProse("call foo(bar)")).toBeUndefined();
    expect(stripCodeBearingProse("a Map<K, V> field")).toBeUndefined();
    expect(stripCodeBearingProse("config.json change")).toBeUndefined();
    expect(stripCodeBearingProse("plain reasoning text")).toBe(
      "plain reasoning text"
    );
  });

  it("opt-in lets code-bearing prose through (HR-2 explicit consent)", () => {
    expect(
      stripCodeBearingProse("changed src/cloud/client.ts", { optedIn: true })
    ).toBe("changed src/cloud/client.ts");
  });
});

describe("weekly recap display", () => {
  it("404 means the server route is not live yet → unavailable", async () => {
    mockGate.mockReturnValue(true);
    const request = vi.fn().mockResolvedValue(errStatus(404));
    const out = await fetchWeeklyRecap(stubClient({ request }));
    expect(out.result).toBe("unavailable");
  });

  it("renders the narrative leading with 'unerr'", () => {
    const recap: WeeklyRecap = {
      week_of: "2026-06-15",
      narrative: "You shipped the recall round-trip and 3 fixes.",
      synthesized_by: "llm",
    };
    const block = renderWeeklyRecap(recap);
    expect(block).toContain("unerr weekly recap");
    expect(block).toContain("2026-06-15");
    expect(block).toContain("You shipped the recall round-trip");
    expect(block).not.toContain("(auto-summary)");
  });

  it("tags a deterministic fallback narrative", () => {
    const block = renderWeeklyRecap({
      week_of: "2026-06-15",
      narrative: "Activity summary.",
      synthesized_by: "fallback",
    });
    expect(block).toContain("(auto-summary)");
  });

  it("renders nothing for an empty narrative", () => {
    expect(
      renderWeeklyRecap({
        week_of: "2026-06-15",
        narrative: "  ",
        synthesized_by: "llm",
      })
    ).toBeNull();
  });
});
