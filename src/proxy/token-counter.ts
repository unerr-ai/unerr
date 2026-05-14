/**
 * Live Token Counter — accumulates tokens_saved across the session.
 *
 * Emits to stderr every N tool calls with a formatted summary.
 * Uses character/4 estimation (Sprint G upgrades to tiktoken).
 *
 * Design: pure accumulator with configurable emit interval and sink.
 * The sink defaults to process.stderr but can be injected for testing.
 */

export interface TokenCounterOptions {
  emitEveryN?: number;
  sink?: (message: string) => void;
}

export interface TokenCounter {
  record: (tokensSaved: number, totalTokens: number) => void;
  getTotalSaved: () => number;
  getTotalProcessed: () => number;
  getCallCount: () => number;
  getEfficiency: () => number;
  reset: () => void;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function createTokenCounter(
  options: TokenCounterOptions = {},
): TokenCounter {
  const emitEveryN = options.emitEveryN ?? 10;
  const sink = options.sink ?? ((msg: string) => process.stderr.write(msg));

  let totalSaved = 0;
  let totalProcessed = 0;
  let callCount = 0;

  function record(tokensSaved: number, totalTokens: number): void {
    totalSaved += tokensSaved;
    totalProcessed += totalTokens;
    callCount++;

    if (callCount > 0 && callCount % emitEveryN === 0) {
      const efficiency =
        totalProcessed > 0
          ? Math.round((totalSaved / totalProcessed) * 100)
          : 0;
      sink(
        `[unerr] ${formatTokens(totalSaved)} tokens saved (efficiency: ${efficiency}%)\n`,
      );
    }
  }

  function getTotalSaved(): number {
    return totalSaved;
  }

  function getTotalProcessed(): number {
    return totalProcessed;
  }

  function getCallCount(): number {
    return callCount;
  }

  function getEfficiency(): number {
    return totalProcessed > 0
      ? Math.round((totalSaved / totalProcessed) * 100)
      : 0;
  }

  function reset(): void {
    totalSaved = 0;
    totalProcessed = 0;
    callCount = 0;
  }

  return {
    record,
    getTotalSaved,
    getTotalProcessed,
    getCallCount,
    getEfficiency,
    reset,
  };
}
