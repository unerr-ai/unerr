/**
 * Main-thread proxy that presents the CozoDb surface (run / multiTransact /
 * close) but executes every query in a dedicated worker thread (cozo-worker.ts).
 * Because the worker owns cozo, a slow or wedged write blocks only the worker —
 * the proxy's MCP and /health event loop stay responsive. This is a drop-in for
 * the in-process CozoDb that CozoGraphStore holds as `this.db`; all query/write/
 * transact paths and every raw `graphStore.db.run(...)` route through here.
 *
 * @sem domain=native-binary role=db-client
 */
import { Worker } from "node:worker_threads";

// Build-time flag injected by tsup (`false`) and script/build-binary.ts (`true`),
// mirroring native-cozo.ts. Selects how the worker entry is referenced so Bun's
// standalone-compile embeds it (see defaultWorker below).
declare const __UNERR_BINARY__: boolean;

/** Liveness backstop for a single request; matches local-graph's tx timeout so
 *  a normal batch never trips it, a genuine hang rejects instead of wedging. */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** Consecutive request timeouts before the breaker trips to degraded fail-fast.
 *  Two back-to-back 120s timeouts already means the worker queue is jammed —
 *  every further enqueue would join the jam and pay the full timeout. */
const DEGRADE_AFTER_CONSECUTIVE_TIMEOUTS = 2;

/** Consecutive request timeouts before onPersistentDegradation fires. At the
 *  default request timeout this is ~5-8 minutes of a fully wedged data plane
 *  (observed live: 238 consecutive timeouts while /health kept answering) —
 *  the proxy's cue to recycle itself so boot can fold the WAL and start clean. */
const PERSISTENT_DEGRADATION_TIMEOUTS = 4;

interface PendingRequest {
  resolve: (value: WorkerReply) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface WorkerReply {
  id: number;
  ok: boolean;
  rows?: unknown[][];
  txId?: number;
  error?: string;
}

/** Minimal worker surface — lets tests inject a fake without a real thread. */
export interface WorkerLike {
  postMessage(msg: unknown): void;
  on(event: "message", cb: (msg: unknown) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "exit", cb: (code: number) => void): void;
  // biome-ignore lint/suspicious/noConfusingVoidType: unifies node's Worker.terminate (Promise<number>) with the void-returning test fake; the sole caller only awaits it
  terminate(): Promise<number> | void;
}

export interface CozoWorkerClientOptions {
  /** Absolute path to graph.db — passed to the worker as workerData. */
  dbPath: string;
  /** Test seam: build the worker (defaults to a real cozo-worker thread). */
  workerFactory?: () => WorkerLike;
  /** Per-request liveness ceiling in ms. */
  requestTimeoutMs?: number;
  /** Called when the worker dies unrecoverably (spawn/crash/exit != 0). */
  onFatal?: (err: Error) => void;
  /** Called ONCE when the worker has timed out PERSISTENT_DEGRADATION_TIMEOUTS
   *  consecutive times — the data plane is wedged while the process looks
   *  healthy. The proxy wires this to a clean self-recycle. */
  onPersistentDegradation?: (consecutiveTimeouts: number) => void;
}

/**
 * Spawns cozo-worker.ts and relays run / transaction requests to it over the
 * worker message port, resolving each reply by its correlation id.
 */
export class CozoWorkerClient {
  private readonly worker: WorkerLike;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private readonly readyPromise: Promise<void>;
  private closed = false;
  /** Set once the worker dies unrecoverably; every later request fails fast on it
   *  instead of queueing forever against a thread that will never reply. */
  private fatalError?: Error;
  private readonly requestTimeoutMs: number;
  private readonly onFatal?: (err: Error) => void;
  private readonly onPersistentDegradation?: (
    consecutiveTimeouts: number
  ) => void;
  /** Circuit breaker: consecutive request timeouts with no in-time reply. Any
   *  in-time reply (ok OR error — both prove the worker is draining) resets it. */
  private consecutiveTimeouts = 0;
  /** Tripped after DEGRADE_AFTER_CONSECUTIVE_TIMEOUTS: new requests reject
   *  fast instead of joining a jammed queue; one probe at a time is let
   *  through so recovery is detected the moment the worker drains. */
  private degraded = false;
  /** Request id of the single in-flight probe while degraded, else null. */
  private probeId: number | null = null;
  private persistentDegradationFired = false;

