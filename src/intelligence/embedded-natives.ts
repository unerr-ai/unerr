/**
 * Committed PLACEHOLDER for the native pieces a compiled (Bun) binary embeds:
 * the cozo-node addon, the @parcel/watcher addon, and the tree-sitter `.wasm`
 * grammars. In the normal Node / tsup build this stub ships verbatim and is
 * NEVER read — every consumer reads these exports only behind a
 * `__UNERR_BINARY__` guard, and that flag is `false` in the tsup build (folded
 * out by esbuild's dead-code pass), so the stub's `null` / `{}` values can
 * never reach a caller.
 *
 * During `bun build --compile`, `scripts/build-binary.ts` REWRITES this file in
 * place with real `require("./native/*.node")` calls (Bun embeds the addon) and
 * `import … with { type: "file" }` wasm imports (Bun embeds the file and the
 * import resolves to a `/$bunfs/root/…` path at runtime), runs the compile, then
 * restores this committed version. Keeping every embed statement in this one
 * generated file is what lets the rest of the source stay build-tool-agnostic:
 * tsup sees an inert stub, Bun sees the real assets.
 *
 */

// The cozo-node N-API binding (`native.open_db`, `native.query_db`, …). `null`
// in a Node build; the real addon object in a compiled binary.
export const cozoNative: unknown = null;

// The @parcel/watcher N-API binding, pre-`createWrapper`. `null` in a Node
// build; the real addon object in a compiled binary.
export const watcherBinding: unknown = null;

// Maps a tree-sitter grammar name (plus the special key `__core__` for
// web-tree-sitter's own `tree-sitter.wasm`) to the embedded file path. Empty in
// a Node build; populated with `/$bunfs/root/…` paths in a compiled binary.
export const WASM_PATHS: Record<string, string> = {};
