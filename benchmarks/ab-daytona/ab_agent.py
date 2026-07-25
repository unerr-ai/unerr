"""Minimal unerr Harbor agent — the EXACT unerr install from
`harbor_agents.ClaudeUnerrAgent`, with the benchmark HARNESS stripped.

Kept (identical to ClaudeUnerrAgent): the Daytona/Harbor lifecycle, the unerr
install sequence (npm -g tarball -> version gate -> PATH bridge -> dev.json Pro
tier + UNERR_TOKEN login-skip -> index -> pm start -> install claude-code ->
alwaysLoad verification -> live MCP probe), the per-tier model forwarding
(ENV_VARS), the unerr MCP-server registration, and the
`--dangerously-skip-permissions` + `IS_SANDBOX=1` root bypass.

Two additions beyond ClaudeUnerrAgent, unerr-arm only (see FIX 2 / FIX 1 in
the recon that produced this): `_build_register_mcp_servers_command` is
overridden to add `"alwaysLoad": true` to the registered unerr entry — the
parent's serializer only emits type/command/args, so Claude Code's default
ENABLE_TOOL_SEARCH deferred every unerr tool behind Tool Search (confirmed:
ToolSearch fired 27x vs 1x real unerr tool call in a 23-trial run). And
`run()` wraps the parent call in a `finally` that best-effort copies
`.unerr/logs` into `/logs/agent/unerr-logs/` — Harbor auto-downloads
`/logs/agent` to the trial's own artifacts after every run regardless of
outcome, so a proxy-side hang now leaves a trace.

Removed (the "additional harness"): the autonomy/operator `--append-system-prompt`
policy, `cc-harness-hooks.py`, the `.claude/settings.local.json` gate hooks, the
`_resolve_pybin` step those need, and the delegation-tuned sub-agent overwrite.
The only system-prompt addition is one line telling the model it is running
non-interactively so it never pauses for input mid-task.

Two arms, selected by the `AB_BASELINE` env var:
  * unset  -> unerr arm: full unerr install + unerr MCP server + minimal prompt.
  * "1"    -> baseline : bare claude-code (no unerr install, no unerr MCP),
              same minimal prompt + root bypass, so the ONLY difference between
              the arms is unerr itself.

Run (src/ of the bench on PYTHONPATH so harbor_agents imports, plus this dir):
  PYTHONPATH="<bench>/src:<this-dir>" harbor run \
    -d terminal-bench/terminal-bench-2-1 -a ab_agent:MinimalUnerrAgent \
    -m claude-opus-4-8 --ak unerr_main_model=claude-opus-4-8 \
    -e daytona -i terminal-bench/<task> -n 1 -o out/ab-unerr
  # baseline: prefix the same line with  AB_BASELINE=1  (and a different -o).
"""

from __future__ import annotations

import json
import os
import shlex
from typing import override

# EnvVar is how Harbor's ClaudeCode.run() forwards a value into the `claude -p`
# container env (a hardcoded key list + ENV_VARS is ALL it forwards). We use it
# to push UNERR_TOKEN into the claude process so the hooks/MCP claude spawns
# inherit it — the fix for the signed-out hooks.
from harbor.agents.installed.base import EnvVar  # type: ignore[import-not-found]

# Single reuse point: everything we need is already in harbor_agents' namespace.
from harbor_agents import (  # type: ignore[import-not-found]
    ClaudeCode,
    ClaudeUnerrAgent,
    MCPServerConfig,
    _NVM_LOAD,
    _context_dir,
    _find_unerr_tgz,
    nvm_node_install_snippet,
)

# The headless login-skip credential. loginBlocked() (src/cloud/login-gate.ts)
# returns false the instant UNERR_TOKEN is non-blank — before any credential or
# entitlement check — so its mere presence makes every unerr process "logged in"
# (offline: nothing validates it on the wire). A fixed dev string is fine.
AB_UNERR_TOKEN = os.environ.get("UNERR_TOKEN", "unerr_sk_ab_devmode_offline")

# One line, per the brief: autonomous / non-interactive, nothing else.
MIN_PROMPT = (
    "You are running in autonomous, non-interactive mode (claude -p). Do not "
    "ask the user questions or pause for input mid-task — make reasonable "
    "assumptions and complete the task, then stop."
)


def _is_baseline() -> bool:
    return os.environ.get("AB_BASELINE") == "1"


