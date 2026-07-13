/**
 * Cozo DB worker isolation — the permanent fix for the event-loop freeze.
 *
 * A slow/wedged cozo write used to block the Node main thread (cozo-node's
 * synchronous bounded-channel send), freezing the proxy's MCP + /health loop.
 * Moving cozo into a worker thread makes that structurally impossible: the main
 * thread only posts messages. These tests cover the client protocol with a fake
 * worker (deterministic) plus one end-to-end run against the real built worker +
 * a real cozo db, including the load-bearing property: a stalled worker request
 * never blocks the main event loop.
 */
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import {
  CozoWorkerClient,
  type WorkerLike,
} from "../intelligence/cozo-worker-client.js";

/** Scripted in-memory worker — captures posted messages and lets the test drive
 *  replies, worker death, and exit, with no real thread. */
class FakeWorker implements WorkerLike {
  sent: Array<Record<string, unknown>> = [];
  terminated = false;
  private msgCb?: (m: unknown) => void;
  private errCb?: (e: Error) => void;
  private exitCb?: (c: number) => void;
  /** Optional auto-responder invoked on every postMessage. */
  onSend?: (msg: Record<string, unknown>, self: FakeWorker) => void;

  postMessage(msg: unknown): void {
    const m = msg as Record<string, unknown>;
    this.sent.push(m);
    this.onSend?.(m, this);
  }
  on(event: "message" | "error" | "exit", cb: (arg: never) => void): void {
    if (event === "message") this.msgCb = cb as (m: unknown) => void;
    else if (event === "error") this.errCb = cb as (e: Error) => void;
    else this.exitCb = cb as (c: number) => void;
  }
  terminate(): void {
    this.terminated = true;
  }
  // ── test drivers ──
  emit(m: unknown): void {
    this.msgCb?.(m);
  }
  fail(e: Error): void {
    this.errCb?.(e);
  }
  exit(code: number): void {
    this.exitCb?.(code);
  }
}

function makeClient(
  fake: FakeWorker,
  opts: {
    requestTimeoutMs?: number;
    onFatal?: (e: Error) => void;
    onPersistentDegradation?: (n: number) => void;
  } = {}
): CozoWorkerClient {
  return new CozoWorkerClient({
    dbPath: "/unused/graph.db",
    workerFactory: () => fake,
    requestTimeoutMs: opts.requestTimeoutMs,
    onFatal: opts.onFatal,
    onPersistentDegradation: opts.onPersistentDegradation,
  });
}

