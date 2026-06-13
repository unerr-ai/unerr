/**
 * Recall-injection guard (Phase-2 Sprint 7).
 *
 * The prompt-submit hook fetches anchored notes from the warm proxy over UDS
 * and injects them, replacing the model round-trip the STEP-0 nudge forced.
 * Locks: (1) reply parsing tolerates the {ok,data:{notes}} envelope + bad
 * shapes; (2) the rendered block is null on no-notes (so the nudge survives);
 * (3) queryRecallNotes degrades to null with no proxy; (4) the async entry
 * falls back byte-identically to the sync nudge path when no proxy is up.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runUserPromptSubmitHookAsync } from "../hooks/prompt-hooks.js";
import {
  parseRecallReply,
  queryRecallNotes,
  renderRecallBlock,
} from "../hooks/recall-client.js";

describe("parseRecallReply", () => {
  it("extracts notes from the {ok,data:{notes}} MCP envelope", () => {
    const reply = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              data: {
                notes: [
                  {
                    kind: "rul",
                    anchor: "f:src/x.ts",
                    polarity: "-",
                    content: "no intelligence imports",
                  },
                ],
              },
            }),
          },
        ],
      },
    });
    const notes = parseRecallReply(reply);
    expect(notes).toEqual([
      {
        kind: "rul",
        anchor: "f:src/x.ts",
        polarity: "-",
        content: "no intelligence imports",
      },
    ]);
  });

  it("returns null on a JSON-RPC error reply", () => {
    expect(
      parseRecallReply(JSON.stringify({ jsonrpc: "2.0", id: 1, error: {} }))
    ).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseRecallReply("{not json")).toBeNull();
  });

  it("returns [] when the envelope carries an empty notes array", () => {
    const reply = JSON.stringify({
      result: { content: [{ text: JSON.stringify({ data: { notes: [] } }) }] },
    });
    expect(parseRecallReply(reply)).toEqual([]);
  });
});

describe("renderRecallBlock", () => {
  it("returns null for no notes (nudge survives)", () => {
    expect(renderRecallBlock([])).toBeNull();
  });

  it("leads with 'unerr' and keeps each note's DSL anchor for citation", () => {
    const block = renderRecallBlock([
      {
        kind: "wrn",
        anchor: "g:*.test.ts",
        polarity: "-",
        content: "no mocks",
      },
    ]);
    expect(block).toContain("unerr recalled 1 note");
    expect(block).toContain("[wrn g:*.test.ts -] no mocks");
  });
});

describe("queryRecallNotes — degradation", () => {
  it("returns null when the proxy socket is absent", async () => {
    const out = await queryRecallNotes("add a retry to fetchUser", {
      sockPath: "/tmp/unerr-does-not-exist.sock",
      timeoutMs: 50,
    });
    expect(out).toBeNull();
  });

  it("returns null on an empty prompt", async () => {
    expect(await queryRecallNotes("")).toBeNull();
  });
});

describe("runUserPromptSubmitHookAsync — degradation", () => {
  it("with no proxy up, still emits the static nudge (no recalled-notes block)", async () => {
    // queryRecallNotes resolves its default socket to `<cwd>/.unerr/state/
    // proxy.sock`. Run from a fresh temp cwd that has no such socket so recall
    // degrades to null — otherwise the hook reaches whatever live daemon serves
    // the dev repo's cwd and injects REAL notes, making this assertion
    // env-dependent (it must hold precisely when no proxy is up).
    // (We can't byte-compare against the sync path: the resume strip / STEP-1
    //  pickup is one-shot session state consumed by whichever call runs first.)
    const prevCwd = process.cwd();
    const tmp = mkdtempSync(join(tmpdir(), "unerr-recall-noproxy-"));
    process.chdir(tmp);
    try {
      const stdin = JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        prompt: "refactor the auth handler to add a retry",
      });
      const async_ = await runUserPromptSubmitHookAsync(stdin);
      // The static recall nudge survives, but Sprint 7 (T7.3/T7.7) rephrased it:
      // it states recall already ran and never names the (now agent-hidden)
      // unerr_recall_notes tool.
      expect(async_).toContain("anchored-note recall already ran");
      expect(async_).not.toContain("unerr_recall_notes");
      // …and no recalled-notes block leaked in with the proxy down.
      expect(async_).not.toContain("unerr recalled");
      // Valid Claude Code hook envelope.
      expect(() => JSON.parse(async_)).not.toThrow();
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("returns valid JSON for a non-code prompt (no recall attempted)", async () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: "thanks!",
    });
    const out = await runUserPromptSubmitHookAsync(stdin);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(out).not.toContain("unerr recalled");
  });
});
