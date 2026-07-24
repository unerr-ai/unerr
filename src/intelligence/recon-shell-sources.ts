/**
 * Recon read-only shell sources — E2 (the `shell:<cmd>` want kind).
 *
 * Lets `composeRecon` fold the output of a SMALL, read-only, allowlisted shell
 * command into the bundle — e.g. `shell:git log -n3 -- src/foo.ts` so the agent
 * sees "what changed here, recently" without a separate round-trip. The doc's
 * canonical use is git history/blame on the focus file.
 *
 * Security is the whole point of this module, so it is built in layers:
 *   1. Parse  — pull `shell:<cmd>` tokens out of the `want` array.
 *   2. Validate — `validateReadonlyShell` rejects anything that isn't an exact
 *      `git <read-only-subcommand> …` argv with NO shell metacharacters. It
 *      returns a parsed argv ARRAY (never a string), so the executor can run it
 *      with execFile — no shell, no interpolation, no word-splitting surprises.
 *   3. Execute — via an injected `ShellRunner`. This module NEVER imports
 *      child_process; like `recon-mcp-sources.ts` it stays pure and the caller
 *      injects the executor. Its mere PRESENCE is the capability signal — when
 *      no runner is injected, shell wants degrade to `dropped`, never run.
 *
 * Failure isolation is total, mirroring `fetchMcpSources`: each command runs
 * behind its own timeout + output cap; a hang/throw degrades that one entry to
 * a `dropped` reason and never blocks or fails the others. It never throws.
 */

import { MCP_SOURCE_BASE_PRIORITY } from "./recon-mcp-sources.js";

/** A parsed `shell:<cmd>` want token. */
export interface ShellWant {
  /** The command string after the `shell:` prefix, trimmed. */
  cmd: string;
  /** The original token verbatim, kept for titles/diagnostics. */
  raw: string;
}

/**
 * Runs ONE already-validated argv array, read-only, under the caller's timeout
 * and output cap. Injected by the caller (the proxy adapts execFile; tests use a
 * fake). May reject or hang — `fetchShellSources` provides the isolation.
 */
export type ShellRunner = (
  argv: string[],
  opts: { timeoutMs: number; maxBytes: number }
) => Promise<{ stdout: string; truncated: boolean }>;

export interface ShellSourceSection {
  /** Stable tool label, e.g. "shell::git-log". */
  tool: string;
  /** Short human label — the command, e.g. "git log -n3 -- src/foo.ts". */
  title: string;
  /** The command's stdout (capped). */
  data: unknown;
  /** Lowest-priority tier — folded in after every code ring, like MCP sources. */
  priority: number;
}

export interface ShellSourcesResult {
  sections: ShellSourceSection[];
  dropped: Array<{
    title: string;
    reason: "timeout" | "error" | "not_allowed";
  }>;
}

/** Per-command default wall-clock timeout. */
export const DEFAULT_SHELL_TIMEOUT_MS = 3_000;
/** Per-command stdout cap (bytes) — keeps one command from flooding the bundle. */
export const DEFAULT_SHELL_MAX_BYTES = 16_384;

/**
 * Read-only `git` subcommands that may appear as argv[1]. Every one of these
 * only inspects history/working-tree state — none mutate the repo, index, or
 * remote. Anything outside this set is rejected.
 */
const ALLOWED_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "log",
  "blame",
  "show",
  "diff",
  "shortlog",
  "status",
]);

/**
 * Shell metacharacters that could chain, redirect, expand, or escape a command.
 * Their mere presence rejects the command — we run a single argv, never a shell
 * line, so none of these are ever legitimate here.
 */
