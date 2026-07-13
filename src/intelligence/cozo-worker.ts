/**
 * Worker-thread entry that owns the real CozoDb for graph.db. The main thread
 * reaches it only through async messages (see cozo-worker-client.ts), so a slow
 * or wedged cozo write can stall only this worker — never the proxy's MCP and
 * /health event loop. It opens WAL + the cozo sqlite db in this thread, then
 * serves run / transaction requests keyed by id. Transaction handles stay open
 * here across the tx-run/commit/abort round-trips the client makes.
 *
 * @sem domain=native-binary role=db-worker
 */
import { parentPort, workerData } from "node:worker_threads";
import type { CozoDb } from "./cozo-schema.js";

interface WorkerOpenData {
  dbPath: string;
}

/** Requests the client posts in; every one carries a correlation `id`. */
type WorkerRequest =
  | {
      id: number;
      op: "run";
      script: string;
      params?: Record<string, unknown>;
      immutable?: boolean;
    }
  | { id: number; op: "tx-begin"; write?: boolean }
  | {
      id: number;
      op: "tx-run";
      txId: number;
      script: string;
      params?: Record<string, unknown>;
    }
  | { id: number; op: "tx-commit"; txId: number }
  | { id: number; op: "tx-abort"; txId: number }
  | { id: number; op: "close" };

/** Flatten a thrown value (cozo rejects with a parsed JSON report, not an Error). */
function errString(e: unknown): string {
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Boot-phase trace, enabled by UNERR_DB_WORKER_DEBUG=1 — stderr only, so it
 *  can never touch the MCP stdout channel. The worker's failure mode is
 *  otherwise a silent spawn timeout on the client; the phase line pinpoints
 *  which boot step never returned (module load / WAL / native ctor / open). */
function trace(phase: string): void {
  if (process.env.UNERR_DB_WORKER_DEBUG === "1") {
    process.stderr.write(`[cozo-worker] ${phase}\n`);
  }
}

async function main(): Promise<void> {
  trace("module loaded, main() entered");
  const port = parentPort;
  if (!port) throw new Error("cozo-worker must run inside a worker_thread");
  const { dbPath } = workerData as WorkerOpenData;

  let db: CozoDb;
  try {
    // The heavy modules load DYNAMICALLY, inside this try — never as static
    // imports. Static imports hoist into module evaluation, and a load failure
    // there (e.g. the native addon path inside a compiled binary) kills the
    // worker before `main()` runs: the client sees only a silent exit, no
    // error. Loading here instead funnels every failure into the "open-error"
    // message below, which carries the real cause back to the client.
    const { enableWalMode, checkpointWal } = await import("./persistent-db.js");
    const { getCozoDbCtor } = await import("./native-cozo.js");
    trace("heavy modules loaded");
    // WAL setup + fold must happen BEFORE cozo opens the file. In the in-process
    // path this lived in createSqliteDb; here it runs in this thread because cozo
    // now opens here.
    await enableWalMode(dbPath);
    await checkpointWal(dbPath);
    trace("wal setup done");
    const CozoDbCtor = await getCozoDbCtor();
    trace("native cozo ctor loaded");
    db = new CozoDbCtor("sqlite", dbPath) as CozoDb;
    trace("db opened");
  } catch (e) {
    port.postMessage({ type: "open-error", error: errString(e) });
    return;
  }

  // Live write transactions, kept open across the client's tx-run/commit/abort
  // round-trips. Keyed by a worker-assigned id so many callers never collide.
  type CozoTxHandle = ReturnType<NonNullable<CozoDb["multiTransact"]>>;
  const txs = new Map<number, CozoTxHandle>();
  let nextTxId = 1;

  port.on("message", async (msg: WorkerRequest) => {
    try {
      switch (msg.op) {
        case "run": {
          const res = await db.run(msg.script, msg.params, msg.immutable);
          port.postMessage({ id: msg.id, ok: true, rows: res.rows });
          break;
        }
        case "tx-begin": {
          if (typeof db.multiTransact !== "function") {
            throw new Error("cozo build lacks multiTransact");
          }
          const tx = db.multiTransact(!!msg.write);
          const txId = nextTxId++;
          txs.set(txId, tx);
          port.postMessage({ id: msg.id, ok: true, txId });
          break;
        }
        case "tx-run": {
          const tx = txs.get(msg.txId);
          if (!tx) throw new Error(`unknown txId ${msg.txId}`);
          const res = await tx.run(msg.script, msg.params);
          port.postMessage({ id: msg.id, ok: true, rows: res.rows });
          break;
        }
        case "tx-commit": {
          const tx = txs.get(msg.txId);
          if (!tx) throw new Error(`unknown txId ${msg.txId}`);
          await tx.commit();
          txs.delete(msg.txId);
          port.postMessage({ id: msg.id, ok: true });
          break;
        }
        case "tx-abort": {
          const tx = txs.get(msg.txId);
          if (tx) {
            try {
              tx.abort();
            } catch {
              /* abort is best-effort — an un-committed tx is discarded anyway */
            }
            txs.delete(msg.txId);
          }
          port.postMessage({ id: msg.id, ok: true });
          break;
        }
        case "close": {
          try {
            db.close?.();
          } catch {
            /* best-effort — process teardown follows */
          }
          port.postMessage({ id: msg.id, ok: true });
          break;
        }
      }
    } catch (e) {
      port.postMessage({ id: msg.id, ok: false, error: errString(e) });
    }
  });

  // Signal the client the db is open and the message loop is armed.
  port.postMessage({ type: "ready" });
}

main().catch((e) => {
  parentPort?.postMessage({ type: "open-error", error: errString(e) });
});
