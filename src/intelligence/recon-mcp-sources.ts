/**
 * Recon MCP sources — Sprint 3 (T2/T3).
 *
 * The dormant MCP gateway (src/router/) can proxy N downstream MCP servers
 * (github, postgres, supabase, slack, …). This module is the *recon-side
 * consumer* of that gateway: it lets `composeRecon` fan out, server-side, to
 * the external sources the agent declared in its `want` array — e.g.
 * `want:["postgres:orders","github:pr/45"]` — and fold the results in as
 * lowest-priority sections (filled only after the code rings are placed).
 *
 * It is built behind the `unerr enable mcp-router` switch: the caller passes
 * `opts.enabled`, and when the router is off EVERY declared source degrades to
 * a `dropped` entry rather than touching the (possibly-unspawned) gateway.
 *
 * Failure isolation is total. The gateway is unreliable by construction — a
 * downstream server can hang, reject, or be unreachable. Each source is fetched
 * concurrently behind its own per-source wall-clock timeout (Promise.race), so
 * a single slow/broken server degrades to a `dropped` "timeout"/"error" entry
 * and NEVER blocks or fails the others. `fetchMcpSources` never throws.
 *
 * Like `recon.ts`, this module is deliberately pure: it never touches CozoDB,
 * the proxy, the UDS socket, or the router's ConnectionManager/Forwarder
 * directly. The caller injects a `gatewayRunner(server, op, args)` — in the
 * proxy that adapts the router `Forwarder` (see integration notes at bottom),
 * in tests it is a fake. That keeps the orchestration logic unit-testable in
 * isolation and the gateway wiring out of the recon hot path.
 */

/** One declared source from the agent's `want` array, e.g. "postgres:orders". */
export interface WantEntry {
  /** The source kind / server namespace, lowercased & trimmed (e.g. "postgres"). */
  kind: string;
  /** The ref after the first colon, if any (may itself contain colons), else null. */
  ref: string | null;
  /** The original token verbatim (trimmed), kept for diagnostics/titles. */
  raw: string;
}

/**
 * Invokes one op on one downstream MCP server through the gateway. May reject
 * or hang — `fetchMcpSources` provides the timeout + isolation around it. The
 * caller injects an adapter over the router `Forwarder` (see integration notes).
 */
export type GatewayRunner = (
  server: string,
  op: string,
  args: Record<string, unknown>
) => Promise<unknown>;

export interface McpSourceSection {
  /** The downstream tool/op label (e.g. "postgres::schema"). */
  tool: string;
  /** Short human label, e.g. "postgres:orders". */
  title: string;
  /** Raw structured payload returned by the downstream server. */
  data: unknown;
  /** Lower = more actionable. External sources are >= 7 (filled after code rings). */
  priority: number;
}

export interface McpSourcesResult {
  sections: McpSourceSection[];
  dropped: Array<{
    title: string;
    reason: "timeout" | "error" | "unknown_kind";
  }>;
}

/**
 * Base priority for the FIRST external source. External sources are the
 * lowest-priority sections in a recon bundle — they fill only after every
 * code ring (notes=0, bodies=1, callers=2, search=3, conventions=4,
 * get_conventions=3) has been placed. Each subsequent source
 * sinks one notch below the previous, preserving the agent's declared order
 * under budget pressure (the budget pass keeps lower-priority first).
 */
export const MCP_SOURCE_BASE_PRIORITY = 7;

/** Per-source default timeout, used when a caller omits `opts.timeoutMs`. */
export const DEFAULT_MCP_SOURCE_TIMEOUT_MS = 3_000;

/**
 * One declared external kind mapped to the downstream op the gateway should
 * invoke and the args it should carry. Returning `null` means the kind is not
 * a known external source — the caller records it as `dropped` "unknown_kind".
 */
interface KindPlan {
  /** Downstream server id / namespace the gateway addresses (e.g. "postgres"). */
  server: string;
  /** Downstream op (MCP tool name) to call on that server. */
  op: string;
  /** Args for the op, derived from the entry's ref. */
  args: Record<string, unknown>;
}

/**
 * Map a declared `WantEntry` to a concrete gateway call. Only a curated set of
 * kinds is wired; anything else returns null (-> "unknown_kind"). The op names
 * are the conventional MCP tool names downstream servers expose; the gateway's
 * aliasing layer (src/router/aliasing.ts) resolves the namespace, so we pass
 * the canonical server id here, not the short alias.
 *
 * Wired kinds:
 *   - postgres / supabase  -> schema fetch (`get_schema`), ref => table filter
 *   - github               -> issue/PR fetch (`get_issue`), ref => issue/PR locator
 */
export function planKind(entry: WantEntry): KindPlan | null {
  const kind = entry.kind.toLowerCase();
  switch (kind) {
    case "postgres":
    case "supabase":
      return {
        server: kind,
        op: "get_schema",
        args: entry.ref ? { table: entry.ref } : {},
      };
    case "github":
      return {
        server: "github",
        op: "get_issue",
        args: entry.ref ? { ref: entry.ref } : {},
      };
    default:
      return null;
  }
}

