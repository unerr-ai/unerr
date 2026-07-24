/**
 * Self-spawn helpers — launch another unerr process correctly whether we are
 * running as `node dist/cli.js` or as a compiled Bun binary.
 *
 * Under Node, a child unerr is `node <argv[1]> <subcommand…>` (fork) — argv[1]
 * is the JS entrypoint. A compiled binary has no separate JS entrypoint: it
 * re-enters itself, so the child is `<this-binary> <subcommand…>` and there is
 * no module path to pass. Bun re-injects the argv[1] placeholder for compiled
 * binaries, so the child's `program.parse()` still sees the subcommand at the
 * usual offset.
 *
 * Every place that spawns a child unerr must route through here so the binary
 * build stays correct as new spawn sites appear.
 *
 */
import {
  type ChildProcess,
  type ForkOptions,
  type SpawnOptions,
  type StdioOptions,
  fork,
  spawn,
} from "node:child_process";

// `true` only in a compiled Bun binary (defined by scripts/build-binary.ts).
declare const __UNERR_BINARY__: boolean;

/** Whether this process is the compiled single-file binary (vs node + JS). */
export function isCompiledBinary(): boolean {
  return typeof __UNERR_BINARY__ !== "undefined" && __UNERR_BINARY__;
}

/**
 * Spawn a detached/normal child unerr with the given subcommand argv (e.g.
 * `["pm", "start", "--detached"]`). Mirrors a plain `spawn`, only resolving the
 * executable + leading argv per build kind.
 */
export function spawnUnerr(args: string[], opts: SpawnOptions): ChildProcess {
  if (isCompiledBinary()) {
    return spawn(process.execPath, args, opts);
  }
  const entry = process.argv[1];
  if (!entry)
    throw new Error("process.argv[1] undefined — cannot self-spawn unerr");
  return spawn(process.execPath, [entry, ...args], opts);
}

/**
 * Fork a child unerr over an IPC channel (used by the process manager for its
 * per-repo proxy children). Under Node this is `fork(entry, args)`. In a
 * compiled binary there is no module file to fork, so we spawn the binary with
 * an explicit `ipc` stdio slot — `process.send` / `'message'` work the same.
 */
export function forkUnerr(
  args: string[],
  opts: ForkOptions & { stdio?: StdioOptions } = {}
): ChildProcess {
  if (isCompiledBinary()) {
    const stdio: StdioOptions = opts.stdio ?? [
      "ignore",
      "ignore",
      "inherit",
      "ipc",
    ];
    return spawn(process.execPath, args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: opts.detached,
      stdio,
    });
  }
  const entry = process.argv[1];
  if (!entry) throw new Error("process.argv[1] undefined — cannot fork unerr");
  return fork(entry, args, opts);
}