describe("CozoWorkerClient (protocol, fake worker)", () => {
  it("run() resolves rows once the worker replies ok", async () => {
    const fake = new FakeWorker();
    fake.onSend = (m, self) => {
      if (m.op === "run") self.emit({ id: m.id, ok: true, rows: [[1], [2]] });
    };
    const client = makeClient(fake);
    fake.emit({ type: "ready" });
    const res = await client.run("?[x] <- [[1],[2]]");
    expect(res.rows).toEqual([[1], [2]]);
    // ready + run were the two posts
    expect(fake.sent.some((m) => m.op === "run")).toBe(true);
  });

  it("run() rejects with the worker's error message", async () => {
    const fake = new FakeWorker();
    fake.onSend = (m, self) => {
      if (m.op === "run")
        self.emit({ id: m.id, ok: false, error: "parse error near 'x'" });
    };
    const client = makeClient(fake);
    fake.emit({ type: "ready" });
    await expect(client.run("bad script")).rejects.toThrow(/parse error/);
  });

  it("multiTransact proxy sends begin → tx-run → tx-commit in order", async () => {
    const fake = new FakeWorker();
    fake.onSend = (m, self) => {
      if (m.op === "tx-begin") self.emit({ id: m.id, ok: true, txId: 7 });
      else if (m.op === "tx-run")
        self.emit({ id: m.id, ok: true, rows: [["ok"]] });
      else if (m.op === "tx-commit") self.emit({ id: m.id, ok: true });
    };
    const client = makeClient(fake);
    fake.emit({ type: "ready" });
    const tx = client.multiTransact(true);
    const r = await tx.run("?[v] <- [[1]] :put rel {v}");
    expect(r.rows).toEqual([["ok"]]);
    await tx.commit();
    const ops = fake.sent.map((m) => m.op).filter(Boolean);
    expect(ops).toEqual(["tx-begin", "tx-run", "tx-commit"]);
    // tx-run + tx-commit carried the worker-assigned txId
    expect(fake.sent.find((m) => m.op === "tx-run")?.txId).toBe(7);
    expect(fake.sent.find((m) => m.op === "tx-commit")?.txId).toBe(7);
  });

  it("a request that never gets a reply rejects on the timeout", async () => {
    const fake = new FakeWorker(); // no onSend → worker never replies
    const client = makeClient(fake, { requestTimeoutMs: 40 });
    fake.emit({ type: "ready" });
    await expect(client.run("?[x] <- [[1]]")).rejects.toThrow(/timeout/i);
  });

  it("worker death rejects all in-flight requests and calls onFatal", async () => {
    const fake = new FakeWorker(); // never replies on its own
    let fatal: Error | undefined;
    const client = makeClient(fake, {
      onFatal: (e) => {
        fatal = e;
      },
    });
    fake.emit({ type: "ready" });
    const p = client.run("?[x] <- [[1]]");
    fake.fail(new Error("worker crashed"));
    await expect(p).rejects.toThrow(/worker crashed/);
    expect(fatal?.message).toMatch(/worker crashed/);
  });

  it("open-error rejects ready() and fails pending work", async () => {
    const fake = new FakeWorker();
    const client = makeClient(fake);
    fake.emit({ type: "open-error", error: "db is corrupt" });
    await expect(client.ready()).rejects.toThrow(/db is corrupt/);
  });

  it("close() posts close and terminates the worker", async () => {
    const fake = new FakeWorker();
    fake.onSend = (m, self) => {
      if (m.op === "close") self.emit({ id: m.id, ok: true });
    };
    const client = makeClient(fake);
    fake.emit({ type: "ready" });
    await client.close();
    expect(fake.sent.some((m) => m.op === "close")).toBe(true);
    expect(fake.terminated).toBe(true);
  });
});

