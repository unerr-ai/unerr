/**
 * Fan one tool call out from the home repo's proxy to its federatable sibling
 * repos and collect labeled per-peer results. The home proxy is the only legal
 * coordinator (the bridge imports no intelligence; the daemon owns none), so all
 * scatter-gather lives here: tier gate, per-peer lazy ensure, bounded-concurrency
 * fan-out with per-peer timeout, a per-peer circuit breaker, and partial-result
 * degradation. Per-tool merge/ranking is the caller's job — this stays generic.
 *
 */
import type {
  PeerEntry,
  PeersOkResponse,
  WorkspaceRefusedResponse,
} from "../../daemon/protocol.js";
import { resolveOwningRepo } from "./owning-repo.js";
import { DEFAULT_PEER_CALL_TIMEOUT_MS, callPeerTool } from "./peer-client.js";

/** Max peers queried concurrently — bounds the fan-out fork width. */
export const DEFAULT_PEER_CONCURRENCY = 4;

/** Consecutive failures on one peer before its breaker trips open. */
export const BREAKER_FAILURE_THRESHOLD = 3;

/** How long a tripped breaker stays open before a half-open trial (ms). */
export const BREAKER_COOLDOWN_MS = 30_000;

/** A single peer's result, tagged with its identity for downstream merge. */
export interface PeerResult {
  repoId: string;
  label: string;
  path: string;
  /** The peer tool's MCP result, or null when the peer was unreachable. */
  result: unknown | null;
}

/** Outcome of a single-peer path route (implicit cross-repo file routing). */
export type PathRouteResult =
  | { routed: false; refused?: WorkspaceRefusedResponse }
  | { routed: true; peer: PeerEntry; result: unknown };

/** Outcome of a fan-out: labeled peer results plus degradation flags. */
export interface FanOutResult {
  /** Successful peer results (result !== null), in completion-stable order. */
  results: PeerResult[];
  /** True when ≥1 peer was skipped, timed out, or failed — results incomplete. */
  partial: boolean;
  /** Set when the daemon refused workspace scope (free tier). Home-only then. */
  refused?: WorkspaceRefusedResponse;
}

/** Injectable collaborators — real ones in prod, fakes in tests. */
export interface CoordinatorDeps {
  /** Ask the daemon for the home repo's federatable peers (or a refusal). */
  getPeers: (
    homeRepo: string
  ) => Promise<PeersOkResponse | WorkspaceRefusedResponse | null>;
  /** Wake a sleeping peer and return its live socket, or null on failure. */
  ensurePeer: (peer: PeerEntry) => Promise<string | null>;
  /** Drive one tool call on a peer's socket; null on any failure. */
  callPeer: (
    sock: string,
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number
  ) => Promise<unknown | null>;
  /** Monotonic-ish clock for breaker cooldown math (injectable for tests). */
  now: () => number;
}

interface BreakerState {
  failures: number;
  /** When open, the timestamp the cooldown ends; 0 when closed/half-open. */
  openUntil: number;
}

/** Tunables for a single fan-out call. */
export interface FanOutOptions {
  homeRepo: string;
  toolName: string;
  /** Tool arguments — `scope` is forced to `'repo'` so peers never re-federate. */
  args: Record<string, unknown>;
  concurrency?: number;
  timeoutMs?: number;
}

/**
 * Scatter-gather across federated peers with a per-peer circuit breaker. One
 * instance lives per home proxy so breaker state survives across tool calls;
 * keying breakers by repoId means a flapping peer is skipped machine-wide, not
 * re-probed on every query.
 *
 */
export class FederationCoordinator {
  private readonly deps: CoordinatorDeps;
  private readonly breakers = new Map<string, BreakerState>();

  constructor(deps: CoordinatorDeps) {
    this.deps = deps;
  }

  /**
   * Fan `toolName` out to every federatable peer and collect labeled results.
   * Free tier short-circuits to a refusal (no peers queried). Each peer is
   * lazily ensured, called with `scope:'repo'` forced on, and gated by its
   * breaker; any skip/timeout/failure flips `partial` so the caller can warn.
   */
  async fanOut(opts: FanOutOptions): Promise<FanOutResult> {
    const peersResp = await this.deps.getPeers(opts.homeRepo);

    // Daemon unreachable → no peers known. Home-only, not "partial" (we never
    // had a peer set to be incomplete against).
    if (peersResp === null) {
      return { results: [], partial: false };
    }
    // Free tier → structured refusal; caller degrades to home-only + nudge.
    if (!peersResp.ok) {
      return { results: [], partial: false, refused: peersResp };
    }

    const allPeers = peersResp.peers;
    if (allPeers.length === 0) {
      return { results: [], partial: false };
    }

    // Peers whose breaker is open (and still cooling) are skipped this round —
    // skipping them at all makes the result partial.
    const now = this.deps.now();
    const eligible: PeerEntry[] = [];
    let partial = false;
    for (const peer of allPeers) {
      if (this.isOpen(peer.repoId, now)) {
        partial = true;
        continue;
      }
      eligible.push(peer);
    }

    // Peer args always carry scope:'repo'. A peer that re-read 'workspace' would
    // recurse into its own siblings — unbounded fan-out. Forcing it here is the
    // recursion backstop, independent of whatever the caller passed.
    const peerArgs: Record<string, unknown> = { ...opts.args, scope: "repo" };
    const timeoutMs = opts.timeoutMs ?? DEFAULT_PEER_CALL_TIMEOUT_MS;
    const concurrency = Math.max(
      1,
      opts.concurrency ?? DEFAULT_PEER_CONCURRENCY
    );

    const results: PeerResult[] = [];
    let cursor = 0;
    const runWorker = async (): Promise<void> => {
      while (cursor < eligible.length) {
        const peer = eligible[cursor++];
        if (!peer) break;
        const ok = await this.queryPeer(
          peer,
          opts.toolName,
          peerArgs,
          timeoutMs
        );
        if (ok === null) {
          partial = true;
          continue;
        }
        results.push({
          repoId: peer.repoId,
          label: peer.label,
          path: peer.path,
          result: ok,
        });
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, eligible.length) },
      () => runWorker()
    );
    await Promise.all(workers);

