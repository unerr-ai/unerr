# Runtime Fixes Tracker — orphan proxy, dashboard, auto-spawn

Internal tracker for the "unerr is not working / dashboard offline" investigation
(2026-05-25). Diagnosed with built-in tools only (unerr MCP intentionally not used —
the per-repo proxy was wedged). Update the status boxes as each fix lands.

## Observed symptoms

- `unerr pm status` → `Dashboard: offline`, all repos `○ offline`.
- unerrd (process manager) **not running**: no `~/.unerr/unerrd.sock`, no `~/.unerr/unerrd.pid`.
- A `--daemon-child` (per-repo proxy) **pid 91123, PPID=1** — orphaned, alive ~1.5h.
- Bridge (`unerr --mcp`, pid 9065) logs `Bridging to running proxy (PID 91123)` —
  connected directly to the orphan, so unerrd was never re-spawned.
- proxy.log: one caught `⚠ [watcher] Drift processing failed: CozoDB write timeout after 10000ms` (pid 91123).
- unerrd.log: `[unerr-cli] stopped: code=null, signal=SIGABRT` (earlier), then `Shutting down: shutdown command` → `Shutdown complete.` (the rebuild).

## Failure chain (root cause)

1. Rebuild → "shutdown command" kills the running unerrd.
2. The per-repo proxy child (91123) was spawned by an *earlier* unerrd and only *adopted*
   by socket (`Bridging to running proxy`), so the shutting-down unerrd had **no process
   handle** to reap it (`shutdownChild` can only kill children it forked).
3. The orphan should self-exit on parent death, but its only parent-death detector is a
   60s `unref()`'d PPID poll (cli.ts:860-869) — fragile: slow, and silent if the event
   loop is blocked by a wedged CozoDB write.
4. Orphan lingers with a live `proxy.sock`. New bridges discover that socket and connect
   directly → unerrd never re-spawned → dashboard offline + tools routed to a stale,
   possibly-wedged proxy.

---

## Issues

### [x] Issue 1 — `pm status` offline message wrongly recommends `unerr pm start`
- **Severity:** Medium (UX / correctness — contradicts zero-extra-commands design).
- **Where:** `src/commands/pm.ts` (status action, Dashboard offline branch).
- **Old text:** `offline — run unerr pm start to serve it at <url>`.
- **New text:** `offline — starts automatically when an AI coding chat session connects, then serves at <url>`.
- **Verify:** `node dist/cli.js pm status` shows the new wording when unerrd is down (after rebuild).
- **Status:** DONE (code). Pure string change — no behaviour change.

### [x] Issue 2 — orphaned per-repo proxy doesn't self-exit on parent death
- **Severity:** High — direct cause of "unerr is not working" + dashboard offline.
- **Where:** `src/entrypoints/cli.ts` (`--daemon-child` path).
- **Root cause:** parent-death detection was only a 60s `unref()`'d PPID poll; no
  immediate IPC-disconnect handler, and `shutdownProxy()` had no hard-exit watchdog —
  so a wedged CozoDB flush could hang the graceful teardown forever (the real reason a
  child that detected parent death still never reached `process.exit`).
- **Fix (landed):**
  1. Added `process.on('disconnect')` → `shutdownProxy('parent-disconnect')`. Fires the
     instant unerrd's IPC channel closes — immediate, cadence-independent.
  2. Tightened the PPID poll backstop 60s → 10s.
  3. Added `shuttingDown` idempotency guard (3 detectors can fire together).
  4. Added a `SHUTDOWN_GRACE_MS` (5s) hard-exit watchdog in `shutdownProxy` so a wedged
     `proxyResult.shutdown()` can never keep the child alive.
- **Verify (runtime, after rebuild):** start unerrd, note child pid, kill unerrd, confirm
  child exits within ~1s and `proxy.sock` is removed; confirm a wedged DB still exits ≤5s.