class MinimalUnerrAgent(ClaudeUnerrAgent):
    """ClaudeUnerrAgent's unerr setup with the harness removed. See module doc."""

    # Forward UNERR_TOKEN into the `claude -p` container env. Harbor's run()
    # builds that env from a hardcoded key list + these ENV_VARS and forwards
    # NOTHING else, so a UNERR_TOKEN set only on the install execs never reached
    # claude — its hooks/MCP started with no token and signed out. Declaring it
    # here routes it through _resolved_env_vars into the claude process, so every
    # child (hooks, the `unerr --mcp` bridge) inherits it and loginBlocked() is
    # false everywhere. `default=` means no external export is required; a host
    # UNERR_TOKEN or `--ak unerr_token` still overrides. (Harmless on baseline —
    # nothing there reads it.)
    ENV_VARS = [
        *ClaudeUnerrAgent.ENV_VARS,
        EnvVar(
            "unerr_token",
            env="UNERR_TOKEN",
            type="str",
            env_fallback="UNERR_TOKEN",
            default=AB_UNERR_TOKEN,
        ),
    ]

    @staticmethod
    def name() -> str:
        return "claude-code-unerr-min" if not _is_baseline() else "claude-code-baseline-min"

    def __init__(self, logs_dir, *args, **kwargs):
        # Bypass ClaudeUnerrAgent.__init__ (it injects the autonomy operator
        # prompt and sets _hooks_on=True) — go straight to ClaudeCode with the
        # minimal prompt. Inherited build_cli_flags() still reads this prompt,
        # shlex-quotes it, drops --permission-mode, and appends
        # --dangerously-skip-permissions (honored under root via the parent
        # run()'s IS_SANDBOX=1).
        self._hooks_on = False
        self._escalation_panel = False
        kwargs["append_system_prompt"] = MIN_PROMPT
        ClaudeCode.__init__(self, logs_dir, *args, **kwargs)
        # unerr arm only: register unerr as a Harbor-native MCP server so the
        # parent run() wires it into the user-scoped .claude.json (no trust
        # dialog). Baseline registers nothing, so it is pure claude-code.
        if not _is_baseline():
            # Spawn `unerr --mcp` through `sh -c` so UNERR_FORCE_PROJECT=1 is set
            # in the bridge's own env (MCPServerConfig carries no env field). The
            # bridge gates on detectProjectRoot(cwd); a bare terminal-bench
            # fixture scores below the threshold, so without the force flag the
            # bridge refuses to serve and unerr is inert. The per-repo proxy the
            # bridge/daemon spawns inherits this env (ProcessManager forks with
            # {...process.env}), so one flag clears every gate site.
            self.mcp_servers = [
                *self.mcp_servers,
                MCPServerConfig(
                    name="unerr",
                    transport="stdio",
                    command="sh",
                    args=["-c", "UNERR_FORCE_PROJECT=1 exec unerr --mcp"],
                ),
            ]

    @override
    def _build_register_mcp_servers_command(self) -> str | None:
        """Same write as ClaudeCode._build_register_mcp_servers_command()
        (user-scoped $CLAUDE_CONFIG_DIR/.claude.json, no trust dialog — see
        __init__'s comment above) but with `"alwaysLoad": true` added to the
        unerr entry.

        Root cause this fixes: MCPServerConfig carries no alwaysLoad field
        and the parent's serializer only emits type/command/args, so the
        per-server override Claude Code's own docs describe ("loads at
        session start regardless of ENABLE_TOOL_SEARCH") never reached the
        file the parent writes. With ENABLE_TOOL_SEARCH on by default, every
        MCP tool defers behind Tool Search until the agent explicitly
        searches for it — confirmed in a prior 23-trial run: ToolSearch
        fired 27x vs 1x for an actual mcp__unerr__file_read call, so the A/B
        measured startup overhead, not unerr's tools.

        Why override this method rather than write .mcp.json instead: a
        project-scope .mcp.json entry (which unerr's OWN installer already
        writes with alwaysLoad — see `unerr install claude-code` below)
        "requires explicit enablement" per this same parent class's own
        docstring — i.e. a trust gate — and this agent injects no
        settings.local.json to pre-trust it, so relying on that file alone
        risks a dead connection, worse than deferred tools. The user-scope
        file this method writes is the ALREADY-PROVEN connection path (the
        same one ClaudeUnerrAgent uses for the full leaderboard agent), so
        this reimplements it byte-for-byte with one added key rather than
        replacing it — run()'s own $CLAUDE_CONFIG_DIR/exec sequencing, error
        handling, and hard gate (a non-zero echo raises inside
        exec_as_agent) stay exactly the parent's.
        """
        if not self.mcp_servers:
            return None
        servers: dict[str, dict] = {}
        for server in self.mcp_servers:
            if server.transport == "stdio":
                entry: dict = {
                    "type": "stdio",
                    "command": server.command,
                    "args": server.args,
                }
                if server.name == "unerr":
                    entry["alwaysLoad"] = True
                    self.logger.warning(
                        "UNERR-ALWAYSLOAD: registering user-scope "
                        "$CLAUDE_CONFIG_DIR/.claude.json unerr entry with "
                        "alwaysLoad=true"
                    )
                servers[server.name] = entry
            else:
                transport = (
                    "http" if server.transport == "streamable-http" else server.transport
                )
                servers[server.name] = {"type": transport, "url": server.url}
        claude_json = json.dumps({"mcpServers": servers}, indent=2)
        return f"echo {shlex.quote(claude_json)} > $CLAUDE_CONFIG_DIR/.claude.json"

    async def install(self, environment) -> None:
        # Baseline: Harbor's own unmodified claude-code install, nothing else.
        if _is_baseline():
            await ClaudeCode.install(self, environment)
            return

        # unerr arm — mirrors ClaudeUnerrAgent.install() MINUS every harness
        # step (cc-harness-hooks upload, _resolve_pybin, agents overwrite,
        # _hooks_settings_command). The steps below are byte-for-byte the
        # unerr-setup subset.
        await ClaudeCode.install(self, environment)  # 1. Claude Code CLI

        context_dir = _context_dir()
        tgz = _find_unerr_tgz(context_dir)
        if tgz is None:
            raise RuntimeError(
                f"unerr tarball not found under {context_dir} "
                "(expected unerr-ai-unerr-*.tgz) — set UNERR_CONTEXT_DIR, "
                "or run the baseline arm with AB_BASELINE=1"
            )

        remote = self.UNERR_REMOTE_DIR
        await self.exec_as_agent(environment, command=f"mkdir -p {remote}")
        await environment.upload_file(source_path=tgz, target_path=f"{remote}/{tgz.name}")

        # 2/3. Node runtime (nvm) + npm -g the tarball + hard version gate.
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet()} && "
                f"npm install -g {remote}/{tgz.name} && "
                "unerr --version"
            ),
        )

        # PATH bridge — the 601/601 fix: Claude Code spawns MCP servers/hooks
        # WITHOUT the nvm-sourced shell, so symlink the real binaries onto a
        # stock PATH and re-verify from a stripped env that mimics that spawn.
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; " + _NVM_LOAD +
                'NODE_BIN="$(command -v node || true)"; '
                'NPM_BIN="$(command -v npm || true)"; '
                'UNERR_BIN="$(command -v unerr || true)"; '
                '[ -n "$NODE_BIN" ] || { echo "FATAL: node not resolvable '
                'inside the nvm-sourced shell" >&2; exit 1; }; '
                '[ -n "$UNERR_BIN" ] || { echo "FATAL: unerr not resolvable '
                'inside the nvm-sourced shell" >&2; exit 1; }; '
                'mkdir -p /usr/local/bin; '
                'ln -sf "$NODE_BIN" /usr/local/bin/node; '
                'ln -sf "$UNERR_BIN" /usr/local/bin/unerr; '
                '[ -z "$NPM_BIN" ] || ln -sf "$NPM_BIN" /usr/local/bin/npm; '
                'env -i PATH=/usr/local/bin:/usr/bin:/bin node --version '
                '|| { echo "FATAL: node --version failed under a stripped, '
                'non-nvm PATH after symlinking" >&2; exit 1; }; '
                'env -i PATH=/usr/local/bin:/usr/bin:/bin unerr --version '
                '|| { echo "FATAL: unerr --version failed under a stripped, '
                'non-nvm PATH after symlinking" >&2; exit 1; }'
            ),
        )

        # File-based dev mode sets the Pro TIER; UNERR_TOKEN (env below + the
        # ENV_VARS descriptor) clears the LOGIN WALL. They are two separate gates
        # and both matter. One file on disk:
        #   $HOME/.unerr/dev.json  {"tier":"pro"} -> applyDevConfig mints Pro
        # applyDevConfig runs in the cli-main preAction of every `unerr <cmd>`
        # (index, pm start, install) — including the per-repo proxy pm start
        # forks — so the proxy that serves MCP runs at Pro. The login wall is a
        # DIFFERENT gate: the hooks and the `unerr --mcp` bridge Claude Code
        # spawns do NOT call applyDevConfig, and cannot verify the dev
        # entitlement (no pubkey env), so they would fall to degraded_free
        # (signed out). UNERR_TOKEN short-circuits loginBlocked() BEFORE any
        # entitlement check, so every process — install execs AND the claude
        # children — is logged in. That makes the old credentials.json write
        # redundant, so it is dropped. printf keeps the JSON a single-line literal.
        await self.exec_as_agent(
            environment,
            command=(
                'set -eu; UD="$HOME/.unerr"; mkdir -p "$UD"; '
                "printf '%s' '{\"tier\":\"pro\"}' > \"$UD/dev.json\"; "
                'ls -la "$UD"'
            ),
        )

        # UNERR_FORCE_PROJECT registers the bare terminal-bench fixture as a
        # project (same flag the MCP-server wrapper in __init__ carries).
        # UNERR_TOKEN clears the login wall for these install execs and for the
        # per-repo proxy pm start forks (ProcessManager forks with {...env}, so
        # the proxy inherits it) — the same token ENV_VARS pushes into claude.
        env = {"UNERR_FORCE_PROJECT": "1", "UNERR_TOKEN": AB_UNERR_TOKEN}

        # index -> pm start -> install claude-code (best-effort past the PATH
        # gate, exactly as the parent: log-and-continue, not fatal).
        await self._lenient_exec(
            environment, _NVM_LOAD + "unerr index --force --json", env=env
        )
        await self._lenient_exec(
            environment, _NVM_LOAD + "unerr pm start", env=env
        )
        await self._lenient_exec(
            environment, _NVM_LOAD + "unerr install claude-code", env=env
        )

        # Verification (non-fatal, loud): confirm the installer's OWN
        # project-scope .mcp.json still carries alwaysLoad for "unerr", so
        # a regression in `unerr install claude-code` (the one write this
        # agent doesn't control) surfaces in trial.log instead of only as
        # silently-deferred tools discovered after a full, expensive run.
        # Diagnostic only — project .mcp.json still needs trust to load at
        # all; the connection itself goes through the user-scope
        # $CLAUDE_CONFIG_DIR/.claude.json _build_register_mcp_servers_command
        # override writes above (that write logs its own UNERR-ALWAYSLOAD
        # marker, and is a hard gate inside run() — a failed echo there
        # raises, not silently degrades).
        try:
            mcp_json = await environment.exec(
                command="cat .mcp.json 2>/dev/null || true", env=env
            )
            always_load = (
                json.loads(mcp_json.stdout or "{}")
                .get("mcpServers", {})
                .get("unerr", {})
                .get("alwaysLoad")
            )
        except Exception as exc:  # diagnostic only — never fatal
            always_load = f"<probe failed: {exc}>"
        self.logger.warning(
            "UNERR-ALWAYSLOAD-MCPJSON: project .mcp.json unerr.alwaysLoad=%r",
            always_load,
        )

        # Live MCP connectivity gate (non-fatal, loud) — the anti-dead-backend
        # check: unerr --mcp completes a JSON-RPC handshake from the stripped
        # PATH Claude Code spawns it with.
        await self._probe_mcp_connectivity(environment, env=env)

    @override
    async def run(self, instruction, environment, context) -> None:
        # FIX 1: neither arm otherwise saves .unerr/logs, so a proxy-side
        # hang (e.g. the 1800s file_read hang) leaves no trace. `finally`
        # (not a plain trailer) so this still runs when the agent hangs and
        # trial.py's asyncio.wait_for cancels the run — wait_for cancels the
        # task then awaits it to unwind, and finally blocks execute during
        # that unwind, before TimeoutError is raised to the caller — so a
        # hang is exactly the case this needs to catch, and it does.
        try:
            await super().run(instruction, environment, context)
        finally:
            if not _is_baseline():
                await self._copy_unerr_logs(environment)

    async def _copy_unerr_logs(self, environment) -> None:
        """Best-effort, never-fatal copy-back of proxy-side logs into the
        trial artifacts.

        /logs/agent is EnvironmentPaths.agent_dir (harbor.models.trial.paths,
        pinned harbor==0.20.0) — the one directory Trial._download_agent_logs
        (harbor/trial/trial.py) downloads back to the host trial dir
        unconditionally after every run, mounted or not, so anything written
        there needs no extra environment.download_file/upload_file call —
        this agent has no post-run hook other than wrapping run() (no
        cleanup/teardown method exists on BaseInstalledAgent), so writing
        into that directory is the only way to get files into the trial's
        own artifacts after the agent runs.
        """
        try:
            await self.exec_as_agent(
                environment,
                command=(
                    "set +e; mkdir -p /logs/agent/unerr-logs; "
                    "tar -czf /logs/agent/unerr-logs/project-logs.tar.gz "
                    ".unerr/logs 2>/dev/null; "
                    'tar -C "$HOME" -czf '
                    "/logs/agent/unerr-logs/daemon-logs.tar.gz "
                    ".unerr/logs 2>/dev/null; true"
                ),
                timeout_sec=60,
            )
        except Exception as exc:  # best-effort — never fails the trial
            self.logger.warning("unerr log copy-back failed (non-fatal): %s", exc)