    return { results, partial };
  }

  /**
   * Ensure one peer is awake, call the tool, and fold the outcome into its
   * breaker. Returns the tool result, or null when the peer can't be reached or
   * the call failed (caller marks the fan-out partial). NEVER throws: a single
   * peer's transport fault must degrade the fan-out to partial, not reject the
   * whole `Promise.all` and fail the query. The production `callPeer`
   * (`callPeerTool`) already resolves null on every failure, but a throwing
   * `ensurePeer`/`callPeer` is caught here so the contract holds regardless.
   */
  private async queryPeer(
    peer: PeerEntry,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number
  ): Promise<unknown | null> {
    try {
      // Prefer the live socket from discovery; ensure only when asleep.
      let sock = peer.running && peer.sock ? peer.sock : null;
      if (!sock) {
        sock = await this.deps.ensurePeer(peer);
      }
      if (!sock) {
        this.recordFailure(peer.repoId);
        return null;
      }

      const result = await this.deps.callPeer(sock, toolName, args, timeoutMs);
      if (result === null) {
        this.recordFailure(peer.repoId);
        return null;
      }
      this.recordSuccess(peer.repoId);
      return result;
    } catch {
      this.recordFailure(peer.repoId);
      return null;
    }
  }

  /**
   * Route a single path-bearing call (e.g. `file_read`) to the peer that owns
   * `filePath`, when the path resolves outside the home repo into a federated
   * sibling. Returns `{routed:false}` when no peer owns the path, the daemon is
   * unreachable, the peer's breaker is open, or free tier refuses — the caller
   * then falls back to the home graph. `scope:'repo'` is forced on the peer call.
   */
  async routeByPath(opts: {
    homeRepo: string;
    toolName: string;
    args: Record<string, unknown>;
    filePath: string;
  }): Promise<PathRouteResult> {
    const peersResp = await this.deps.getPeers(opts.homeRepo);
    if (peersResp === null) return { routed: false };
    if (!peersResp.ok) return { routed: false, refused: peersResp };

    const resolution = resolveOwningRepo(
      opts.filePath,
      opts.homeRepo,
      peersResp.peers
    );
    if (resolution.owner !== "peer") return { routed: false };

    // resolution.peer is one of peersResp.peers (full PeerEntry) — find it back
    // by id to recover the typed running/sock fields the resolver dropped.
    const peer = peersResp.peers.find(
      (p) => p.repoId === resolution.peer.repoId
    );
    if (!peer) return { routed: false };
    if (this.isOpen(peer.repoId, this.deps.now())) return { routed: false };

    const peerArgs: Record<string, unknown> = { ...opts.args, scope: "repo" };
    const result = await this.queryPeer(
      peer,
      opts.toolName,
      peerArgs,
      DEFAULT_PEER_CALL_TIMEOUT_MS
    );
    if (result === null) return { routed: false };
    return { routed: true, peer, result };
  }

  /** True when the peer's breaker is open and still inside its cooldown. */
  private isOpen(repoId: string, now: number): boolean {
    const b = this.breakers.get(repoId);
    if (!b || b.openUntil === 0) return false;
    if (now >= b.openUntil) {
      // Cooldown elapsed → half-open: allow one trial through (openUntil
      // cleared, failure count kept so a re-trip is immediate on failure).
      b.openUntil = 0;
      return false;
    }
    return true;
  }

  /** A clean call resets the peer's breaker to fully closed. */
  private recordSuccess(repoId: string): void {
    this.breakers.delete(repoId);
  }

  /** A failed call increments the breaker; the threshold trips it open. */
  private recordFailure(repoId: string): void {
    const b = this.breakers.get(repoId) ?? { failures: 0, openUntil: 0 };
    b.failures += 1;
    if (b.failures >= BREAKER_FAILURE_THRESHOLD) {
      b.openUntil = this.deps.now() + BREAKER_COOLDOWN_MS;
    }
    this.breakers.set(repoId, b);
  }
}

/**
 * Build a coordinator wired to the real daemon client + peer transport. The
 * caller supplies the home daemon socket and an `ensureRepo`-backed waker (the
 * coordinator can't import the daemon client's heavier ensure path directly
 * without risking a cycle, so the waker is injected at the call site).
 *
 */
export function createFederationCoordinator(wiring: {
  getPeers: CoordinatorDeps["getPeers"];
  ensurePeer: CoordinatorDeps["ensurePeer"];
  now?: () => number;
}): FederationCoordinator {
  return new FederationCoordinator({
    getPeers: wiring.getPeers,
    ensurePeer: wiring.ensurePeer,
    callPeer: callPeerTool,
    now: wiring.now ?? (() => Date.now()),
  });
}
