/**
 * HTML → Markdown conversion with project-controlled rules.
 *
 * Uses turndown (lazy-loaded). Heading style is ATX (#) only — setext
 * separators (===/---) add bytes without semantic value. Anchor-only fragment
 * links are dropped. Tracking query params are stripped at link emission time.
 */

const TRACKING_PARAMS = /^(utm_|mc_|gclid$|fbclid$|yclid$|msclkid$|ref$|ref_)/i;

export async function htmlToMarkdown(
  html: string,
  baseUrl?: string
): Promise<string> {
  if (!html.trim()) return "";
  const TurndownModule = (await import("turndown")) as {
    default: new (opts?: Record<string, unknown>) => TurndownInstance;
  };
  const Turndown = TurndownModule.default;
  const td = new Turndown({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    hr: "---",
    bulletListMarker: "-",
    emDelimiter: "_",
  });

  td.addRule("drop-anchor-only", {
    filter: (node: HTMLElement) => {
      if (node.nodeName !== "A") return false;
      const href = node.getAttribute("href") ?? "";
      const text = (node.textContent ?? "").trim();
      return href.startsWith("#") || (href === "" && text === "");
    },
    replacement: (content: string) => content,
  });

  td.addRule("strip-tracking-params", {
    filter: (node: HTMLElement) => node.nodeName === "A",
    replacement: (content: string, node: HTMLElement) => {
      const rawHref = node.getAttribute("href") ?? "";
      const cleanHref = cleanUrl(rawHref, baseUrl);
      const title = node.getAttribute("title");
      if (!cleanHref) return content;
      const titleSuffix = title ? ` "${title}"` : "";
      return `[${content}](${cleanHref}${titleSuffix})`;
    },
  });

  return td.turndown(html);
}

/**
 * Normalize a link href: drop tracking query params and, when `baseUrl` is
 * provided, resolve relative/root-relative/protocol-relative URLs against it
 * so emitted markdown contains absolute URLs the agent can re-fetch. Returns
 * the href unchanged if it's a fragment, javascript: pseudo-protocol, or
 * already absolute. Falls back to the raw href on parse failure.
 */
export function cleanUrl(href: string, baseUrl?: string): string {
  if (!href || href.startsWith("#") || href.startsWith("javascript:")) {
    return href;
  }
  try {
    const base = baseUrl ?? "https://example.invalid";
    const url = new URL(href, base);
    const params = url.searchParams;
    const drop: string[] = [];
    for (const key of params.keys()) {
      if (TRACKING_PARAMS.test(key)) drop.push(key);
    }
    for (const key of drop) params.delete(key);
    if (!baseUrl && url.hostname === "example.invalid") {
      return url.pathname + url.search + url.hash;
    }
    return url.toString();
  } catch {
    return href;
  }
}

interface TurndownInstance {
  turndown(html: string): string;
  addRule(
    name: string,
    rule: {
      filter: (node: HTMLElement) => boolean;
      replacement: (content: string, node: HTMLElement) => string;
    }
  ): void;
}
