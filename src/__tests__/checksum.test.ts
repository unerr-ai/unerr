import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

describe("checksum verification", () => {
  function computeChecksum(buf: Buffer): string {
    return createHash("sha256").update(buf).digest("hex");
  }

  it("produces 64-char hex string", () => {
    const buf = Buffer.from("hello world");
    const checksum = computeChecksum(buf);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    const buf = Buffer.from("test data");
    expect(computeChecksum(buf)).toBe(computeChecksum(buf));
  });

  it("detects tampered buffer", () => {
    const original = Buffer.from("original data");
    const originalChecksum = computeChecksum(original);

    const tampered = Buffer.from("tampered data");
    const tamperedChecksum = computeChecksum(tampered);

    expect(originalChecksum).not.toBe(tamperedChecksum);
  });

  it("matches known SHA-256 value", () => {
    // SHA-256 of empty string is well-known
    const empty = Buffer.from("");
    const checksum = computeChecksum(empty);
    expect(checksum).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("handles large buffers", () => {
    const largeBuf = Buffer.alloc(1024 * 1024, 0x42); // 1MB of 'B'
    const checksum = computeChecksum(largeBuf);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});
