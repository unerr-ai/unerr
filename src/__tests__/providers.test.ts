import { describe, expect, it } from "vitest";
import { type ProviderName, SUPPORTED_PROVIDERS } from "../core/providers.js";

describe("Provider Registry", () => {
  it("lists all supported providers", () => {
    expect(SUPPORTED_PROVIDERS).toContain("anthropic");
    expect(SUPPORTED_PROVIDERS).toContain("openai");
    expect(SUPPORTED_PROVIDERS).toContain("google");
    expect(SUPPORTED_PROVIDERS).toContain("ollama");
    expect(SUPPORTED_PROVIDERS).toContain("openai-compatible");
    expect(SUPPORTED_PROVIDERS).toHaveLength(5);
  });

  it("provider names are string literals", () => {
    const names: ProviderName[] = [
      "anthropic",
      "openai",
      "google",
      "ollama",
      "openai-compatible",
    ];
    for (const name of names) {
      expect(SUPPORTED_PROVIDERS).toContain(name);
    }
  });
});
