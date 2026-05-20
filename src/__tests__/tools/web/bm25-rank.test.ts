import { describe, expect, it } from "vitest";
import { rankPassagesByPrompt } from "../../../tools/web/bm25-rank.js";
import type { Passage } from "../../../tools/web/passage-split.js";

function p(index: number, heading: string | null, text: string): Passage {
  return { index, heading, text, startLine: index + 1 };
}

describe("rankPassagesByPrompt", () => {
  const passages: Passage[] = [
    p(0, "Intro", "Welcome to the documentation home page."),
    p(1, "Authentication", "Use OAuth2 access tokens to authenticate API calls."),
    p(2, "Pagination", "Endpoints accept cursor and limit query params for paging."),
    p(3, "Rate Limits", "API requests are throttled at 1000 per hour per key."),
    p(4, "Webhooks", "Subscribe to events through the webhook endpoint."),
  ];

  it("returns passages unchanged when prompt is empty", async () => {
    const out = await rankPassagesByPrompt(passages, { prompt: "" });
    expect(out).toBe(passages);
  });

  it("returns passages unchanged when prompt has no useful tokens", async () => {
    const out = await rankPassagesByPrompt(passages, { prompt: "the a an" });
    expect(out).toEqual(passages);
  });

  it("ranks authentication passage first for an auth prompt", async () => {
    const out = await rankPassagesByPrompt(passages, {
      prompt: "how do I authenticate with oauth tokens",
      topK: 3,
    });
    expect(out.length).toBeLessThanOrEqual(3);
    expect(out[0]?.heading).toBe("Authentication");
  });

  it("ranks rate-limit passage first for a throttling prompt", async () => {
    const out = await rankPassagesByPrompt(passages, {
      prompt: "what are the rate limits and throttling rules",
      topK: 2,
    });
    expect(out[0]?.heading).toBe("Rate Limits");
  });

  it("respects topK by capping returned passages", async () => {
    const out = await rankPassagesByPrompt(passages, {
      prompt: "api documentation pagination authentication",
      topK: 2,
    });
    expect(out.length).toBeLessThanOrEqual(2);
  });

  it("returns empty-prompt path when passages array is empty", async () => {
    const out = await rankPassagesByPrompt([], { prompt: "anything" });
    expect(out).toEqual([]);
  });

  it("suppresses short heading-only chrome in favor of prose passages", async () => {
    const mixed: Passage[] = [
      p(0, "Table of Contents", "Authentication"),
      p(1, "References", "Authentication"),
      p(
        2,
        "Authentication Guide",
        "Use OAuth2 access tokens to authenticate API calls. The authorization server issues a short-lived access token bound to the client and the requested scopes. Clients should refresh tokens before expiry and never embed long-lived credentials in user-facing builds."
      ),
    ];
    const out = await rankPassagesByPrompt(mixed, {
      prompt: "authentication oauth tokens",
      topK: 1,
    });
    expect(out[0]?.heading).toBe("Authentication Guide");
  });

  it("suppresses link-list passages in favor of prose passages", async () => {
    const mixed: Passage[] = [
      p(
        0,
        "Related Reading",
        "[Authentication](/auth) [Authorization](/authz) [Tokens](/tokens) [OAuth2](/oauth) [JWT](/jwt) [Scopes](/scopes)"
      ),
      p(
        1,
        "Authentication Guide",
        "Use OAuth2 access tokens to authenticate API calls. The authorization server issues a short-lived access token bound to the client and the requested scopes. Clients should refresh tokens before expiry and never embed long-lived credentials in user-facing builds."
      ),
    ];
    const out = await rankPassagesByPrompt(mixed, {
      prompt: "authentication oauth tokens",
      topK: 1,
    });
    expect(out[0]?.heading).toBe("Authentication Guide");
  });

  it("falls back to all passages when no prose candidates exist", async () => {
    const onlyChrome: Passage[] = [
      p(0, "Item 1", "OAuth"),
      p(1, "Item 2", "Tokens"),
      p(2, "Item 3", "Auth"),
    ];
    const out = await rankPassagesByPrompt(onlyChrome, {
      prompt: "oauth tokens",
      topK: 2,
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(2);
  });
});
