/**
 * Conventions injection (Sprint 7, T7.4).
 *
 * The PostToolUse(Read) hook fetches the project's detected conventions over
 * UDS the first time the agent reads a code file and injects a compact block —
 * replacing the standalone get_conventions round-trip for the "write new code
 * matching project style" case. These tests lock the pure pieces (reply
 * parsing + block rendering) and the async handler's degradation contract
 * (no proxy → no conventions block, but the static read nudge still fires).
 */

import { describe, expect, it } from "vitest";

import { runPostReadHookAsync } from "../hooks/navigation-hooks.js";
import {
  type DetectedConvention,
  MAX_CONVENTIONS_RENDERED,
  parseConventionsReply,
  renderConventionsBlock,
} from "../hooks/conventions-client.js";

function rpcReply(payload: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ text: JSON.stringify(payload) }] },
  });
}

describe("parseConventionsReply", () => {
  it("flattens every kind list into one convention array", () => {
    const line = rpcReply({
      naming: [
        { name: "camelCase", kind: "naming", adherence_rate: 0.9, description: "fns" },
      ],
      import_direction: [
        { name: "no-cycles", kind: "import_direction", adherence_rate: 0.8, description: "" },
      ],
      structure: [],
    });
    const parsed = parseConventionsReply(line);
    expect(parsed).not.toBeNull();
    expect(parsed!.map((c) => c.name).sort()).toEqual(["camelCase", "no-cycles"]);
  });

  it("tolerates the {data:{…}} envelope shape", () => {
    const line = rpcReply({
      data: {
        naming: [
          { name: "PascalCase", kind: "naming", adherence_rate: 0.7, description: "types" },
        ],
      },
    });
    const parsed = parseConventionsReply(line);
    expect(parsed).toEqual([
      { name: "PascalCase", kind: "naming", adherence_rate: 0.7, description: "types" },
    ]);
  });

  it("returns null on an error reply", () => {
    expect(
      parseConventionsReply(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1 } }))
    ).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseConventionsReply("not json{")).toBeNull();
  });

  it("skips entries missing name/kind, defaults adherence + description", () => {
    const line = rpcReply({
      naming: [
        { name: "ok", kind: "naming" }, // no adherence/description → defaults
        { kind: "naming" }, // no name → skipped
      ],
    });
    const parsed = parseConventionsReply(line);
    expect(parsed).toEqual([
      { name: "ok", kind: "naming", adherence_rate: 0, description: "" },
    ]);
  });
});

describe("renderConventionsBlock", () => {
  const mk = (name: string, rate: number): DetectedConvention => ({
    name,
    kind: "naming",
    adherence_rate: rate,
    description: `${name} desc`,
  });

  it("returns null for an empty list (caller injects nothing)", () => {
    expect(renderConventionsBlock([])).toBeNull();
  });

  it("leads with 'unerr' and renders adherence as a percentage", () => {
    const block = renderConventionsBlock([mk("camelCase", 0.92)]);
    expect(block).not.toBeNull();
    expect(block!.startsWith("unerr ")).toBe(true);
    expect(block!).toContain("92% adherence");
    expect(block!).toContain("camelCase");
  });

  it("sorts by adherence descending and caps at MAX_CONVENTIONS_RENDERED", () => {
    const many = Array.from({ length: MAX_CONVENTIONS_RENDERED + 4 }, (_, i) =>
      mk(`conv${i}`, i / 100)
    );
    const block = renderConventionsBlock(many)!;
    const bulletLines = block.split("\n").filter((l) => l.trim().startsWith("•"));
    expect(bulletLines).toHaveLength(MAX_CONVENTIONS_RENDERED);
    // Highest adherence (the last-indexed) must appear first.
    expect(bulletLines[0]).toContain(`conv${many.length - 1}`);
  });
});

describe("runPostReadHookAsync degradation (no proxy)", () => {
  const codePayload = (file: string) =>
    JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: file },
    });

  it("with no reachable proxy, emits the static read nudge (no conventions block)", async () => {
    // No UDS socket exists in the test sandbox → queryConventions resolves null.
    const out = JSON.parse(
      await runPostReadHookAsync(codePayload("src/some-unique-read-target.ts"))
    );
    const text = JSON.stringify(out);
    expect(text).toContain("file_read");
    // The header only appears when conventions were actually fetched.
    expect(text).not.toContain("unerr detected the conventions");
  });

  it("passes through (no enrich) for a non-code file", async () => {
    const out = JSON.parse(
      await runPostReadHookAsync(codePayload("notes/todo.md"))
    );
    // passthrough → no additionalContext/systemMessage payload.
    expect(JSON.stringify(out)).not.toContain("file_read");
  });
});
