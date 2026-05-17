/**
 * Sprint P1-6: Router onboarding banner.
 *
 * Shown on first activation to explain what was changed in the IDE config.
 * Dismissible — state persisted in localStorage.
 */

import { useState } from "react";

const STORAGE_KEY = "unerr_router_onboarding_dismissed";

interface RouterOnboardingProps {
  readonly proxiedCount: number;
  readonly agentName: string;
}

export function RouterOnboarding({ proxiedCount, agentName }: RouterOnboardingProps) {
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(STORAGE_KEY) === "true",
  );

  if (dismissed) return null;

  function handleDismiss() {
    localStorage.setItem(STORAGE_KEY, "true");
    setDismissed(true);
  }

  return (
    <div className="relative rounded-lg border border-violet-500/30 bg-violet-500/5 p-5">
      <button
        type="button"
        onClick={handleDismiss}
        className="absolute right-3 top-3 text-zinc-500 hover:text-zinc-300 transition-colors"
        aria-label="Dismiss"
      >
        <svg className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor">
          <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
        </svg>
      </button>

      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-violet-500/20">
          <svg className="h-4 w-4 text-violet-400" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm6.5-.25A.75.75 0 017.25 7h1a.75.75 0 01.75.75v2.75h.25a.75.75 0 010 1.5h-2a.75.75 0 010-1.5h.25v-2h-.25a.75.75 0 01-.75-.75zM8 6a1 1 0 100-2 1 1 0 000 2z" />
          </svg>
        </div>

        <div className="flex-1">
          <h3 className="text-sm font-semibold text-zinc-100">
            MCP Router Activated
          </h3>
          <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">
            unerr is now the single MCP endpoint for{" "}
            <span className="font-medium text-zinc-300">{agentName}</span>.
            Your {proxiedCount} MCP server{proxiedCount !== 1 ? "s are" : " is"}{" "}
            proxied through unerr — the agent sees all tools through one connection.
          </p>

          <div className="mt-3 space-y-1.5 text-xs text-zinc-500">
            <p className="flex items-center gap-2">
              <span className="text-emerald-400">✓</span>
              Tools dynamically curated based on context (fewer tokens, better reasoning)
            </p>
            <p className="flex items-center gap-2">
              <span className="text-emerald-400">✓</span>
              Bypasses client tool caps (e.g., Cursor&apos;s 40-tool limit)
            </p>
            <p className="flex items-center gap-2">
              <span className="text-emerald-400">✓</span>
              Original config backed up to <code className="text-zinc-400">*.pre-router</code>
            </p>
          </div>

          <p className="mt-3 text-[10px] text-zinc-600">
            Revert anytime: <code>unerr disable mcp-router</code>
          </p>
        </div>
      </div>
    </div>
  );
}
