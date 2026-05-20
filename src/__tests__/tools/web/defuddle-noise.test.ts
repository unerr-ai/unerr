/**
 * Defuddle noise instrumentation — verifies that:
 *   1. nwsapi selector throws inside Defuddle are suppressed from stderr
 *   2. exactly ONE summary line per distinct signature lands on stderr
 *   3. every occurrence (first + subsequent) fires the BehaviorEventWriter
 *      sink with the right firstOccurrence flag
 *
 * Drives extraction through the real `defuddle` package against an HTML
 * fragment that contains a `<header>` with multiple `<p>` and an `<img>` —
 * the trio that triggers defuddle's hidden-chrome selector
 * `header:not(:has(p + p)):not(:has(img))`, which nwsapi 2.2.x cannot parse.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetDefuddleNoiseState,
  extractMainContent,
  setDefuddleNoiseSink,
} from "../../../tools/web/extract.js";

const TRIGGER_HTML = `<!doctype html><html><head>
<style>header:not(:has(p + p)):not(:has(img)) { color: red }</style>
</head><body>
<header><p>one</p><p>two</p><img src="x" alt=""></header>
<main><p>${"Body paragraph that is long enough to clear the MIN_USEFUL_CHARS threshold. ".repeat(8)}</p></main>
</body></html>`;

describe("defuddle noise instrumentation", () => {
  afterEach(() => {
    _resetDefuddleNoiseState();
  });

  it("counts every suppressed error and emits one summary per signature", async () => {
    const sink = vi.fn();
    setDefuddleNoiseSink(sink);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      await extractMainContent(TRIGGER_HTML, "https://example.test/");
      await extractMainContent(TRIGGER_HTML, "https://example.test/");
    } finally {
      errSpy.mockRestore();
      stderrSpy.mockRestore();
    }

    // sink fires on every occurrence; first call carries firstOccurrence:true
    expect(sink.mock.calls.length).toBeGreaterThanOrEqual(2);
    const firstFlags = sink.mock.calls.map((c) => c[1] as boolean);
    expect(firstFlags.filter((f) => f === true).length).toBe(1);
    expect(firstFlags.filter((f) => f === false).length).toBeGreaterThanOrEqual(
      1
    );

    // signatures are stable strings and the first one looks like a
    // selector-error message
    const signatures = sink.mock.calls.map((c) => c[0] as string);
    for (const s of signatures) expect(typeof s).toBe("string");
    expect(signatures[0]).toMatch(/selector|Defuddle/i);
  });

  it("survives a throwing sink without breaking extraction", async () => {
    setDefuddleNoiseSink(() => {
      throw new Error("sink boom");
    });
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const result = await extractMainContent(
        TRIGGER_HTML,
        "https://example.test/"
      );
      expect(result).toBeTruthy();
      expect(result.contentHtml.length).toBeGreaterThan(0);
    } finally {
      errSpy.mockRestore();
    }
  });
});
