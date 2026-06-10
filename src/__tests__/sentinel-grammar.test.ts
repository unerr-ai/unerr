/**
 * Sprint SC-A.1: @sem sentinel grammar tests.
 *
 * The sentinel rule (Layer 8 §2.1): any comment line containing the
 * configured token (default `@sem`), space-separated k=v pairs, kebab-case
 * values for vocabulary keys, extras passthrough, first-wins stacking.
 * Must parse identically across all extractor comment syntaxes.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SENTINEL_TOKENS,
  extractDocComment,
  extractParsedDocComment,
  parseSentinelText,
} from "../intelligence/semantic/docstring-extractor.js";

describe("Sentinel grammar — comment syntaxes (SC-A.1)", () => {
  it("parses inside a TS/Java JSDoc block", () => {
    const source = `/**
 * Validates a session token against the active key set — the auth boundary
 * every inbound API call funnels through.
 * @sem domain=auth role=gateway
 */
export function validateToken(token: string) {}`;
    const parsed = extractParsedDocComment(source, 6);
    expect(parsed?.sentinel?.pairs).toEqual({
      domain: "auth",
      role: "gateway",
    });
    expect(parsed?.prose).toContain("auth boundary");
    expect(parsed?.prose).not.toContain("@sem");
  });

  it("parses inside JS/Go line comments", () => {
    const source = `// Reconciles payouts against ledger rows nightly.
// @sem domain=payments role=orchestrator
func ReconcileBalances() {}`;
    const parsed = extractParsedDocComment(source, 3);
    expect(parsed?.sentinel?.pairs).toEqual({
      domain: "payments",
      role: "orchestrator",
    });
  });

  it("parses inside Python # comments with a decorator gap", () => {
    const source = `# Handles inbound webhook callbacks from the payment provider.
# @sem domain=payments role=entry-point
@app.route("/webhook")
@require_auth
def handle_webhook(payload): ...`;
    const parsed = extractParsedDocComment(source, 5);
    expect(parsed?.sentinel?.pairs).toEqual({
      domain: "payments",
      role: "entry-point",
    });
    expect(parsed?.prose).toContain("webhook callbacks");
  });

  it("parses inside Rust /// docs with an attribute-macro gap", () => {
    const source = `/// Serializes graph deltas for the wire.
/// @sem domain=graph-indexing role=transformer
#[derive(Debug, Clone)]
pub struct DeltaCodec {}`;
    const parsed = extractParsedDocComment(source, 4);
    expect(parsed?.sentinel?.pairs).toEqual({
      domain: "graph-indexing",
      role: "transformer",
    });
  });

  it("parses inside SQL/Lua -- comments", () => {
    const source = `-- Nightly settlement rollup; the only writer of settlement_status.
-- @sem domain=payments role=store
CREATE PROCEDURE settle_balances()`;
    const parsed = extractParsedDocComment(source, 3);
    expect(parsed?.sentinel?.pairs).toEqual({
      domain: "payments",
      role: "store",
    });
  });

  it("parses inside Lisp ;; comments", () => {
    const source = `;; Normalizes token streams before indexing.
