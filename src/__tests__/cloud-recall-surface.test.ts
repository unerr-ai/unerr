/**
 * C5 recall SURFACE wiring tests — the seam between the C5 mechanism and the
 * read-only surface.
 *
 * Covers:
 *  - the local recall store (atomic save/read of due prompts + decision drafts,
 *    dedup, empty/corrupt-file fallback),
 *  - `runRecallSyncOnce` persisting an `ok` fetch to the store (and the paid
 *    gate making ZERO network + ZERO write when free / logged-out),
 *  - `answerDuePrompt` round-tripping an answer to the cloud and dropping the
 *    answered prompt from the store.
 *
 * Uses a temp HOME so nothing touches the real `~/.unerr` (the store is global).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempHome: string;
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => process.env.__TEST_HOME ?? actual.homedir(),
  };
});

// Mock the gate + credentials so we control paid/free + logged-in without files.
vi.mock("../cloud/entitlements.js", () => ({ canSyncRecall: vi.fn() }));
vi.mock("../cloud/credentials.js", () => ({ readCredentials: vi.fn() }));

import type {
  CloudClient,
  CloudResult,
  RecallAnswerAck,
  RecallPrompt,
  RecallPromptList,
} from "../cloud/client.js";
import { readCredentials } from "../cloud/credentials.js";
import {
  type DecisionDraft,
  type DecisionRecord,
  autoDraftAtMerge,
} from "../cloud/decision-record.js";
import { canSyncRecall } from "../cloud/entitlements.js";
import {
  readRecallStore,
  recallStorePath,
  removeDuePrompt,
  saveDecisionDraft,
  saveDuePrompts,
} from "../cloud/recall-store.js";
import { answerDuePrompt, runRecallSyncOnce } from "../cloud/recall-sync.js";

const mockGate = vi.mocked(canSyncRecall);
const mockCreds = vi.mocked(readCredentials);

function prompt(id: string, text = `remember ${id}?`): RecallPrompt {
  return {
    id,
    prompt: text,
    decision_ref: null,
    due_at: null,
    created_at: "2026-06-01T00:00:00.000Z",
  };
}
function okPrompts(prompts: RecallPrompt[]): CloudResult<RecallPromptList> {
  return { ok: true, status: 200, data: { prompts } };
}
function okAck(): CloudResult<RecallAnswerAck> {
  return {
    ok: true,
    status: 200,
    data: { answer_id: "a1", prompt_id: "p1", remembered: true },
  };
}
function stubClient(overrides: Partial<CloudClient> = {}): CloudClient {
  return {
    getRecallPrompts: vi.fn(),
    postRecallAnswer: vi.fn(),
    request: vi.fn(),
    ...overrides,
  } as unknown as CloudClient;
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "unerr-recall-"));
  process.env.__TEST_HOME = tempHome;
  vi.clearAllMocks();
});
afterEach(() => {
  process.env.__TEST_HOME = undefined;
  try {
    rmSync(tempHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("recall-store", () => {
  it("reads empty when the file is absent", async () => {
    const store = await readRecallStore();
    expect(store.due_prompts).toEqual([]);
    expect(store.drafts).toEqual([]);
    expect(store.fetched_at).toBeNull();
  });

  it("save/read round-trips due prompts and stamps fetched_at", async () => {
    await saveDuePrompts([prompt("p1"), prompt("p2")], { now: 1_000 });
    const store = await readRecallStore();
    expect(store.due_prompts.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(store.fetched_at).toBe(new Date(1_000).toISOString());
    // Lives under the temp HOME, not the real ~/.unerr.
    expect(recallStorePath().startsWith(tempHome)).toBe(true);
  });

  it("saveDuePrompts preserves existing drafts", async () => {
    const draft: DecisionDraft = {
      id: "d1",
      summary: "kept",
      needs_confirmation: true,
    };
    await saveDecisionDraft(draft);
    await saveDuePrompts([prompt("p1")]);
    const store = await readRecallStore();
    expect(store.drafts.map((d) => d.id)).toEqual(["d1"]);
    expect(store.due_prompts.map((p) => p.id)).toEqual(["p1"]);
  });

  it("saveDecisionDraft dedups by id (re-merge upserts)", async () => {
    const d: DecisionDraft = {
      id: "d1",
      summary: "first",
      needs_confirmation: true,
    };
    await saveDecisionDraft(d);
    await saveDecisionDraft({ ...d, summary: "second" });
    const store = await readRecallStore();
    expect(store.drafts).toHaveLength(1);
    expect(store.drafts[0]?.summary).toBe("second");
  });

  it("removeDuePrompt drops only the matching prompt", async () => {
    await saveDuePrompts([prompt("p1"), prompt("p2")]);
    await removeDuePrompt("p1");
    const store = await readRecallStore();
    expect(store.due_prompts.map((p) => p.id)).toEqual(["p2"]);
  });

  it("reads empty on a corrupt file (HR-B)", async () => {
    await saveDuePrompts([prompt("p1")]);
    writeFileSync(recallStorePath(), "{ not json", "utf8");
    const store = await readRecallStore();
    expect(store.due_prompts).toEqual([]);
  });

  it("writes atomically — no stray .tmp left behind", async () => {
    await saveDuePrompts([prompt("p1")]);
    const tmp = `${recallStorePath()}.tmp`;
    // The temp file is renamed over the real one; it must not survive.
    expect(() => readFileSync(tmp, "utf8")).toThrow();
    expect(readFileSync(recallStorePath(), "utf8")).toContain("p1");
  });
});

describe("runRecallSyncOnce", () => {
  it("free / logged-out → ZERO network + ZERO write", async () => {
    mockCreds.mockReturnValue(null);
    mockGate.mockReturnValue(false);
    const out = await runRecallSyncOnce();
    expect(out.result).toBe("not_logged_in");
    const store = await readRecallStore();
    expect(store.fetched_at).toBeNull();
  });

  it("logged-in but not entitled → gated, no write", async () => {
    mockCreds.mockReturnValue({
      api_url: "https://x",
      token: "t",
    } as ReturnType<typeof readCredentials>);
    mockGate.mockReturnValue(false);
    const out = await runRecallSyncOnce();
    expect(out.result).toBe("gated");
    const store = await readRecallStore();
    expect(store.fetched_at).toBeNull();
  });

  it("ok fetch persists the due prompts to the store", async () => {
    mockCreds.mockReturnValue({
      api_url: "https://x",
      token: "t",
    } as ReturnType<typeof readCredentials>);
    mockGate.mockReturnValue(true);
    const getRecallPrompts = vi
      .fn()
      .mockResolvedValue(okPrompts([prompt("p9")]));
    const out = await runRecallSyncOnce({
      makeClient: () => stubClient({ getRecallPrompts }),
    });
    expect(out.result).toBe("ok");
    const store = await readRecallStore();
    expect(store.due_prompts.map((p) => p.id)).toEqual(["p9"]);
  });
});

describe("answerDuePrompt", () => {
  it("free / logged-out → not_logged_in, no network", async () => {
    mockCreds.mockReturnValue(null);
    mockGate.mockReturnValue(false);
    const postRecallAnswer = vi.fn();
    const out = await answerDuePrompt(
      { promptId: "p1", remembered: true },
      { makeClient: () => stubClient({ postRecallAnswer }) }
    );
    expect(out.result).toBe("not_logged_in");
    expect(postRecallAnswer).not.toHaveBeenCalled();
  });

  it("ok answer reaches the cloud and drops the prompt locally", async () => {
    mockCreds.mockReturnValue({
      api_url: "https://x",
      token: "t",
    } as ReturnType<typeof readCredentials>);
    mockGate.mockReturnValue(true);
    await saveDuePrompts([prompt("p1"), prompt("p2")]);
    const postRecallAnswer = vi.fn().mockResolvedValue(okAck());
    const out = await answerDuePrompt(
      { promptId: "p1", remembered: true },
      { makeClient: () => stubClient({ postRecallAnswer }) }
    );
    expect(out.result).toBe("ok");
    // A stable client_answer_id is sent (B4-client — never random).
    const sent = postRecallAnswer.mock.calls[0]?.[0] as {
      client_answer_id: string;
      prompt_id: string;
    };
    expect(typeof sent.client_answer_id).toBe("string");
    expect(sent.prompt_id).toBe("p1");
    const store = await readRecallStore();
    expect(store.due_prompts.map((p) => p.id)).toEqual(["p2"]);
  });

  it("404 (foreign prompt) also drops it locally", async () => {
    mockCreds.mockReturnValue({
      api_url: "https://x",
      token: "t",
    } as ReturnType<typeof readCredentials>);
    mockGate.mockReturnValue(true);
    await saveDuePrompts([prompt("p1")]);
    const postRecallAnswer = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      error: { code: "not_found", message: "gone" },
    } satisfies CloudResult<never>);
    const out = await answerDuePrompt(
      { promptId: "p1", remembered: false },
      { makeClient: () => stubClient({ postRecallAnswer }) }
    );
    expect(out.result).toBe("not_found");
    const store = await readRecallStore();
    expect(store.due_prompts).toEqual([]);
  });
});

describe("merge auto-draft composition", () => {
  // The check-commit merge hook composes readDecisionRecords → autoDraftAtMerge
  // → saveDecisionDraft. readDecisionRecords needs timeline.db, so this exercises
  // the pure draft → store half (the part the hook actually persists).
  function record(id: string, body: string, ts: number): DecisionRecord {
    return {
      id,
      body,
      recorded_at_ms: ts,
      session_id: "s1",
      schedule: {} as DecisionRecord["schedule"],
    };
  }

  it("drafts the newest record's prose (never blank) and persists it", async () => {
    const records = [
      record("old", "chose A over B for latency", 1_000),
      record("new", "chose C over D for safety", 2_000),
    ];
    const draft = autoDraftAtMerge(records);
    expect(draft).not.toBeNull();
    expect(draft?.summary).toBe("chose C over D for safety");
    if (draft) await saveDecisionDraft(draft);
    const store = await readRecallStore();
    expect(store.drafts.map((d) => d.summary)).toEqual([
      "chose C over D for safety",
    ]);
  });

  it("no decision records → no draft, nothing persisted", async () => {
    const draft = autoDraftAtMerge([]);
    expect(draft).toBeNull();
    const store = await readRecallStore();
    expect(store.drafts).toEqual([]);
  });
});
