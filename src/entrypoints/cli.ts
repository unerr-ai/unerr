#!/usr/bin/env node
/**
 * unerr — CLI entry (thin dispatch router).
 *
 * This file static-imports NOTHING heavy. Claude Code fires a fresh
 * `unerr hook <event>` subprocess on every tool call; routing that through the
 * full Commander program would eagerly evaluate all ~21 command modules and
 * their transitive deps (the gpt-tokenizer BPE tables, the graph surface),
 * paying a full cold CLI boot for a trivial nudge. So the `hook` argv shape is
 * split off here and served by a thin dispatcher (`cli-hook.ts`) that imports
 * only the single handler for the fired event; every other invocation loads the
 * full program (`cli-main.ts`). Both targets are dynamic-imported, so each path
 * evaluates only the module graph it needs.
 */

const args = process.argv.slice(2);

if (args[0] === "hook") {
  const { runHook } = await import("./cli-hook.js");
  await runHook(args.slice(1));
} else {
  const { main } = await import("./cli-main.js");
  await main();
}
