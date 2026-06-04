/**
 * Strategy T6 — key=value (env, printenv) and Key: Value compression.
 * Drops noisy keys, truncates long values, shortens PATH.
 * Handles both KEY=VALUE format (env) and Key: Value format (kubectl describe, systemctl).
 */

/** Keys to drop from colon-format output (k8s/systemd noise). */
const DROP_COLON_KEYS = new Set([
  "managedFields",
  "resourceVersion",
  "selfLink",
  "uid",
  "creationTimestamp",
  "generation",
  "ownerReferences",
  "finalizers",
  "kubectl.kubernetes.io/last-applied-configuration",
  "deployment.kubernetes.io/revision",
  "control-plane.alpha.kubernetes.io/leader",
]);

const DROP_KEYS = new Set([
  // PWD/shell state
  "OLDPWD",
  "SHLVL",
  "_",
  "PWD",
  // Terminal noise
  "LS_COLORS",
  "LESSOPEN",
  "LESSCLOSE",
  "LSCOLORS",
  "TERM",
  "TERM_PROGRAM",
  "TERM_SESSION_ID",
  "COLORTERM",
  "CLICOLOR",
  "CLICOLOR_FORCE",
  "FORCE_COLOR",
  // Locale
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_COLLATE",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  // System noise
  "HOSTNAME",
  "LOGNAME",
  "DISPLAY",
  "XDG_SESSION_TYPE",
  "XDG_RUNTIME_DIR",
  "XDG_DATA_DIRS",
  "XDG_CONFIG_DIRS",
  "DBUS_SESSION_BUS_ADDRESS",
  "DESKTOP_SESSION",
  // SSH/GPG
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GPG_AGENT_INFO",
  "GPG_TTY",
  // Shell internals
  "SHELL",
  "BASH_VERSION",
  "ZSH_VERSION",
  "HISTSIZE",
  "HISTFILESIZE",
  "HIST_STAMPS",
  "SAVEHIST",
  "HISTCONTROL",
  "HISTFILE",
  // Misc
  "MANPATH",
  "INFOPATH",
  "MAIL",
]);

const VALUE_MAX = 200;

/** Compress colon-format output (kubectl describe, systemctl status, etc.) */
function compressColonFormat(lines: string[]): string {
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const colonMatch = /^(\s{0,4})([\w][\w\s./-]*):\s*(.*)$/.exec(line);
    if (!colonMatch) {
      if (line.trim()) kept.push(line.trimEnd());
      i++;
      continue;
    }

    const [, indent, key, value] = colonMatch;
    const keyTrimmed = key?.trim();

    // Drop noisy k8s keys
    if (keyTrimmed && DROP_COLON_KEYS.has(keyTrimmed)) {
      i++;
      // Skip indented child lines
      const childIndent = (indent?.length ?? 0) + 2;
      while (i < lines.length) {
        const nextLine = lines[i]!;
        if (nextLine.trim() === "") {
          i++;
          break;
        }
        const nextIndent = nextLine.match(/^(\s*)/)?.[1]?.length ?? 0;
        if (nextIndent < childIndent && nextLine.trim()) break;
        i++;
      }
      continue;
    }

    // Check for indented sub-block
    const childIndent = (indent?.length ?? 0) + 2;
    let childCount = 0;
    let j = i + 1;
    while (j < lines.length) {
      const nextLine = lines[j]!;
      if (nextLine.trim() === "") break;
      const nextInd = nextLine.match(/^(\s*)/)?.[1]?.length ?? 0;
      if (nextInd < childIndent) break;
      childCount++;
      j++;
    }

    if (childCount > 10 && !value?.trim()) {
      // Collapse large sub-blocks
      kept.push(`${indent}${keyTrimmed}: [${childCount} entries]`);
      i = j;
    } else {
      // Truncate long values
      let val = value ?? "";
      if (val.length > VALUE_MAX) {
        val = `${val.slice(0, 100)}…(${val.length} chars)`;
      }
      kept.push(val ? `${indent}${keyTrimmed}: ${val}` : line.trimEnd());
      i++;
    }
  }
  return kept.join("\n");
}

export function compressKeyValue(raw: string, command?: string): string {
  const lines = raw.split("\n");

  // Detect format: KEY=VALUE vs Key: Value
  const equalsCount = lines.filter((l) => /^[A-Za-z_]\w*=/.test(l)).length;
  const colonCount = lines.filter((l) =>
    /^\s{0,4}[A-Za-z][\w\s-]*:\s/.test(l)
  ).length;

  // Nothing to compress: input has no key=value or key:value rows. The
  // classifier sometimes maps a `git`/`kubectl` subcommand to key_value
  // (correct hint) even when the actual output is a single bare word
  // (e.g. `git branch --show-current` → "main\n") — passthrough verbatim.
  if (colonCount === 0 && equalsCount === 0) return raw;

  if (colonCount > equalsCount) {
    const body = compressColonFormat(lines);
    const clipped =
      body.length > 8000
        ? `${body.slice(0, 5000)}\n…kv_omitted…\n${body.slice(-2000)}`
        : body;
    return clipped;
  }

  // Original KEY=VALUE format handling
  void command;
  const kept: string[] = [];
  for (const line of lines) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) {
      if (line.trim()) kept.push(line.trimEnd());
      continue;
    }
    const key = m[1];
    let val = m[2] ?? "";
    if (!key || DROP_KEYS.has(key)) continue;

    // Shorten PATH
    if (key === "PATH" && val.length > VALUE_MAX) {
      const parts = val.split(":");
      val = `${parts.slice(0, 3).join(":")}:…:${parts.length} segments`;
    } else if (val.length > VALUE_MAX) {
      val = `${val.slice(0, 100)}…(${val.length} chars)`;
    }

    kept.push(`${key}=${val}`);
  }
  const body = kept.join("\n");
  const clipped =
    body.length > 8000
      ? `${body.slice(0, 5000)}\n…kv_omitted…\n${body.slice(-2000)}`
      : body;
  return clipped;
}
