/**
 * Fast-path dispatcher for `unerr hook <event>`.
 *
 * Claude Code (and other IDEs) fire a fresh `unerr hook <event>` subprocess on
 * every tool call. Routing those through the full Commander program eagerly
 * evaluates all ~21 command modules and their transitive deps (the gpt-tokenizer
 * BPE tables, the graph surface), so even a trivial Bash pre-hook paid a full
 * cold CLI boot. `cli.ts` sees `hook` as argv[0] and dynamic-imports ONLY this
 * dispatcher, which in turn dynamic-imports ONLY the single handler module for
 * the fired event plus the light shared wrappers in `hook-runtime.ts`. Graph
 * work stays on the warm per-repo proxy via the UDS clients each handler already
 * uses — nothing here re-inits the graph.
 *
 * Any event not in the switch (help, a typo, a future event) falls through to
 * the full Commander program (`cli-main.ts`), which still carries
 * `registerHookCommand` for the direct-CLI path.
 */

import { safeAsyncHookAction, safeHookAction } from "./hook-runtime.js";

/**
 * Dispatch one hook event. `args` is argv after `hook` (e.g. `["pre-bash"]`, or
 * `["stop-persist", "--transcript", "/path"]`). Reads stdin, runs the single
 * matching handler via the shared safe wrappers, and writes result JSON to
 * stdout. Unknown / help / future events delegate to the full Commander program.
 */
export async function runHook(args: string[]): Promise<void> {
  // Dev-only: this fast-path bypasses the Commander `preAction` wall that runs
  // `applyDevConfig`, so trust the local dev entitlement key here too. Without
  // it a hook subprocess never trusts the dev `kid`, `loginBlocked()` returns
  // true (degraded_free), and every hook — including the Stop close-out — is
  // gated to "{}". Env-only (no cache write); the proxy owns minting. The whole
  // branch (and the `dev-mode.js` import) is compile-stripped in the published
  // build, so the production hook fast-path pays nothing.
  if (__UNERR_DEV_BUILD__) {
    const { trustDevKeyEnv } = await import("../cloud/dev-mode.js");
    trustDevKeyEnv(process.cwd());
  }

  switch (args[0]) {
    // ── PreToolUse ────────────────────────────────────────────
    case "pre-bash": {
      const { runPreBashHook } = await import("../hooks/shell-hooks.js");
      safeHookAction(runPreBashHook)();
      return;
    }
    case "pre-shell": {
      const { runPreShellHook } = await import("../hooks/shell-hooks.js");
      safeHookAction(runPreShellHook)();
      return;
    }
    case "pre-read": {
      const { runPreReadHook } = await import("../hooks/navigation-hooks.js");
      safeHookAction(runPreReadHook)();
      return;
    }
    case "pre-grep": {
      const { runPreGrepHook } = await import("../hooks/navigation-hooks.js");
      safeHookAction(runPreGrepHook)();
      return;
    }
    case "pre-glob": {
      const { runPreGlobHook } = await import("../hooks/navigation-hooks.js");
      safeHookAction(runPreGlobHook)();
      return;
    }
    case "pre-write": {
      const { runPreWriteHook } = await import("../hooks/navigation-hooks.js");
      safeHookAction(runPreWriteHook)();
      return;
    }
    case "pre-edit": {
      const { runPreEditHookAsync } = await import(
        "../hooks/navigation-hooks.js"
      );
      await safeAsyncHookAction(runPreEditHookAsync)();
      return;
    }
    case "pre-webfetch": {
      const { runPreWebFetchHook } = await import("../hooks/web-hooks.js");
      safeHookAction(runPreWebFetchHook)();
      return;
    }
    // ── PostToolUse ───────────────────────────────────────────
    case "post-read": {
      const { runPostReadHookAsync } = await import(
        "../hooks/navigation-hooks.js"
      );
      await safeAsyncHookAction(runPostReadHookAsync)();
      return;
    }
    case "post-grep": {
      const { runPostGrepHook } = await import("../hooks/navigation-hooks.js");
      safeHookAction(runPostGrepHook)();
      return;
    }
    case "post-glob": {
      const { runPostGlobHook } = await import("../hooks/navigation-hooks.js");
      safeHookAction(runPostGlobHook)();
      return;
    }
    case "post-websearch": {
      const { runPostWebSearchHook } = await import("../hooks/web-hooks.js");
      safeHookAction(runPostWebSearchHook)();
      return;
    }
    case "post-bash": {
      const { runPostBashHook } = await import("../hooks/shell-hooks.js");
      safeHookAction(runPostBashHook)();
      return;
    }
    case "post-write": {
      const { runPostWriteHook } = await import("../hooks/navigation-hooks.js");
      safeHookAction(runPostWriteHook)();
      return;
    }
    case "post-edit": {
      const { runPostEditHookAsync } = await import(
        "../hooks/navigation-hooks.js"
      );
      await safeAsyncHookAction(runPostEditHookAsync)();
      return;
    }
    // ── UserPromptSubmit ──────────────────────────────────────
    case "prompt-submit": {
      const { runUserPromptSubmitHookAsync } = await import(
        "../hooks/prompt-hooks.js"
      );
      await safeAsyncHookAction(runUserPromptSubmitHookAsync)();
      return;
    }
    // ── SessionStart ──────────────────────────────────────────
    case "session-start": {
      const { runSessionStartHookAsync } = await import(
        "../hooks/session-hooks.js"
      );
      await safeAsyncHookAction(runSessionStartHookAsync)();
      return;
    }
    // ── Stop / SubagentStop ───────────────────────────────────
    case "stop": {
      const { runStopHookHandlerAsync } = await import(
        "../hooks/stop-hooks.js"
      );
      await safeAsyncHookAction(runStopHookHandlerAsync)();
      return;
    }
    case "subagent-stop": {
      const { runSubagentStopHookHandlerAsync } = await import(
        "../hooks/stop-hooks.js"
      );
      await safeAsyncHookAction(runSubagentStopHookHandlerAsync)();
      return;
    }
  }

  // Unknown / help / typo / future event, or stop-persist without a transcript:
  // hand off to the full Commander program, which still carries
  // registerHookCommand for the direct-CLI path.
  const { main } = await import("./cli-main.js");
  await main();
}