- **Status:** DONE + RUNTIME-VERIFIED (2026-05-25). `kill -9` unerrd (37601, worst case —
  no graceful reap). All 3 children (38152/38162/39137) exited in <0.5s, **zero orphans**
  (no daemon-child left at ppid=1). proxy.log confirms the new path fired:
  `Parent IPC disconnected — orphan exit` → `Shutting down: parent-disconnect` (vs the old
  orphan 91123's `Parent died — orphan exit` 60s-poll line that then hung). unerrd
  auto-respawned (new pid 46104) with fresh children parented to it — full self-heal.

### [x] Issue 3 — unerrd not re-spawned while a stale proxy.sock is still live
- **Severity:** High (couples with Issue 2).
- **Where:** bridge discovery (`src/entrypoints/cli.ts` `discoverWithRetry`, ~1186-1244).
- **Root cause confirmed:** discovery step 1 returns `kind:"standalone"` and connects
  directly whenever the per-repo `proxy.sock` PID-probe says **alive**, never reaching the
  unerrd auto-spawn block (step ~1214). The orphan was alive → unerrd never re-spawned.
- **Resolution:** RESOLVED by Issue 2. Once the child self-exits on parent death, the
  socket + PID lock are released → the next bridge probe falls through to spawn a fresh
  unerrd → fresh managed child. Standalone mode unaffected (no IPC channel → `disconnect`
  never fires; the child stays up as intended).
- **Status:** DONE (by Issue 2). Confirm in the runtime verify for Issue 2.

### [x] Issue 4 — CozoDB write timeout in drift watcher (single, caught)
- **Severity:** Low to crash, but the real significance is its tie to Issue 2.
- **Where:** `CozoGraphStore.write` (`src/intelligence/local-graph.ts:382-404`); surfaced
  by the watcher drift path (`src/proxy/proxy.ts:3025`).
- **Root cause:** `write()` races `db.run` against a 10s timeout but **`Promise.race`
  doesn't cancel the loser** — a wedged native write keeps running and can serialize
  behind `writeChain`, and (critically) makes `proxyResult.shutdown()`'s final flush hang.
- **Resolution:** the cross-cutting harm (a wedged write keeping the child alive forever)
  is neutralised by Issue 2's shutdown watchdog. The single caught `⚠` warning itself is
  non-fatal and already handled. Deeper work (true write cancellation / batch sizing) is
  optional follow-up, not required for the "not working" fix.
- **Status:** DONE for the lifecycle impact (via Issue 2 watchdog); deeper cancellation = optional follow-up.

---

## Cleanup (requires user approval — do NOT do unilaterally)

- Orphan proxy **pid 91123** is stale and possibly wedged. Per project rule
  ("never restart unerr unilaterally"), ASK before `kill 91123`.
- After Issue 1-2 code fixes: ask the user to rebuild + restart so a fresh unerrd +
  proxy come up under the corrected lifecycle.

---

## Round 2 — "after recent changes nothing is working" (2026-05-25)

Symptom: `pm status` shows all repos `○ stopped` though a per-repo proxy (pid
47219, PPID=unerrd 46104) was alive and *actively serving this session*.
unerrd.log: **41 `[unerr-cli] stopped` vs 10 `started`** — heavy churn. Root
cause was a single fact: **`repos.json` stored legacy *tilde* paths**
(`~/IdeaProjects/...`) that current `addRepo` (resolve→absolute) no longer
produces. Everything below flows from that.

### [x] Issue 5 — unerrd loses track of a live per-repo proxy (status lies + fork churn)
- **Severity:** High — user reads "stopped"/dashboard offline and concludes unerr is dead, though tools work.
- **Where:** `src/daemon/process-manager.ts` `ensure()`/`spawn()`; `src/proxy/proxy.ts:688-692`.
- **Root cause:** when a forked daemon-child finds the PID lock already held it
  does `process.exit(0)` **without sending `{type:"ready"}`**. `ensure()` had no
  "already-live" path, so every connect re-`spawn()`ed, overwrote the map entry,
  and the throwaway child's exit stamped it `stopped` — leaving the real primary
  serving but untracked.
- **Fix (landed):** `ensure()` now **adopts** an already-live proxy — `tryAdopt()`
  reads `proxy.pid` + checks the PID is alive + `proxy.sock` exists, registers a
  managed `running` entry (`adopted:true`, `child:null`) and returns the sock; no
  fork. Adopted entries are re-probed by PID on each `ensure()` (dropped + re-
  evaluated if dead), skipped by the idle sweep, and `stop()` signals them by PID.
  Map access canonicalized via `canonRepoKey()` so one repo = one key.
- **Tests:** `daemon-supervisor.test.ts` — "ensure() adopts an already-live proxy", "drops a dead adopted entry and re-evaluates".
- **Status:** DONE. Needs rebuild+restart (user-owned) to take effect at runtime.

### [x] Issue 6 — kap10-server `spawn ENOENT` (warm-start uses tilde cwd)
- **Severity:** High — that repo genuinely never starts.
- **Where:** warm-start → `pm.ensure(entry.path)` → `fork({cwd})`.
- **Root cause:** warm-start passed the registry's literal `~/IdeaProjects/kap10-server`
  as `fork` `cwd`; the OS never expands `~`, so the dir doesn't exist → spawn fails
  (Node reports it against `node`). Chat connects worked because the bridge sends an
  absolute cwd; only warm-start read the raw tilde path.
- **Fix (landed):** `readRegistry()` normalizes every stored path to
  `resolve(expandHome(path))`, and `ensure()` canonicalizes its key — so spawn cwd is
  always absolute. (No separate proxy.ts change needed.)
- **Status:** DONE (transitively via Issue 7's normalization).

### [x] Issue 7 — registry tilde paths break `pm remove` / `findRepo` matching
- **Severity:** Medium (latent; surfaced here as the shared root cause).
- **Where:** `src/daemon/registry.ts` — `removeRepo`/`findRepo`/`updateRepoSettings`/`addRepo`.
- **Root cause:** matchers compared `resolve(input)` against stored tilde paths → never matched home repos.
- **Fix (landed):** `expandHome()` helper; `readRegistry()` normalizes stored paths to
  absolute (self-heals the file on next write); matchers expand `~` in their input.
- **Tests:** `daemon-registry.test.ts` — "Legacy tilde-path normalization" (4 cases).
- **Status:** DONE.

### Pre-existing, NOT mine (flagged)
- `warm-start-policy.test.ts > selects MRU repos up to budget` fails on HEAD too —
  date-bomb: hard-coded `lastActivity` (May 10) is now >14 days old vs today
  (2026-05-25), so it's excluded (4 candidates, not 5). Independent of these fixes.

### Verification done (no runtime restart — user owns that)
- `pnpm run typecheck` exit 0; biome clean on touched files; 112 daemon tests pass.
- **Action for user:** rebuild + restart unerrd so adoption + path normalization take
  effect. On next restart the tilde entries in `repos.json` self-heal to absolute.

---

## Round 3 — "closing a chat closes unerrd" + restore original unerrd-first flow (2026-05-25)

Symptom: "the moment we close the chat session unerrd process is getting stopped while
the underlying unerr processes are getting attached to the root process." `ps` confirmed
a dead-or-churning unerrd with the per-repo proxy reparented to launchd (PID 1). User:
"it was developed initially in this manner [unerrd-first] our recent changes have broken
this flow."

### [x] Issue 8 — closing a chat kills unerrd (spawned inside the bridge's subtree)
- **Severity:** High — kills the manager + orphans every proxy on chat close.
- **Where:** `src/commands/pm.ts` (`pm start --detached` branch); `src/entrypoints/daemon.ts`.
- **Root cause:** the bridge auto-spawns unerrd via `spawn("pm start --detached",
  {detached:true})`, but `--detached` ran `startDaemon()` **in-process** — so the spawned
  PID *is* unerrd and stays the **bridge's direct child** until the bridge exits. IDEs
  commonly reap the MCP server's whole child subtree on session-end; that one-level reap
  takes unerrd (bridge's child) but misses the per-repo proxy (grandchild) → proxy
  reparents to launchd = "attached to the root process." Confirmed by `unerrd.log`: dead
  instances end mid-churn with **no "Shutting down" line** → killed by an unhandled signal,
  never graceful. daemon.ts had no SIGHUP handler.
- **Fix (landed):**
  1. **Double-fork** in the `--detached` branch (guarded by `UNERR_DAEMON_REPARENTED`):
     re-spawn one detached generation and `process.exit(0)` immediately, so the real
     supervisor reparents to PID 1 *before* binding the socket — never in the bridge's
     subtree. `--foreground` skips this (stays attached for debugging).
  2. **SIGHUP guard** in `startDaemon({detached})`: a detached supervisor ignores SIGHUP
     (it owns no controlling terminal). `pm stop` (SIGTERM) / "shutdown" command unchanged.
- **Status:** DONE. Needs rebuild+restart (user-owned) to take effect.

### [x] Issue 9 — restore unerrd-first discovery (drop the standalone-proxy bypass)
- **Severity:** High — the bypass is the Round-1/Round-2 orphan root.
- **Where:** `src/entrypoints/cli.ts` `discoverWithRetry` / `mcpBoot` / `DiscoveryResult`.
- **Root cause:** a recent change made discovery probe the per-repo `proxy.sock` **first**
  and connect directly (`kind:"standalone"`), bypassing unerrd. When a proxy was alive but
  unerrd was dead, the bridge attached to the orphan and unerrd was never re-spawned →
  `pm status` lied, dashboard offline.
- **Fix (landed):** discovery is **unerrd-first** again — probe `unerrd.sock`; if up,
  `ensureRepo` delegates the proxy decision to unerrd (adopt-running / start-new, via
  Issue 5's adopt path) and returns the proxy sock; if down, spawn unerrd detached and
  re-probe. Removed the `standalone` `DiscoveryResult` kind + its `mcpBoot` handler + the
  `proxy.sock`/`PidLock.probe()` first-probe block. The bridge never connects to a proxy
  sock without unerrd knowing.
- **Tests:** `daemon-bridge.test.ts` — rewrote "checks per-repo proxy sock before falling
  through" → "is unerrd-first: probes the daemon before ensuring the per-repo proxy"
  (asserts `probeDaemon` precedes `ensureRepo`, no `probeResult.alive` / `kind:"standalone"`
  in discovery); updated the retry-message assertion.

### Verification (no runtime restart — user owns that)
- `pnpm run typecheck` exit 0; biome clean on the 4 touched files; daemon-bridge (30),
  daemon-supervisor + registry + dashboard + persistence-guard (90) all pass. The
  persistence-pattern guard still passes — the double-fork adds no launchd/systemd/schtasks.
- Pre-existing `warm-start-policy.test.ts > selects MRU repos up to budget` date-bomb still
  fails on HEAD (unrelated; see Round 2).

### Runtime verification (2026-05-25, after user rebuild+restart) — PASS
End-to-end isolated test (`/tmp/flowtest5.sh`: private `UNERR_HOME` + temp repo
**initialized with `.unerr/config.json`**, so the daemon-child proxy actually boots):
- **chat #1 open:** isolated unerrd `PPID=1, stat=Ss` (double-fork reparented to launchd);
  per-repo proxy spawned as unerrd's child (`PPID=<unerrd>`); bridge logged
  `[unerr:mcp] Bridging to repo process via unerrd` — the "via unerrd" connect path completes.
- **chat #1 reaped** (recursive descendant SIGKILL of the bridge subtree, as an IDE tears down
  its MCP server): **unerrd survived** (`PPID=1`) **and the proxy survived**, still parented to
  unerrd (not orphaned to root, not killed with the chat).
- **chat #2 reconnect:** same unerrd, **same proxy reused** (`ppid=<unerrd>`), `Bridging via unerrd`
  again. No standalone bypass, no `pm status` lie.
- **SIGHUP guard** (`/tmp/flowtest.sh`): isolated unerrd survived `kill -HUP`; logged
  `Ignoring SIGHUP — detached supervisor has no controlling terminal`.

**Non-issue clarified:** earlier isolated runs (`flowtest2/3`) showed the proxy churning
`stopped: code=1, signal=null`. Root cause = those throwaway repos were **never set up** (no
`.unerr/config.json`), so `daemonChildBoot` (cli.ts:851) correctly exits 1
(`No .unerr/config.json — run unerr interactively first`) and unerrd retries. This is intended
guard behavior, **not a regression** — real repos (and `flowtest5` once initialized) boot the
proxy cleanly. The fix is verified complete.
