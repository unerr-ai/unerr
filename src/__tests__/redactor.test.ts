/**
 * ST-6: Redactor + archive job.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveShadowLedger } from "../tracking/ledger-archiver.js";
import { redactArgs, redactString } from "../tracking/redactor.js";
import { ShadowLedger } from "../tracking/shadow-ledger.js";

describe("redactString", () => {
  it("redacts Anthropic-style sk-... keys", () => {
    expect(redactString("API key: sk-abc123def456ghi789jklmno")).toBe(
      "API key: <redacted>"
    );
  });

  it("redacts GitHub PATs", () => {
    expect(redactString("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(
      "<redacted>"
    );
  });

  it("redacts Bearer headers", () => {
    expect(redactString("Authorization: Bearer abc.def.ghi=")).toContain(
      "<redacted>"
    );
  });

  it("redacts password assignments", () => {
    expect(redactString('password="hunter2"')).toContain("<redacted>");
    expect(redactString("api_key=verysecret123")).toContain("<redacted>");
  });

  it("does not touch unrelated text", () => {
    expect(redactString("just some normal log line")).toBe(
      "just some normal log line"
    );
  });
});

describe("redactArgs", () => {
  it("walks nested objects", () => {
    const out = redactArgs({
      file_path: "src/auth.ts",
      env: { TOKEN: "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      list: ["plain", "Bearer abcdefghijklmno12345"],
    });
    expect(out.file_path).toBe("src/auth.ts");
    expect((out.env as Record<string, unknown>).TOKEN).toBe("<redacted>");
    expect((out.list as string[])[1]).toContain("<redacted>");
  });
});

describe("ShadowLedger redacts on record", () => {
  let tempDir: string;
  let unerrDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `unerr-redact-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    unerrDir = join(tempDir, ".unerr");
    mkdirSync(unerrDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("redacts a secret-looking arg before persisting", () => {
    const ledger = new ShadowLedger(unerrDir);
    ledger.record(
      "shell",
      { command: "curl -H 'Authorization: Bearer abcdef0123456789'" },
      {},
      "main",
      "x"
    );
    const line = readFileSync(
      join(unerrDir, "ledger", "shadow.jsonl"),
      "utf-8"
    ).trim();
    expect(line).toContain("<redacted>");
    expect(line).not.toContain("abcdef0123456789");
  });
});

describe("archiveShadowLedger", () => {
  let tempDir: string;
  let unerrDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `unerr-arch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    unerrDir = join(tempDir, ".unerr");
    mkdirSync(join(unerrDir, "ledger"), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("splits old entries into a gzipped archive and keeps recent ones", () => {
    const filePath = join(unerrDir, "ledger", "shadow.jsonl");
    const now = Date.parse("2026-05-12T00:00:00Z");
    const old = JSON.stringify({
      id: "1",
      ts: new Date(now - 10 * 24 * 60 * 60_000).toISOString(),
      tool: "file_read",
    });
    const recent = JSON.stringify({
      id: "2",
      ts: new Date(now - 60_000).toISOString(),
      tool: "file_read",
    });
    writeFileSync(filePath, `${old}\n${recent}\n`, "utf-8");

    const result = archiveShadowLedger(unerrDir, { nowMs: now });
    expect(result.archived).toBe(1);
    expect(result.kept).toBe(1);
    expect(result.archivePath).not.toBeNull();
    expect(existsSync(result.archivePath!)).toBe(true);

    const decoded = gunzipSync(readFileSync(result.archivePath!)).toString(
      "utf-8"
    );
    expect(decoded).toContain('"id":"1"');

    const remaining = readFileSync(filePath, "utf-8").trim();
    expect(remaining).toContain('"id":"2"');
    expect(remaining).not.toContain('"id":"1"');
  });

  it("is a no-op when nothing is older than the cutoff", () => {
    const filePath = join(unerrDir, "ledger", "shadow.jsonl");
    const now = Date.parse("2026-05-12T00:00:00Z");
    const line = JSON.stringify({
      id: "1",
      ts: new Date(now - 60_000).toISOString(),
      tool: "file_read",
    });
    writeFileSync(filePath, `${line}\n`, "utf-8");
    const result = archiveShadowLedger(unerrDir, { nowMs: now });
    expect(result.archived).toBe(0);
    expect(result.archivePath).toBeNull();
  });
});
