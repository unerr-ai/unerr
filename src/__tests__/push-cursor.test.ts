import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PushCursor } from "../cloud/sync/push-cursor.js";

async function freshUnerrDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "unerr-push-cursor-"));
}

describe("PushCursor", () => {
  let unerrDir: string;

  beforeEach(async () => {
    unerrDir = await freshUnerrDir();
  });

  it("starts empty when no cursor file exists", async () => {
    const cursor = await PushCursor.open(unerrDir);
    expect(cursor.position("events")).toEqual({});
    expect(cursor.deadLetterTotal()).toBe(0);
  });

  it("advances a row-id stream and a line-index stream independently", async () => {
    const cursor = await PushCursor.open(unerrDir);
    cursor.advance("events", { lastId: 42 });
    cursor.advance("ledger", { lastIndex: 100 });

    expect(cursor.position("events")).toEqual({ lastId: 42 });
    expect(cursor.position("ledger")).toEqual({ lastIndex: 100 });
  });

  it("merges a partial advance without clobbering the other field", async () => {
    const cursor = await PushCursor.open(unerrDir);
    cursor.advance("state", { lastId: 5, lastIndex: 9 });
    cursor.advance("state", { lastId: 7 });
    expect(cursor.position("state")).toEqual({ lastId: 7, lastIndex: 9 });
  });

  it("persists and reloads the watermark atomically", async () => {
    const a = await PushCursor.open(unerrDir);
    a.advance("events", { lastId: 17 });
    a.addDeadLetters("events", 2);
    await a.save();

    const b = await PushCursor.open(unerrDir);
    expect(b.position("events")).toEqual({ lastId: 17 });
    expect(b.deadLetterTotal()).toBe(2);
  });

  it("keeps the dead-letter tally out of the reported position", async () => {
    const cursor = await PushCursor.open(unerrDir);
    cursor.advance("router", { lastIndex: 3 });
    cursor.addDeadLetters("router", 4);
    expect(cursor.position("router")).toEqual({ lastIndex: 3 });
    expect(cursor.deadLetterTotal()).toBe(4);
  });

  it("accumulates dead letters across streams and ignores non-positive counts", async () => {
    const cursor = await PushCursor.open(unerrDir);
    cursor.addDeadLetters("events", 3);
    cursor.addDeadLetters("ledger", 1);
    cursor.addDeadLetters("ledger", 0);
    cursor.addDeadLetters("ledger", -5);
    expect(cursor.deadLetterTotal()).toBe(4);
  });

  it("survives a corrupt cursor file by starting empty", async () => {
    // Create the file (and its state/ dir) via a save, then corrupt it.
    const cursor = await PushCursor.open(unerrDir);
    await cursor.save();
    await writeFile(
      join(unerrDir, "state", "push-cursor.json"),
      "{not json",
      "utf8"
    );

    const reopened = await PushCursor.open(unerrDir);
    expect(reopened.position("events")).toEqual({});
    expect(reopened.deadLetterTotal()).toBe(0);
  });

  it("writes a versioned file with a streams map", async () => {
    const cursor = await PushCursor.open(unerrDir);
    cursor.advance("facts", { lastId: 1 });
    await cursor.save();
    const raw = await readFile(
      join(unerrDir, "state", "push-cursor.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.streams.facts).toEqual({ lastId: 1 });
  });
});
