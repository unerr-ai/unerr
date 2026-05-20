import { describe, expect, it } from "vitest";
import { decodeHtmlBytes } from "../../../tools/web/fetch-url-protocol.js";

function encode(text: string, charset: string): Uint8Array {
  if (charset === "iso-8859-1") {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      out[i] = text.charCodeAt(i) & 0xff;
    }
    return out;
  }
  return new TextEncoder().encode(text);
}

describe("decodeHtmlBytes", () => {
  it("decodes utf-8 by default when no charset is declared", () => {
    const bytes = new TextEncoder().encode(
      "<!doctype html><html><body><p>héllo wörld — naïve</p></body></html>"
    );
    const html = decodeHtmlBytes(bytes, "text/html");
    expect(html).toContain("héllo wörld — naïve");
  });

  it("honors charset declared in Content-Type header", () => {
    const text = "<!doctype html><html><body><p>caf\xe9</p></body></html>";
    const bytes = encode(text, "iso-8859-1");
    const html = decodeHtmlBytes(bytes, "text/html; charset=iso-8859-1");
    expect(html).toContain("café");
  });

  it("honors <meta charset=...> when header is silent", () => {
    const text =
      '<!doctype html><html><head><meta charset="iso-8859-1"></head><body><p>caf\xe9</p></body></html>';
    const bytes = encode(text, "iso-8859-1");
    const html = decodeHtmlBytes(bytes, "text/html");
    expect(html).toContain("café");
  });

  it("honors legacy http-equiv content-type meta charset", () => {
    const text =
      '<!doctype html><html><head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"></head><body><p>caf\xe9</p></body></html>';
    const bytes = encode(text, "iso-8859-1");
    const html = decodeHtmlBytes(bytes, "text/html");
    expect(html).toContain("café");
  });

  it("falls back to utf-8 when declared charset is unknown to TextDecoder", () => {
    const text = "<!doctype html><html><body><p>plain</p></body></html>";
    const bytes = new TextEncoder().encode(text);
    const html = decodeHtmlBytes(bytes, "text/html; charset=x-not-a-charset");
    expect(html).toContain("plain");
  });

  it("does not crash on empty bytes", () => {
    expect(() => decodeHtmlBytes(new Uint8Array(0), "text/html")).not.toThrow();
  });
});