const SHELL_METACHARS = /[;&|<>$`(){}!*?\\"'\n\r]/;

/**
 * Flag fragments that let an otherwise read-only git subcommand WRITE a file
 * (e.g. `git diff --output=foo`). Rejected defensively even though the base
 * subcommand is read-only.
 */
const WRITE_FLAG = /^(-o|--output)(=|$)/;

export type ShellValidation =
  | { ok: true; argv: string[] }
  | { ok: false; reason: "not_allowed" };

/**
 * Validate a shell-want command string as an exact read-only git invocation and
 * return its argv array. Rejects shell metacharacters, non-git commands,
 * non-allowlisted subcommands, and file-writing flags.
 */
export function validateReadonlyShell(cmd: string): ShellValidation {
  const trimmed = cmd.trim();
  if (!trimmed) return { ok: false, reason: "not_allowed" };
  if (SHELL_METACHARS.test(trimmed))
    return { ok: false, reason: "not_allowed" };
  const argv = trimmed.split(/\s+/);
  if (argv[0] !== "git") return { ok: false, reason: "not_allowed" };
  const sub = argv[1];
  if (!sub || !ALLOWED_GIT_SUBCOMMANDS.has(sub)) {
    return { ok: false, reason: "not_allowed" };
  }
  for (const arg of argv.slice(2)) {
    if (WRITE_FLAG.test(arg)) return { ok: false, reason: "not_allowed" };
  }
  return { ok: true, argv };
}

/**
 * Pull `shell:<cmd>` tokens out of the agent's `want` array. The `shell:` prefix
 * is stripped; the remainder (which may itself contain colons, e.g.
 * `shell:git show HEAD~1:src/foo.ts`) is the command. Non-strings, empties, and
 * duplicates are dropped.
 */
export function parseShellWants(want: unknown): ShellWant[] {
  if (!Array.isArray(want)) return [];
  const out: ShellWant[] = [];
  const seen = new Set<string>();
  for (const item of want) {
    if (typeof item !== "string") continue;
    const raw = item.trim();
    if (!raw.toLowerCase().startsWith("shell:")) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    const cmd = raw.slice("shell:".length).trim();
    if (cmd) out.push({ cmd, raw });
  }
  return out;
}

/** Stable, label-safe tool id for a validated git command (e.g. "shell::git-log"). */
function shellToolId(argv: string[]): string {
  return `shell::git-${argv[1]}`;
}

/**
 * Fetch every shell want concurrently behind a per-command timeout + output cap,
 * folding the results in as the lowest-priority sections (after every MCP source
 * — shell history is context, not a code ring). Never throws: a disallowed,
 * timed-out, or failing command becomes a `dropped` entry.
 */
export async function fetchShellSources(
  wants: ShellWant[],
  runner: ShellRunner,
  opts: { timeoutMs?: number; maxBytes?: number; basePriority?: number } = {}
): Promise<ShellSourcesResult> {
  const sections: ShellSourceSection[] = [];
  const dropped: ShellSourcesResult["dropped"] = [];
  if (!wants.length) return { sections, dropped };

  const timeoutMs = opts.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_SHELL_MAX_BYTES;
  // Shell sources sink BELOW MCP sources — the +1000 offset keeps them last even
  // when many MCP sources are declared, without coupling to their exact count.
  const basePriority = opts.basePriority ?? MCP_SOURCE_BASE_PRIORITY + 1000;

  const results = await Promise.all(
    wants.map(async (w, i) => {
      const valid = validateReadonlyShell(w.cmd);
      if (!valid.ok) {
        return { kind: "dropped" as const, title: w.cmd, reason: valid.reason };
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
        });
        const run = runner(valid.argv, { timeoutMs, maxBytes });
        const res = await Promise.race([run, timeout]);
        const text =
          res.stdout + (res.truncated ? "\n… (output truncated)" : "");
        return {
          kind: "section" as const,
          section: {
            tool: shellToolId(valid.argv),
            title: w.cmd,
            data: text,
            priority: basePriority + i,
          },
        };
      } catch (err) {
        const reason: "timeout" | "error" =
          err instanceof Error && err.message === "timeout"
            ? "timeout"
            : "error";
        return { kind: "dropped" as const, title: w.cmd, reason };
      } finally {
        if (timer) clearTimeout(timer);
      }
    })
  );

  for (const r of results) {
    if (r.kind === "section") sections.push(r.section);
    else dropped.push({ title: r.title, reason: r.reason });
  }
  return { sections, dropped };
}