  constructor(opts: CozoWorkerClientOptions) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.onFatal = opts.onFatal;
    this.onPersistentDegradation = opts.onPersistentDegradation;
    this.worker = opts.workerFactory
      ? opts.workerFactory()
      : defaultWorker(opts.dbPath);

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.worker.on("message", (msg) =>
        this.onMessage(msg as WorkerReply & { type?: string }, resolve, reject)
      );
      // A pre-ready "error" (e.g. the worker module failed to RESOLVE — a
      // ModuleNotFound inside a compiled binary emits `error` then `exit 1`,
      // never a message) must reject ready() immediately. Leaving it pending
      // made every caller sit out its full spawn timeout and read the failure
      // as a generic "did not open within Nms" instead of the real cause.
      this.worker.on("error", (err) => {
        this.onWorkerDeath(err);
        reject(err);
      });
      this.worker.on("exit", (code) => {
        // ANY exit before close() is fatal — including code 0. A worker that
        // dies cleanly without ever posting "ready" (observed under the Bun
        // compiled binary) otherwise leaves ready() pending until the caller's
        // spawn timeout: a silent 15-30s stall instead of an immediate,
        // attributable error.
        if (!this.closed) {
          this.onWorkerDeath(new Error(`cozo worker exited with code ${code}`));
          reject(
            new Error(`cozo worker exited with code ${code} before ready`)
          );
        }
      });
    });
  }

  /** Resolves once the worker opened the db and armed its message loop. */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  private onMessage(
    msg: WorkerReply & { type?: string },
    signalReady: () => void,
    rejectReady: (err: Error) => void
  ): void {
    if (msg.type === "ready") {
      signalReady();
      return;
    }
    if (msg.type === "open-error") {
      const err = new Error(`cozo worker failed to open db: ${msg.error}`);
      rejectReady(err);
      this.failAll(err);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    // An in-time reply — even an error reply — proves the worker is draining.
    this.noteReply(msg.id);
    if (msg.ok) p.resolve(msg);
    else p.reject(new Error(msg.error ?? "cozo worker error"));
  }

  /** Reset the circuit breaker: the worker answered within the timeout. */
  private noteReply(id: number): void {
    this.consecutiveTimeouts = 0;
    if (id === this.probeId) this.probeId = null;
    if (this.degraded) {
      this.degraded = false;
      process.stderr.write(
        "[unerr] cozo db worker recovered — degraded fail-fast lifted\n"
      );
    }
  }

  /** Count a request timeout toward the breaker; trip degraded fail-fast and
   *  (once) the persistent-degradation callback at their thresholds. */
  private noteTimeout(id: number): void {
    this.consecutiveTimeouts += 1;
    if (id === this.probeId) this.probeId = null;
    if (
      !this.degraded &&
      this.consecutiveTimeouts >= DEGRADE_AFTER_CONSECUTIVE_TIMEOUTS
    ) {
      this.degraded = true;
      process.stderr.write(
        `[unerr] ⚠ cozo db worker degraded — ${this.consecutiveTimeouts} consecutive ${this.requestTimeoutMs}ms timeouts; rejecting new requests fast, probing one at a time until a reply lands\n`
      );
    }
    if (
      !this.persistentDegradationFired &&
      this.consecutiveTimeouts >= PERSISTENT_DEGRADATION_TIMEOUTS
    ) {
      this.persistentDegradationFired = true;
      this.onPersistentDegradation?.(this.consecutiveTimeouts);
    }
  }

  /** True while the breaker is open (new requests reject fast). */
  isDegraded(): boolean {
    return this.degraded;
  }

  private onWorkerDeath(err: Error): void {
    if (!this.fatalError) this.fatalError = err;
    this.failAll(err);
    this.onFatal?.(err);
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.probeId = null;
  }

  private request(payload: Record<string, unknown>): Promise<WorkerReply> {
    if (this.closed) {
      return Promise.reject(new Error("cozo worker client is closed"));
    }
    return this.postRequest(payload);
  }

  /** Post a request without the closed-guard — close() uses this to send its own
   *  final `close` op after it has flipped `closed` to block new callers. */
  private postRequest(payload: Record<string, unknown>): Promise<WorkerReply> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    // Breaker open + a probe already in flight → reject fast. Joining the
    // jammed queue would burn the full timeout AND add write load (observed
    // live: 238 consecutive 120s timeouts once a WAL death spiral started).
    if (this.degraded && this.probeId !== null) {
      return Promise.reject(
        new Error(
          `cozo worker degraded — ${this.consecutiveTimeouts} consecutive ${this.requestTimeoutMs}ms timeouts; rejected fast while a probe is in flight. Retry after the worker drains.`
        )
      );
    }
    const id = this.nextId++;
    return new Promise<WorkerReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.noteTimeout(id);
        reject(
          new Error(
            `cozo worker request timeout after ${this.requestTimeoutMs}ms`
          )
        );
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      // Breaker open and no probe in flight → this request IS the probe.
      if (this.degraded) this.probeId = id;
      try {
        this.worker.postMessage({ id, ...payload });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        if (id === this.probeId) this.probeId = null;
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  // ── CozoDb-shaped surface ───────────────────────────────────────

  async run(
    script: string,
    params?: Record<string, unknown>,
    immutable?: boolean
  ): Promise<{ rows: unknown[][] }> {
    await this.readyPromise;
    const res = await this.request({ op: "run", script, params, immutable });
    return { rows: res.rows ?? [] };
  }

  /** Mirrors native multiTransact: returns synchronously; the begin round-trip
   *  happens lazily on the tx proxy's first use (kept off the write chain's
   *  critical section — it is already serialized by CozoGraphStore). */
  multiTransact(write?: boolean): CozoTxProxy {
    const begin = this.readyPromise
      .then(() => this.request({ op: "tx-begin", write }))
      .then((r) => {
        if (typeof r.txId !== "number") {
          throw new Error("cozo worker tx-begin returned no txId");
        }
        return r.txId;
      });
    return new CozoTxProxy(this, begin);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Skip the graceful close op while degraded — it would queue behind the
    // jam and stall shutdown up to requestTimeoutMs. terminate() is safe:
    // SQLite in WAL mode is crash-consistent and boot folds the WAL.
    if (!this.degraded) {
      try {
        await this.postRequest({ op: "close" });
      } catch {
        /* worker may already be gone — terminate below regardless */
      }
    }
    try {
      await this.worker.terminate();
    } catch {
      /* best-effort */
    }
  }

  /** @internal — used by CozoTxProxy. */
  async _txRun(
    txId: number,
    script: string,
    params?: Record<string, unknown>
  ): Promise<{ rows: unknown[][] }> {
    const res = await this.request({ op: "tx-run", txId, script, params });
    return { rows: res.rows ?? [] };
  }

  /** @internal */
  async _txCommit(txId: number): Promise<void> {
    await this.request({ op: "tx-commit", txId });
  }

  /** @internal */
  async _txAbort(txId: number): Promise<void> {
    await this.request({ op: "tx-abort", txId });
  }
}

/**
 * Transaction proxy handed to CozoGraphStore.transact's runner. Holds the
 * pending begin round-trip; each run/commit awaits it, so the caller's callback
 * can run data-dependent logic on the main thread while the tx handle stays open
 * in the worker.
 */
export class CozoTxProxy {
  constructor(
    private readonly client: CozoWorkerClient,
    private readonly begin: Promise<number>
  ) {}

  async run(
    script: string,
    params?: Record<string, unknown>
  ): Promise<{ rows: unknown[][] }> {
    const txId = await this.begin;
    return this.client._txRun(txId, script, params);
  }

  async commit(): Promise<void> {
    const txId = await this.begin;
    await this.client._txCommit(txId);
  }

  /** Best-effort, fire-and-forget to mirror native's synchronous abort(). */
  abort(): void {
    this.begin
      .then((txId) => this.client._txAbort(txId))
      .catch(() => {
        /* the tx is discarded on the worker regardless */
      });
  }
}

/** Spawn the real cozo-worker thread.
 *
 * Two literal `new Worker(new URL(...))` branches, one per build kind — each
 * URL names where THAT build actually puts the compiled worker module:
 *   - Bun binary (`__UNERR_BINARY__` true): the `Bun.build({compile})` API
 *     embeds every entrypoint under `/$bunfs/root/<path-from-common-base>`
 *     with a `.js` name, INCLUDING the main module — with entrypoints
 *     `src/entrypoints/cli.ts` + `src/intelligence/cozo-worker.ts` (common
 *     base `src/`, see WORKER_ENTRY in scripts/build-binary.ts) this module
 *     evaluates as `file:///$bunfs/root/entrypoints/cli.js` and the worker
 *     lands at `/$bunfs/root/intelligence/cozo-worker.js`, one directory UP.
 *     (The `bun build --compile` CLI form differs: it collapses main to the
 *     bunfs root under the outfile name — do not copy layouts between forms.)
 *     Referencing the `.ts` source or the wrong directory resolves to a module
 *     bunfs does not carry: the spawn dies on ModuleNotFound and every binary
 *     silently fell back to the in-process db — the freeze protection was
 *     inert in shipped binaries (caught by `unerr doctor`'s Graph-DB-worker
 *     check; keep that check green in a fresh binary after touching this).
 *   - tsup/Node build: `./cozo-worker.js` resolves next to this module in dist
 *     (cozo-worker is a tsup entry → dist/cozo-worker.js beside dist/cli.js).
 * Under tsup the Bun branch's condition is `false`, so it folds out and its
 * URL is never evaluated.
 */
function defaultWorker(dbPath: string): WorkerLike {
  const options = { workerData: { dbPath } };
  if (typeof __UNERR_BINARY__ !== "undefined" && __UNERR_BINARY__) {
    // Bun single-file binary. Every entrypoint embeds under the bunfs root, so
    // the worker lands at `<root>/intelligence/cozo-worker.js`. This module is
    // NOT an entrypoint — with code-splitting (scripts/build-binary.ts,
    // `splitting:true`) it lands in a chunk at `<root>/chunk-*.js`, one level
    // shallower than the pre-split `<root>/entrypoints/cli.js`. A fixed `../`
    // hop is therefore wrong (it resolves to `/$bunfs/intelligence/…` and the
    // worker fails to load — silently degrading to the in-process db). Anchor to
    // the `/$bunfs/root/` marker instead, so the absolute worker path is correct
    // regardless of this module's split depth (verified: import.meta.url is
    // `file:///$bunfs/root/chunk-*.js` under Bun 1.3.x). Falls back to the older
    // `/$bunfs/` layout, then to a relative hop, for forward-compatibility.
    const u = import.meta.url;
    const rootMatch =
      u.match(/^.*\/\$bunfs\/root\//) ?? u.match(/^.*\/\$bunfs\//);
    const workerUrl = rootMatch
      ? new URL(`${rootMatch[0]}intelligence/cozo-worker.js`)
      : new URL("../intelligence/cozo-worker.js", u);
    return new Worker(workerUrl, options) as unknown as WorkerLike;
  }
  return new Worker(
    new URL("./cozo-worker.js", import.meta.url),
    options
  ) as unknown as WorkerLike;
}
