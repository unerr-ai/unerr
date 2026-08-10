/**
 * `unerr work` — the graph-free entry point for document hosts.
 *
 *   unerr work --mcp                  serve the five work tools over stdio
 *   unerr work hook pre-web-fetch     redirect a host web-fetch to fetch_url
 *
 * The command is routed straight from `src/entrypoints/cli.ts`, ahead of the
 * full Commander program, for the same reason the `hook` argv shape is: loading
 * `cli-main.ts` eagerly evaluates every command module and its transitive
 * dependencies (the tokenizer tables, the graph surface, the process-manager
 * client). A document sandbox has none of that installed and needs none of it,
 * so work mode pays for its own module graph and nothing else.
 *
 * WEB ACCESS (task 4b). `fetch_url` is the only web path in work mode. Three
 * things enforce it, in order of how often they apply:
 *   1. the catalog description says so outright;
 *   2. a `ur|act` signal names the exact `fetch_url(...)` call whenever a tool
 *      response surfaced a URL (`src/work/steering.ts`);
 *   3. on a host whose hook surface fires, `unerr work hook pre-web-fetch`
 *      denies the raw fetch and hands back the same call text.
 * All three render that call text with ONE builder — `buildFetchUrlSuggestion`
 * in `src/hooks/web-hooks.ts` — so the hook and the signal can never disagree.
 */

import type { Command } from "commander";

/** Hook events work mode understands. Anything else passes through untouched. */
const WORK_HOOK_EVENTS = new Set(["pre-web-fetch", "PreToolUse:WebFetch"]);

interface WorkOptions {
  readonly mcp?: boolean;
  readonly root?: string;
}

async function readStdin(): Promise<string> {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

/**
 * Register `unerr work` on a Commander program.
 */
export function registerWorkCommand(program: Command): void {
  const work = program
    .command("work")
    .description(
      "Graph-free MCP server for document work — no repo, no index, no daemon"
    )
    .option("--mcp", "Serve the work-mode tools over stdio (MCP)")
    .option(
      "--root <dir>",
      "Working folder tools operate on (default: current directory)"
    )
    .action(async (opts: WorkOptions) => {
      if (opts.mcp !== true) {
        process.stderr.write(
          "  unerr work is an MCP server. Run `unerr work --mcp`.\n"
        );
        process.exitCode = 1;
        return;
      }
      const { startWorkServer } = await import("../work/index.js");
      await startWorkServer({ root: opts.root });
      // startWorkServer resolves once the stdio transport is connected; the
      // process stays alive on the transport's own stdin listener.
    });

  work
    .command("hook <event>")
    .description(
      "Work-mode hook handler: reads the host's JSON payload on stdin, writes the hook response on stdout"
    )
    .action(async (event: string) => {
      const stdinJson = await readStdin();
      if (!WORK_HOOK_EVENTS.has(event)) {
        // Unknown event: pass through. A runtime hook must never break the host.
        process.stdout.write("{}");
        return;
      }
      // Reuses the shared handler, which builds its redirect with
      // `buildFetchUrlSuggestion` — the one steering-text builder in the repo.
      const { runPreWebFetchHook } = await import("../hooks/web-hooks.js");
      try {
        process.stdout.write(runPreWebFetchHook(stdinJson));
      } catch {
        process.stdout.write("{}");
      }
    });
}

/**
 * Build a one-command program for the `work` argv shape and run it. Called from
 * `src/entrypoints/cli.ts` so work mode never loads the full CLI.
 */
export async function runWorkCli(argv: readonly string[]): Promise<void> {
  const { Command } = await import("commander");
  const program = new Command()
    .name("unerr")
    .description("unerr — work mode")
    .helpOption("-h, --help", "Show help for `unerr work`");
  registerWorkCommand(program);
  await program.parseAsync([...argv]);
}
