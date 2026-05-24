import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SENTINEL_CLOSE,
  SENTINEL_OPEN,
  promoteNotesToClaudeMd,
  renderBlock,
  renderNoteBullet,
} from "../intelligence/claude-md-mirror.js";
import type { StoredNote } from "../intelligence/notes-store.js";

function makeNote(over: Partial<StoredNote> = {}): StoredNote {
  return {
    note_id: "n-1",
    kind: "rul",
    anchor_type: "p",
    anchor_value: "",
    polarity: "+",
    content: "all CozoDB calls use await",
    dedupe_key: "dk",
    reinforcement_count: 0,
    contradiction_count: 0,
    conflict_group_id: "",
    supersedes_note_id: "",
    inactive: false,
    anchor_missing: false,
    created_at: 0,
    last_seen_at: 0,
    ...over,
  };
}

describe("renderNoteBullet (C8)", () => {
  it("renders polarity + as 'do' and includes note_id in HTML comment", () => {
    const bullet = renderNoteBullet(makeNote());
    expect(bullet).toBe(
      "- [rul|do|project-wide] all CozoDB calls use await <!-- n-1 -->"
    );
  });

  it("renders file anchors verbatim", () => {
    const bullet = renderNoteBullet(
      makeNote({
        anchor_type: "f",
        anchor_value: "src/proxy/bridge.ts",
        polarity: "-",
        content: "no intelligence imports",
        kind: "wrn",
        note_id: "n-7",
      })
    );
    expect(bullet).toBe(
      "- [wrn|don't|f:src/proxy/bridge.ts] no intelligence imports <!-- n-7 -->"
    );
  });
});

describe("renderBlock (C8)", () => {
  it("emits sentinel-bounded block with empty-state body when no notes", () => {
    const block = renderBlock([]);
    expect(block).toContain(SENTINEL_OPEN);
    expect(block).toContain(SENTINEL_CLOSE);
    expect(block).toContain("_(no promoted notes)_");
  });

  it("emits one bullet per note", () => {
    const block = renderBlock([makeNote(), makeNote({ note_id: "n-2" })]);
    const bullets = block.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets).toHaveLength(2);
  });
});

describe("promoteNotesToClaudeMd (C8)", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "claudemd-mirror-"));
    path = join(dir, "CLAUDE.md");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates the file with a sentinel block when CLAUDE.md is missing", () => {
    const result = promoteNotesToClaudeMd({
      claude_md_path: path,
      notes: [makeNote()],
    });
    expect(result.outcome).toBe("created");
    expect(existsSync(path)).toBe(true);
    const written = readFileSync(path, "utf8");
    expect(written).toContain(SENTINEL_OPEN);
    expect(written).toContain("all CozoDB calls use await");
  });

  it("appends a sentinel block when CLAUDE.md exists but has no block", () => {
    writeFileSync(path, "# Existing\n\nManual content here.\n", "utf8");
    const result = promoteNotesToClaudeMd({
      claude_md_path: path,
      notes: [makeNote()],
    });
    expect(result.outcome).toBe("created");
    const written = readFileSync(path, "utf8");
    expect(written).toContain("Manual content here.");
    expect(written).toContain(SENTINEL_OPEN);
  });

  it("replaces an existing block when content changes", () => {
    promoteNotesToClaudeMd({
      claude_md_path: path,
      notes: [makeNote({ content: "first version" })],
    });
    const result = promoteNotesToClaudeMd({
      claude_md_path: path,
      notes: [makeNote({ content: "second version" })],
    });
    expect(result.outcome).toBe("replaced");
    const written = readFileSync(path, "utf8");
    expect(written).toContain("second version");
    expect(written).not.toContain("first version");
  });

  it("returns 'unchanged' when promoting the same notes twice", () => {
    promoteNotesToClaudeMd({
      claude_md_path: path,
      notes: [makeNote()],
    });
    const result = promoteNotesToClaudeMd({
      claude_md_path: path,
      notes: [makeNote()],
    });
    expect(result.outcome).toBe("unchanged");
  });

  it("never touches content outside the sentinel block on replace", () => {
    writeFileSync(
      path,
      `# Important\n\nHand-written.\n\n${SENTINEL_OPEN}\nold\n${SENTINEL_CLOSE}\n\n## Tail\nMore.\n`,
      "utf8"
    );
    promoteNotesToClaudeMd({
      claude_md_path: path,
      notes: [makeNote()],
    });
    const written = readFileSync(path, "utf8");
    expect(written).toContain("# Important");
    expect(written).toContain("Hand-written.");
    expect(written).toContain("## Tail");
    expect(written).toContain("More.");
    expect(written).not.toContain("\nold\n");
  });
});