;; @sem domain=graph-indexing role=transformer
(defun normalize-tokens (stream) ...)`;
    const parsed = extractParsedDocComment(source, 3);
    expect(parsed?.sentinel?.pairs).toEqual({
      domain: "graph-indexing",
      role: "transformer",
    });
  });
});

describe("Sentinel grammar — pair validation", () => {
  it("keeps unknown keys as extras (forward-compatible)", () => {
    const parse = parseSentinelText("@sem domain=auth layer=infra");
    expect(parse?.pairs).toEqual({ domain: "auth", layer: "infra" });
    expect(parse?.invalidPairs).toEqual([]);
  });

  it("rejects non-kebab values for vocabulary keys", () => {
    const parse = parseSentinelText("@sem domain=Auth role=gateway");
    expect(parse?.pairs).toEqual({ role: "gateway" });
    expect(parse?.invalidPairs).toEqual(["domain=Auth"]);
  });

  it("validates each member of a kebab comma-list", () => {
    const ok = parseSentinelText("@sem domain=auth,session-store");
    expect(ok?.pairs.domain).toBe("auth,session-store");
    const bad = parseSentinelText("@sem domain=auth,Session_Store");
    expect(bad?.invalidPairs).toEqual(["domain=auth,Session_Store"]);
  });

  it("passes coupled= values through raw (file/entity names are not kebab)", () => {
    const parse = parseSentinelText(
      "@sem domain=auth coupled=src/auth/token.ts,validateToken"
    );
    expect(parse?.pairs.coupled).toBe("src/auth/token.ts,validateToken");
    expect(parse?.invalidPairs).toEqual([]);
  });

  it("rejects malformed pieces without dropping valid ones", () => {
    const parse = parseSentinelText("@sem domain =auth role=validator x");
    expect(parse?.pairs).toEqual({ role: "validator" });
    expect(parse?.invalidPairs).toEqual(["domain", "=auth", "x"]);
  });

  it("first wins on duplicate keys; duplicate recorded invalid", () => {
    const parse = parseSentinelText("@sem domain=auth domain=payments");
    expect(parse?.pairs.domain).toBe("auth");
    expect(parse?.invalidPairs).toEqual(["domain=payments"]);
  });

  it("records line length for the length gate", () => {
    const line = "@sem domain=auth role=gateway";
    const parse = parseSentinelText(line);
    expect(parse?.lineLength).toBe(line.length);
  });

  it("a bare token with no pairs parses to empty pairs (inert)", () => {
    const parse = parseSentinelText("@sem");
    expect(parse?.pairs).toEqual({});
    expect(parse?.stackedCount).toBe(1);
  });
});

describe("Sentinel grammar — stacking + tokens", () => {
  it("first sentinel line wins; stackedCount reports the rest", () => {
    const parse = parseSentinelText(
      "prose\n@sem domain=auth\n@sem domain=payments"
    );
    expect(parse?.pairs.domain).toBe("auth");
    expect(parse?.stackedCount).toBe(2);
  });

  it("a custom token alias parses identically", () => {
    const parse = parseSentinelText("@ctx domain=auth role=gateway", ["@ctx"]);
    expect(parse?.pairs).toEqual({ domain: "auth", role: "gateway" });
  });

  it("the default token is NOT matched when the team aliases another", () => {
    expect(parseSentinelText("@sem domain=auth", ["@ctx"])).toBeNull();
  });

  it("an empty token list disables sentinel parsing", () => {
    expect(parseSentinelText("@sem domain=auth", [])).toBeNull();
  });

  it("does not match the token mid-word (@semantics is not @sem)", () => {
    expect(parseSentinelText("uses @semantics internally")).toBeNull();
  });

  it("exposes the default token list", () => {
    expect(DEFAULT_SENTINEL_TOKENS).toEqual(["@sem"]);
  });
});

describe("Sentinel grammar — prose handling", () => {
  it("returns null sentinel and intact prose when no sentinel present", () => {
    const source = `/**
 * Plain JSDoc with no sentinel.
 * @param x - input
 */
function plain(x: number) {}`;
    const parsed = extractParsedDocComment(source, 5);
    expect(parsed?.sentinel).toBeNull();
    expect(parsed?.prose).toContain("Plain JSDoc");
    expect(parsed?.tags).toContain("param");
  });

  it("returns null prose for a sentinel-only block", () => {
    const source = `// @sem domain=auth
function f() {}`;
    const parsed = extractParsedDocComment(source, 2);
    expect(parsed?.prose).toBeNull();
    expect(parsed?.sentinel?.pairs.domain).toBe("auth");
  });

  it("parses the sentinel even when prose exceeds the 500-char cap", () => {
    const longProse = "word ".repeat(150).trim();
    const source = `// ${longProse}
// @sem domain=auth
function f() {}`;
    const parsed = extractParsedDocComment(source, 3);
    expect(parsed?.sentinel?.pairs.domain).toBe("auth");
    expect(parsed?.prose?.length).toBeLessThanOrEqual(500);
  });

  it("excludes the sentinel token from prose tags", () => {
    const source = `/**
 * Validates tokens. @deprecated
 * @sem domain=auth
 */
function f() {}`;
    const parsed = extractParsedDocComment(source, 5);
    expect(parsed?.tags).toContain("deprecated");
    expect(parsed?.tags).not.toContain("sem");
  });

  it("legacy extractDocComment behavior is unchanged", () => {
    expect(extractDocComment("function foo() {}", 1)).toBeNull();
    const source = `/**
 * Process a payment.
 */
function processPayment() {}`;
    expect(extractDocComment(source, 4)).toContain("Process a payment");
  });
});
