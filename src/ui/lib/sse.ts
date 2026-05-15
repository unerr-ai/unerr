import type { QueryClient } from "@tanstack/react-query";
import type { SessionStatsPayload } from "./types";

const FEED_KEY = ["live-feed"] as const;
const SESSION_KEY = ["session-snapshot"] as const;

export type LiveFeedItem = {
  t: number;
  type: string;
  data: unknown;
};

function safeParse(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
}

/**
 * Subscribes to the proxy SSE stream with exponential backoff reconnect.
 * Updates TanStack Query cache: live-feed, session-snapshot.
 */
export function connectDashboardSse(
  queryClient: QueryClient,
  onStatus: (connected: boolean) => void
): () => void {
  let stopped = false;
  let es: EventSource | null = null;
  let retryMs = 1000;
  const maxRetry = 30_000;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const pushFeed = (type: string, data: unknown) => {
    const item: LiveFeedItem = { t: Date.now(), type, data };
    queryClient.setQueryData<LiveFeedItem[]>(FEED_KEY, (prev = []) =>
      [...prev, item].slice(-100)
    );
  };

  const invalidateIntel = () => {
    void queryClient.invalidateQueries({ queryKey: ["intelligence"] });
  };

  const invalidateSessionDeep = () => {
    void queryClient.invalidateQueries({ queryKey: ["session"] });
  };

  const onNamed =
    (type: string) =>
    (ev: MessageEvent): void => {
      pushFeed(type, safeParse(ev.data as string));
      if (type === "drift") {
        invalidateIntel();
      }
      if (type === "intent") {
        invalidateSessionDeep();
      }
      if (type === "violation" || type === "circuit_breaker") {
        invalidateSessionDeep();
      }
    };

  const onSessionStats = (ev: MessageEvent) => {
    const d = safeParse(ev.data as string) as SessionStatsPayload;
    queryClient.setQueryData(SESSION_KEY, d);
    void queryClient.invalidateQueries({ queryKey: ["session"] });
  };

  const onPing = () => {
    /* keepalive only */
  };

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const scheduleReconnect = () => {
    clearTimer();
    if (stopped) return;
    timer = setTimeout(() => {
      retryMs = Math.min(retryMs * 2, maxRetry);
      connect();
    }, retryMs);
  };

  function connect() {
    if (stopped) return;
    es?.close();
    try {
      es = new EventSource("/api/stream");
    } catch {
      onStatus(false);
      scheduleReconnect();
      return;
    }

    es.onopen = () => {
      retryMs = 1000;
      onStatus(true);
    };

    es.onerror = () => {
      onStatus(false);
      es?.close();
      es = null;
      scheduleReconnect();
    };

    const types = [
      "tool_call",
      "drift",
      "violation",
      "circuit_breaker",
      "intent",
    ] as const;
    for (const t of types) {
      es.addEventListener(t, onNamed(t));
    }
    es.addEventListener("session_stats", onSessionStats);
    es.addEventListener("ping", onPing);
  }

  connect();

  return () => {
    stopped = true;
    clearTimer();
    es?.close();
    es = null;
    onStatus(false);
  };
}