/**
 * Parse the public `want` arg into structured entries.
 *
 * Accepts an array of closed-vocab tokens. Each token is `<kind>` or
 * `<kind>:<ref>` — split on the FIRST colon only, so a ref may itself contain
 * colons (`github:pr/45` -> kind 'github', ref 'pr/45'; `linear:proj:ABC` ->
 * kind 'linear', ref 'proj:ABC'). Tokens are whitespace-trimmed, empties
 * dropped, and deduped (by the trimmed raw token). Non-string items are
 * skipped. Unknown/garbage kinds are KEPT as entries — the caller decides
 * whether they map to a source ('code' is a valid kind; callers filter it out
 * before `fetchMcpSources`).
 */
export function parseWantEntries(want: unknown): WantEntry[] {
  if (!Array.isArray(want)) return [];

  const entries: WantEntry[] = [];
  const seen = new Set<string>();

  for (const item of want) {
    if (typeof item !== "string") continue; // invalid item — skip
    const raw = item.trim();
    if (raw.length === 0) continue; // empty — drop
    if (seen.has(raw)) continue; // dedupe on trimmed raw token
    seen.add(raw);

    const colon = raw.indexOf(":");
    if (colon === -1) {
      entries.push({ kind: raw, ref: null, raw });
      continue;
    }

    const kind = raw.slice(0, colon).trim();
    const ref = raw.slice(colon + 1).trim();
    entries.push({
      kind,
      // A trailing/empty ref ("postgres:") collapses to null.
      ref: ref.length > 0 ? ref : null,
      raw,
    });
  }

  return entries;
}

/**
 * Race a promise against a wall-clock timeout. Resolves `{ timedOut:false,
 * value }` if `p` settles first, or `{ timedOut:true }` if the timer wins. The
 * timer is always cleared so a slow downstream call can't leak a handle. A
 * rejection from `p` propagates (the caller maps it to "error").
 */
async function raceTimeout<T>(
  p: Promise<T>,
  timeoutMs: number
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  try {
    const winner = await Promise.race([
      p.then((value) => ({ timedOut: false as const, value })),
      timeout,
    ]);
    return winner;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fetch declared external sources concurrently through the gateway, with
 * per-source timeout and degrade-to-omitted isolation.
 *
 * The CALLER decides whether to call this at all: it is invoked only when a
 * real downstream gateway exists (capability presence — never a toggle). When
 * no gateway is present the external path is simply not walked, so there is no
 * "disabled" state to report.
 *
 * @param entries        Declared sources — caller has already filtered out the
 *                       'code' kind (that is served by the local code rings).
 * @param gatewayRunner  Injected gateway op invoker. May reject or hang.
 * @param opts.timeoutMs Per-source wall-clock cap. A source exceeding it
 *                       degrades to `dropped` "timeout" and never blocks others.
 *
 * Never throws — isolation is total. Each source's fate (section vs. dropped)
 * is independent; one timeout/rejection cannot affect any sibling.
 */
export async function fetchMcpSources(
  entries: WantEntry[],
  gatewayRunner: GatewayRunner,
  opts: { timeoutMs: number }
): Promise<McpSourcesResult> {
  const sections: McpSourceSection[] = [];
  const dropped: McpSourcesResult["dropped"] = [];

  const timeoutMs =
    opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_MCP_SOURCE_TIMEOUT_MS;

  // One independent outcome per entry. Each carries the entry index so the
  // declared order maps to a stable, monotonically-sinking priority below.
  type Outcome =
    | { ok: true; index: number; title: string; plan: KindPlan; data: unknown }
    | {
        ok: false;
        index: number;
        title: string;
        reason: "timeout" | "error" | "unknown_kind";
      };

  const outcomes = await Promise.all(
    entries.map(async (entry, index): Promise<Outcome> => {
      const plan = planKind(entry);
      if (!plan) {
        return { ok: false, index, title: entry.raw, reason: "unknown_kind" };
      }

      try {
        const raced = await raceTimeout(
          gatewayRunner(plan.server, plan.op, plan.args),
          timeoutMs
        );
        if (raced.timedOut) {
          return { ok: false, index, title: entry.raw, reason: "timeout" };
        }
        return { ok: true, index, title: entry.raw, plan, data: raced.value };
      } catch {
        // Any rejection (server down, gateway error, malformed response) —
        // isolated to this source.
        return { ok: false, index, title: entry.raw, reason: "error" };
      }
    })
  );

  // Preserve declared order in the output; priority sinks one notch per source
  // so the budget pass (lower kept first) honours the agent's ordering.
  for (const outcome of outcomes) {
    if (outcome.ok) {
      sections.push({
        tool: `${outcome.plan.server}::${outcome.plan.op}`,
        title: outcome.title,
        data: outcome.data,
        priority: MCP_SOURCE_BASE_PRIORITY + outcome.index,
      });
    } else {
      dropped.push({ title: outcome.title, reason: outcome.reason });
    }
  }

  return { sections, dropped };
}
