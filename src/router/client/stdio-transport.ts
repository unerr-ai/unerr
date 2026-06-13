/**
 * Stdio transport for downstream MCP servers.
 *
 * Spawns the child process, writes JSON-RPC frames to stdin,
 * reads JSON-RPC frames from stdout. stderr is captured for diagnostics.
 *
 * Framing: newline-delimited JSON (one JSON object per line).
 * This matches the MCP stdio transport spec.
 */

import { type ChildProcess, spawn } from "node:child_process";

import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  McpTransport,
  StdioTransportConfig,
  TransportState,
} from "./transport.js";

interface PendingRequest {
  resolve: (res: JsonRpcResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;

export class StdioTransport implements McpTransport {
  private readonly config: StdioTransportConfig;
  private child: ChildProcess | null = null;
  private _state: TransportState = "disconnected";
  private pending = new Map<string | number, PendingRequest>();
  private buffer = "";

  constructor(config: StdioTransportConfig) {
    this.config = config;
  }

  get state(): TransportState {
    return this._state;
  }

  async connect(): Promise<void> {
    if (this._state === "connected") return;
    this.setState("connecting");

    const env = {
      ...process.env,
      ...(this.config.env ?? {}),
    };

    this.child = spawn(this.config.command, [...this.config.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      windowsHide: true,
    });

    if (this.child.pid === undefined) {
      // spawn failed synchronously (ENOENT command, EACCES, …) — there is no
      // process behind the handle. Claiming "connected" here lets restart()
      // report success and reset health state for a server that cannot run.
      // Swallow the async "error" event the dead handle will still emit,
      // then surface the failure to the caller.
      this.child.on("error", () => {});
      this.child = null;
      this.setState("error");
      const err = new Error(
        `[${this.config.serverId}] failed to spawn "${this.config.command}"`
      );
      this.config.events.onError?.(err);
      throw err;
    }

    this.child.stdout!.setEncoding("utf-8");
    this.child.stdout!.on("data", (chunk: string) => this.onData(chunk));

    this.child.stderr!.setEncoding("utf-8");
    this.child.stderr!.on("data", (chunk: string) => {
      this.config.events.onError?.(
        new Error(`[${this.config.serverId}] stderr: ${chunk.trim()}`)
      );
    });

    this.child.on("exit", (code, signal) => {
      this.setState("error");
      this.rejectAllPending(
        new Error(
          `[${this.config.serverId}] process exited: code=${code} signal=${signal}`
        )
      );
    });

    this.child.on("error", (err) => {
      this.setState("error");
      this.config.events.onError?.(err);
      this.rejectAllPending(err);
    });

    this.setState("connected");
  }

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (!this.child || this._state !== "connected") {
      throw new Error(`[${this.config.serverId}] transport not connected`);
    }

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(
          new Error(
            `[${this.config.serverId}] request ${request.id} timed out after ${REQUEST_TIMEOUT_MS}ms`
          )
        );
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(request.id, { resolve, reject, timer });

      const frame = `${JSON.stringify(request)}\n`;
      this.child!.stdin!.write(frame, "utf-8", (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(request.id);
          reject(
            new Error(`[${this.config.serverId}] write error: ${err.message}`)
          );
        }
      });
    });
  }

  async close(): Promise<void> {
    this.rejectAllPending(
      new Error(`[${this.config.serverId}] transport closing`)
    );

    if (this.child) {
      // A child that never spawned (ENOENT command, spawn failure) has no
      // pid. ChildProcess.kill() on that handle signals pid 0 — the WHOLE
      // process group — so the caller SIGTERMs itself (observed as vitest
      // exit 144). Such a child also never emits "exit", so the wait below
      // would stall 3s and then SIGKILL the group. Skip signalling entirely.
      if (this.child.pid === undefined) {
        this.child = null;
        this.setState("disconnected");
        return;
      }

      this.child.stdin?.end();
      this.child.kill("SIGTERM");

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.child?.kill("SIGKILL");
          resolve();
        }, 3_000);

        this.child!.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      this.child = null;
    }

    this.setState("disconnected");
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop()!;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }

      if ("id" in msg && msg.id !== undefined && msg.id !== null) {
        const pending = this.pending.get(msg.id as string | number);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(msg.id as string | number);
          pending.resolve(msg as unknown as JsonRpcResponse);
        }
      } else if ("method" in msg) {
        this.config.events.onNotification?.(
          msg as unknown as JsonRpcNotification
        );
      }
    }
  }

  private setState(s: TransportState): void {
    this._state = s;
    this.config.events.onStateChange?.(s);
  }

  private rejectAllPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}
