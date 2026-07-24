/**
 * Proxy session registry — the in-memory, proxy-only half of the dual
 * session-id model (SESSION_ID_CORRELATION Part 1). The on-disk half (the
 * shared `.unerr/state/sessions.json` records the hook upserts and writers
 * read) lives in `src/tracking/session-records.ts`.
 *
 * Two ids name one coding-agent conversation:
 *   - `unerr_session_id` — unerr's own per-bridge UUID (minted by the bridge,
 *     announced in `unerr/hello`). Always present; the stable idempotency /
 *     fallback grouping key.
 *   - `native_session_id` — the agent's OWN id (Claude `session_id`, Cursor
 *     `conversation_id`), captured by the prompt hook from its payload. Present
 *     only for hook-capable agents; the PRIMARY grouping key.
 *
 * One proxy serves N bridges (one per conversation) over UDS, so the single
 * ShadowLedger session id can no longer name a conversation. This registry maps
 * each `clientId` to the per-bridge UUID the bridge announced, mints a fallback
 * for any client that never said hello, and attaches the agent's
 * `native_session_id` from the shared file so proxy-side and hook-side events
 * of one conversation group under `coalesce(native_session_id,
 * unerr_session_id)`.
 *
 */

import {
  NativeSessionResolver,
  mintUnerrSessionId,
} from "../tracking/session-records.js";

/** Resolved identity the proxy stamps on an event for one client. */
export interface ResolvedSessionIdentity {
  sessionId: string;
  nativeSessionId: string | null;
  sessionName: string | null;
  agent: string | null;
}

/**
 * In-memory, proxy-only registry of live bridge connections. One per proxy
 * process. Maps `clientId → {unerrSessionId, agent}` from `unerr/hello`, mints a
 * fallback id for any client that never said hello, and resolves the full
 * identity (attaching the hook-written `native_session_id` / `session_name`
 * from the shared file) to stamp on each event.
 */
export class ProxySessionRegistry {
  private readonly byClient = new Map<
    string,
    { unerrSessionId: string; agent: string | null }
  >();
  /** Fallback when there is no clientId at all (standalone stdio path). */
  private readonly fallbackSessionId: string;
  private readonly nativeResolver: NativeSessionResolver;

  constructor(unerrDir: string, fallbackSessionId: string) {
    this.fallbackSessionId = fallbackSessionId;
    this.nativeResolver = new NativeSessionResolver(unerrDir);
  }

  /** Record a bridge's announced identity from `unerr/hello`. Mints a session
   *  id if the bridge sent none (older bridge). Idempotent; updates the agent
   *  on a later hello (e.g. when the agent flag arrives after connect). */
  registerHello(
    clientId: string,
    input: { unerrSessionId?: string | null; agent?: string | null }
  ): void {
    const prior = this.byClient.get(clientId);
    this.byClient.set(clientId, {
      unerrSessionId:
        input.unerrSessionId ?? prior?.unerrSessionId ?? mintUnerrSessionId(),
      agent: input.agent ?? prior?.agent ?? null,
    });
  }

  /** Update the agent for a client (MCP initialize handshake). */
  setAgent(clientId: string, agent: string): void {
    if (!agent?.trim()) return;
    const prior = this.byClient.get(clientId);
    this.byClient.set(clientId, {
      unerrSessionId: prior?.unerrSessionId ?? mintUnerrSessionId(),
      agent,
    });
  }

  /** The per-bridge unerr session id for a client (mint-and-store on first
   *  sight). Falls back to the proxy's process id when `clientId` is absent. */
  sessionIdFor(clientId: string | undefined): string {
    if (!clientId) return this.fallbackSessionId;
    const entry = this.byClient.get(clientId);
    if (entry) return entry.unerrSessionId;
    const minted = mintUnerrSessionId();
    this.byClient.set(clientId, { unerrSessionId: minted, agent: null });
    return minted;
  }

  /** The full identity to stamp on an event from a client: the unerr session
   *  id always, plus the agent's native id + conversation name when the hook
   *  has recorded them for this client's agent in this repo. */
  resolve(clientId: string | undefined, cwd: string): ResolvedSessionIdentity {
    const sessionId = this.sessionIdFor(clientId);
    const agent = clientId
      ? (this.byClient.get(clientId)?.agent ?? null)
      : null;
    let nativeSessionId: string | null = null;
    let sessionName: string | null = null;
    if (agent) {
      const native = this.nativeResolver.resolve(agent, cwd);
      if (native) {
        nativeSessionId = native.nativeSessionId;
        sessionName = native.sessionName;
      }
    }
    return { sessionId, nativeSessionId, sessionName, agent };
  }
}
