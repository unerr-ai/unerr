/**
 * Shell-style `~` expansion for tool path arguments.
 *
 * Agents routinely pass `~/.zshrc`-style paths to file tools (they mirror
 * what a user typed). `path.resolve(cwd, "~/.zshrc")` treats `~` as a
 * literal directory name and yields `<repo>/~/.zshrc` → "File not found".
 * Every tool that resolves a caller-supplied path against `cwd` goes
 * through {@link resolveWithHome} so the expansion is uniform.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Expand a leading `~` (alone) or `~/` / `~\` to the user's home dir. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

/** `path.resolve(cwd, p)` with shell-style `~` expansion applied first. */
export function resolveWithHome(cwd: string, p: string): string {
  return resolve(cwd, expandHome(p));
}
