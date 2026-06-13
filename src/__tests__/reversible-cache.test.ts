import { describe, expect, it } from "vitest";
import {
	buildCacheMarker,
	CACHE_MARKER_LEGEND,
	CACHE_MARKER_PREFIX,
	createReversibleCache,
	parseCacheMarker,
	ReversibleCache,
} from "../proxy/reversible-cache.js";

describe("ReversibleCache — put/get", () => {
	it("put then get returns the full original", () => {
		const cache = new ReversibleCache();
		const original = "the quick brown fox jumps over the lazy dog";
		const hash = cache.put(original);
		expect(cache.get(hash)).toBe(original);
	});

	it("put then get with a range returns only the requested slice", () => {
		const cache = new ReversibleCache();
		const original = "0123456789abcdef";
		const hash = cache.put(original);
		expect(cache.get(hash, { offset: 4, limit: 6 })).toBe("456789");
	});

	it("clamps out-of-range slices to the available bytes", () => {
		const cache = new ReversibleCache();
		const original = "short";
		const hash = cache.put(original);
		expect(cache.get(hash, { offset: 2, limit: 100 })).toBe("ort");
		expect(cache.get(hash, { offset: 100, limit: 10 })).toBe("");
		expect(cache.get(hash, { offset: -5, limit: 2 })).toBe("sh");
	});

	it("miss returns null and records a miss", () => {
		const cache = new ReversibleCache();
		expect(cache.get("deadbeefdeadbeef")).toBeNull();
		expect(cache.stats.misses).toBe(1);
		expect(cache.stats.hits).toBe(0);
	});

	it("tracks hit and miss counters", () => {
		const cache = new ReversibleCache();
		const hash = cache.put("payload");
		cache.get(hash);
		cache.get(hash);
		cache.get("nope000000000000");
		expect(cache.stats.hits).toBe(2);
		expect(cache.stats.misses).toBe(1);
	});

	it("factory produces an equivalent cache", () => {
		const cache = createReversibleCache();
		const hash = cache.put("via factory");
		expect(cache.get(hash)).toBe("via factory");
	});
});

describe("ReversibleCache — eviction", () => {
	it("evicts oldest when entry count exceeds maxEntries", () => {
		const cache = new ReversibleCache({ maxEntries: 2 });
		const a = cache.put("alpha");
		const b = cache.put("bravo");
		const c = cache.put("charlie"); // pushes out the oldest (alpha)

		expect(cache.get(a)).toBeNull();
		expect(cache.get(b)).toBe("bravo");
		expect(cache.get(c)).toBe("charlie");
		expect(cache.stats.entries).toBe(2);
	});

	it("evicts oldest when total bytes exceed maxBytes", () => {
		// Each original is 100 bytes; cap at 250 → only 2 fit.
		const cache = new ReversibleCache({ maxEntries: 100, maxBytes: 250 });
		const first = cache.put("a".repeat(100));
		const second = cache.put("b".repeat(100));
		const third = cache.put("c".repeat(100)); // total would be 300 > 250

		expect(cache.get(first)).toBeNull();
		expect(cache.get(second)).toBe("b".repeat(100));
		expect(cache.get(third)).toBe("c".repeat(100));
		expect(cache.stats.bytes).toBeLessThanOrEqual(250);
	});
});

describe("ReversibleCache — staleness guard", () => {
	it("a changed mtime forces a different key (cache miss for the stale hash)", () => {
		const cache = new ReversibleCache();
		const content = "export const x = 1;";
		const h1 = cache.put(content, { file: "src/x.ts", mtime: 1000 });
		const h2 = cache.put(content, { file: "src/x.ts", mtime: 2000 });

		expect(h1).not.toBe(h2);
		// Both live, but the new mtime's hash is distinct from the old one.
		expect(cache.get(h2)).toBe(content);
	});

	it("same file+mtime+content yields a stable hash", () => {
		const cache = new ReversibleCache();
		const meta = { file: "src/x.ts", mtime: 1000 };
		const h1 = cache.put("body", meta);
		const h2 = cache.put("body", meta);
		expect(h1).toBe(h2);
		expect(cache.stats.entries).toBe(1);
	});
});

describe("cache-ref marker — build/parse", () => {
	it("round-trips all fields", () => {
		const line = buildCacheMarker({
			hash: "abc123def456abcd",
			droppedItems: 12,
			droppedBytes: 4096,
			totalItems: 50,
		});
		const parsed = parseCacheMarker(line);
		expect(parsed).toEqual({
			hash: "abc123def456abcd",
			droppedItems: 12,
			droppedBytes: 4096,
			totalItems: 50,
		});
	});

	it("round-trips a hash-only marker", () => {
		const line = buildCacheMarker({ hash: "0011223344556677" });
		const parsed = parseCacheMarker(line);
		expect(parsed).toEqual({ hash: "0011223344556677" });
	});

	it("marker starts with the cache-ref prefix and names the retrieval action", () => {
		const line = buildCacheMarker({ hash: "abcd1234abcd1234" });
		expect(line.startsWith(CACHE_MARKER_PREFIX)).toBe(true);
		expect(line).toContain("file_read({cache_ref:'abcd1234abcd1234'");
	});

	it("parseCacheMarker returns null for a non-marker line", () => {
		expect(parseCacheMarker("just some text")).toBeNull();
		expect(parseCacheMarker("ur|act do something")).toBeNull();
	});

	it("byte-stable for identical input", () => {
		const input = {
			hash: "feedfacefeedface",
			droppedItems: 3,
			droppedBytes: 999,
			totalItems: 10,
		};
		const a = buildCacheMarker(input);
		const b = buildCacheMarker({ ...input });
		expect(a).toBe(b);
		// No clock / random: re-building later is identical too.
		expect(buildCacheMarker(input)).toBe(a);
	});

	it("legend is a single line describing the marker", () => {
		expect(CACHE_MARKER_LEGEND).toContain(CACHE_MARKER_PREFIX);
		expect(CACHE_MARKER_LEGEND.includes("\n")).toBe(false);
	});
});
