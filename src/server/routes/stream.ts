/**
 * Layer 7: SSE endpoint for real-time dashboard updates.
 *
 * GET /api/stream — Server-Sent Events transport.
 *
 * Lifecycle:
 *   1. Send backfill (last 20 events from circular buffer)
 *   2. Subscribe to EventBus for live events
 *   3. Send keepalive ping every 25s
 *   4. On disconnect: unsubscribe, cleanup
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  type SessionStats,
  totalCaughtEvents,
} from "../../proxy/session-stats.js";
import { eventBus } from "../event-bus.js";

export interface StreamRouteDeps {
  stats: SessionStats;
}

export function createStreamRoutes(deps: StreamRouteDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    return streamSSE(c, async (stream) => {
      let id = 0;
      let aborted = false;

      stream.onAbort(() => {
        aborted = true;
      });

      // 1. Send initial session stats
      await stream.writeSSE({
        id: String(++id),
        event: "session_stats",
        data: JSON.stringify({
          tool_calls: deps.stats.toolCallsLocal,
          tokens_saved: deps.stats.estimatedTokensSaved,
          violations_caught: deps.stats.violationsCaught,
          risk_warnings: deps.stats.riskWarningsIssued,
          duration_s: Math.round(
            (Date.now() - deps.stats.sessionStartedAt) / 1000,
          ),
          session_events: deps.stats.events,
          caught_total: totalCaughtEvents(deps.stats.events),
        }),
      });

      // 2. Backfill recent events
      const recent = eventBus.getRecentEvents(20);
      for (const event of recent) {
        if (aborted) return;
        await stream.writeSSE({
          id: String(++id),
          event: event.type,
          data: JSON.stringify(event.data),
        });
      }

      // 3. Subscribe to live events
      const unsubscribe = eventBus.subscribe(async (event) => {
        if (aborted) return;
        try {
          await stream.writeSSE({
            id: String(++id),
            event: event.type,
            data: JSON.stringify(event.data),
          });
        } catch {
          aborted = true;
        }
      });

      // 4. Keepalive ping every 25s
      const pingInterval = setInterval(async () => {
        if (aborted) {
          clearInterval(pingInterval);
          return;
        }
        try {
          await stream.writeSSE({
            id: String(++id),
            event: "ping",
            data: JSON.stringify({}),
          });
        } catch {
          aborted = true;
          clearInterval(pingInterval);
        }
      }, 25_000);

      // 5. Session stats tick every 30s
      const statsInterval = setInterval(async () => {
        if (aborted) {
          clearInterval(statsInterval);
          return;
        }
        try {
          await stream.writeSSE({
            id: String(++id),
            event: "session_stats",
            data: JSON.stringify({
              tool_calls: deps.stats.toolCallsLocal,
              tokens_saved: deps.stats.estimatedTokensSaved,
              violations_caught: deps.stats.violationsCaught,
              risk_warnings: deps.stats.riskWarningsIssued,
              duration_s: Math.round(
                (Date.now() - deps.stats.sessionStartedAt) / 1000,
              ),
              session_events: deps.stats.events,
              caught_total: totalCaughtEvents(deps.stats.events),
            }),
          });
        } catch {
          aborted = true;
          clearInterval(statsInterval);
        }
      }, 30_000);

      // Block until client disconnects
      while (!aborted) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Cleanup
      clearInterval(pingInterval);
      clearInterval(statsInterval);
      unsubscribe();
    });
  });

  return app;
}
