/**
 * unerr cloud — best-effort OS notification (surfacing Tier 3).
 *
 * The reliable auth-surfacing channel is in-band through the agent (Tier 1)
 * and the local UI / `unerr status` (Tier 2). This OS notification is a *bonus*
 * only: DBUS/DISPLAY on Linux and toast availability on Windows make it
 * genuinely unreliable (see `.internal/LOGIN_UX_STRATEGY.md` §5), so it is
 * fired fire-and-forget and is never the sole signal for any state.
 *
 * Invariants: never throws, never blocks (the child is detached + unref'd, all
 * stdio ignored), never carries anything sensitive. A missing notifier binary
 * or a headless session is a silent no-op — exactly the best-effort contract.
 */

import { spawn } from "node:child_process";
import { platform } from "node:os";

/** Spawn a notifier fully detached so it can never keep the daemon alive or
 *  surface an error. Any spawn failure (missing binary, no permission) is
 *  swallowed — best-effort by contract. */
function spawnDetached(command: string, args: string[]): void {
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    // A missing binary emits 'error' asynchronously — absorb it so it never
    // becomes an unhandled rejection / crash.
    child.on("error", () => {});
    child.unref();
  } catch {
    /* best-effort — never throw */
  }
}

/** Escape a string for safe embedding inside an AppleScript double-quoted
 *  literal (backslash + double-quote are the only metacharacters). */
function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Escape a string for a single-quoted PowerShell literal (only the single
 *  quote needs doubling). */
function escapePowerShell(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Show an OS notification with the given title + body, best-effort. Returns
 * immediately; the notifier runs detached. No-ops silently on a headless
 * session or when the platform notifier is unavailable.
 */
export function osNotify(title: string, body: string): void {
  try {
    switch (platform()) {
      case "darwin": {
        const script = `display notification "${escapeAppleScript(
          body
        )}" with title "${escapeAppleScript(title)}"`;
        spawnDetached("osascript", ["-e", script]);
        return;
      }
      case "linux": {
        // No display server → no notification daemon to talk to. Bail quietly
        // rather than spawn a doomed `notify-send`.
        if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;
        spawnDetached("notify-send", ["--app-name=unerr", title, body]);
        return;
      }
      case "win32": {
        // Balloon tip via System.Windows.Forms — present on stock Windows, no
        // external module. Best-effort; a Server Core box without the assembly
        // just no-ops via the swallowed spawn error.
        const t = escapePowerShell(title);
        const b = escapePowerShell(body);
        const ps =
          "Add-Type -AssemblyName System.Windows.Forms;" +
          "$n = New-Object System.Windows.Forms.NotifyIcon;" +
          "$n.Icon = [System.Drawing.SystemIcons]::Information;" +
          "$n.BalloonTipTitle = '" +
          t +
          "';$n.BalloonTipText = '" +
          b +
          "';$n.Visible = $true;$n.ShowBalloonTip(8000);" +
          "Start-Sleep -Seconds 9;$n.Dispose()";
        spawnDetached("powershell", [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-Command",
          ps,
        ]);
        return;
      }
    }
  } catch {
    /* best-effort — never throw */
  }
}
