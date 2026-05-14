import { describe, expect, it } from "vitest";
import { resolveProviderConfig } from "../core/provider-factory.js";

describe("resolveProviderConfig", () => {
  it("defaults to anthropic with claude-sonnet-4-20250514", () => {
    const config = resolveProviderConfig({});
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("claude-sonnet-4-20250514");
  });

  it("resolves openai provider with gpt-4o default model", () => {
    const config = resolveProviderConfig({ provider: "openai" });
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o");
  });

  it("resolves google provider with gemini default model", () => {
    const config = resolveProviderConfig({ provider: "google" });
    expect(config.provider).toBe("google");
    expect(config.model).toBe("gemini-2.0-flash");
  });

  it("resolves ollama with llama3 default", () => {
    const config = resolveProviderConfig({ provider: "ollama" });
    expect(config.provider).toBe("ollama");
    expect(config.model).toBe("llama3");
  });

  it("passes through custom model and apiKey", () => {
    const config = resolveProviderConfig({
      provider: "openai",
      model: "gpt-4-turbo",
      apiKey: "sk-test",
    });
    expect(config.model).toBe("gpt-4-turbo");
    expect(config.apiKey).toBe("sk-test");
  });

  it("passes through baseUrl for openai-compatible", () => {
    const config = resolveProviderConfig({
      provider: "openai-compatible",
      model: "mistral-7b",
      baseUrl: "http://localhost:8080/v1",
    });
    expect(config.provider).toBe("openai-compatible");
    expect(config.baseUrl).toBe("http://localhost:8080/v1");
  });
});