// Circuit breaker — the fix for the single-writer WAL death spiral, where 238
// consecutive 120s request timeouts each queued MORE work behind a jammed
// worker. After 2 consecutive timeouts the client rejects new requests fast,
// letting exactly one probe through at a time; a reply lifts the breaker;
// sustained timeouts fire onPersistentDegradation once (proxy self-recycle).
describe("CozoWorkerClient (degraded fail-fast circuit breaker)", () => {
  /** Drive the client into degraded: two concurrent never-answered requests. */
  async function tripBreaker(client: CozoWorkerClient): Promise<void> {
    const r1 = client.run("?[x] <- [[1]]");
    const r2 = client.run("?[x] <- [[2]]");
    await expect(r1).rejects.toThrow(/timeout/i);
    await expect(r2).rejects.toThrow(/timeout/i);
  }

  it("two consecutive timeouts trip the breaker; further requests reject fast while a probe is in flight", async () => {
    const fake = new FakeWorker(); // never replies
    const client = makeClient(fake, { requestTimeoutMs: 30 });
    fake.emit({ type: "ready" });
    await tripBreaker(client);
    expect(client.isDegraded()).toBe(true);

    // First request after tripping becomes the probe (posted to the worker)…
    const probe = client.run("?[x] <- [[3]]");
    // …the next rejects instantly without touching the worker.
    await expect(client.run("?[x] <- [[4]]")).rejects.toThrow(/degraded/);
    const runPosts = fake.sent.filter((m) => m.op === "run");
    expect(runPosts.length).toBe(3); // r1, r2, probe — never the fast-rejected one
    await expect(probe).rejects.toThrow(/timeout/i);
  });

  it("a probe reply lifts the breaker and requests flow again", async () => {
    const fake = new FakeWorker();
    const client = makeClient(fake, { requestTimeoutMs: 30 });
    fake.emit({ type: "ready" });
    await tripBreaker(client);
    expect(client.isDegraded()).toBe(true);

    // Worker drains: start answering.
    fake.onSend = (m, self) => {
      if (m.op === "run") self.emit({ id: m.id, ok: true, rows: [["ok"]] });
    };
    const probed = await client.run("?[x] <- [[5]]");
    expect(probed.rows).toEqual([["ok"]]);
    expect(client.isDegraded()).toBe(false);
    // Normal traffic resumes — no fast rejection.
    const after = await client.run("?[x] <- [[6]]");
    expect(after.rows).toEqual([["ok"]]);
  });

  it("onPersistentDegradation fires exactly once after sustained consecutive timeouts", async () => {
    const fake = new FakeWorker(); // never replies
    const fired: number[] = [];
    const client = makeClient(fake, {
      requestTimeoutMs: 20,
      onPersistentDegradation: (n) => fired.push(n),
    });
    fake.emit({ type: "ready" });
    await tripBreaker(client); // 2 consecutive timeouts
    expect(fired).toEqual([]);

    // Probes 3 and 4 also time out → threshold (4) reached, callback fires once.
    await expect(client.run("?[x] <- [[7]]")).rejects.toThrow(/timeout/i);
    await expect(client.run("?[x] <- [[8]]")).rejects.toThrow(/timeout/i);
    expect(fired).toEqual([4]);

    // A fifth timeout must NOT fire it again.
    await expect(client.run("?[x] <- [[9]]")).rejects.toThrow(/timeout/i);
    expect(fired).toEqual([4]);
  });

  it("close() while degraded skips the graceful close op and terminates immediately", async () => {
    const fake = new FakeWorker(); // never replies
    const client = makeClient(fake, { requestTimeoutMs: 20 });
    fake.emit({ type: "ready" });
    await tripBreaker(client);
    expect(client.isDegraded()).toBe(true);

    await client.close(); // must not wait requestTimeoutMs on a close op
    expect(fake.sent.some((m) => m.op === "close")).toBe(false);
    expect(fake.terminated).toBe(true);
  });
});

// The real-worker path needs the built artifact (dist/cozo-worker.js). Present
// after `pnpm run build`; skipped in a raw source-only checkout.
const builtWorker = fileURLToPath(
  new URL("../../dist/cozo-worker.js", import.meta.url)
);
const hasBuild = existsSync(builtWorker);

describe.skipIf(!hasBuild)("CozoWorkerClient (real worker + real cozo)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function realClient(): CozoWorkerClient {
    dir = mkdtempSync(join(tmpdir(), "unerr-cozow-"));
    return new CozoWorkerClient({
      dbPath: join(dir, "graph.db"),
      workerFactory: () =>
        new Worker(builtWorker, {
          workerData: { dbPath: join(dir, "graph.db") },
        }),
    });
  }

  it("opens a real cozo db, writes, reads back, and commits a transaction", async () => {
    const client = realClient();
    await client.ready();
    await client.run(":create tw {k: String => v: Int}");
    await client.run('?[k,v] <- [["a",1],["b",2]] :put tw {k => v}');
    const read = await client.run("?[k,v] := *tw{k,v}", undefined, true);
    expect(read.rows.length).toBe(2);
    const tx = client.multiTransact(true);
    await tx.run('?[k,v] <- [["c",3]] :put tw {k => v}');
    await tx.commit();
    const after = await client.run("?[k,v] := *tw{k,v}", undefined, true);
    expect(after.rows.length).toBe(3);
    await client.close();
  });

  it("keeps the main event loop responsive while a worker request is in flight", async () => {
    const client = realClient();
    await client.ready();
    await client.run(":create big {k: Int => v: Int}");
    // Fire a write and, without awaiting it, prove the main loop still ticks —
    // a setImmediate scheduled after the postMessage runs before the db reply.
    const write = client.run("?[k,v] <- [[1,1],[2,2],[3,3]] :put big {k => v}");
    const loopTicked = await new Promise<boolean>((res) =>
      setImmediate(() => res(true))
    );
    expect(loopTicked).toBe(true); // main thread was never blocked
    await write;
    await client.close();
  });
});
