#!/usr/bin/env python3
"""Standalone Daytona check: can unerr serve its MCP tools in FILE-BASED dev
mode with NO login env (no UNERR_TOKEN, no UNERR_ENTITLEMENT_*)?

Sets up two on-disk files only:
  ~/.unerr/dev.json         = {"tier":"pro"}         -> applyDevConfig mints Pro
  ~/.unerr/credentials.json = {token: ...}           -> clears the login wall

Then indexes a tiny real project and drives the MCP server end-to-end:
  initialize -> tools/list -> tools/call search_code
Success = tools/list shows unerr tools AND search_code returns graph entities
(not a -32004 login block), and `unerr hook session-start` is NOT "signed out".

No Harbor, no claude, no model spend. One sandbox, deleted at the end.
Run:  set -a; source <bench>/.env.local; set +a
      ~/.local/share/uv/tools/harbor/bin/python verify_devmode.py
"""
import json
import os
import shlex
import sys

from daytona import Daytona, DaytonaConfig, CreateSandboxFromImageParams

TGZ = os.path.expanduser(
    "~/IdeaProjects/unerr-terminal-bench/src/unerr-ai-unerr-0.5.0.tgz"
)
IMAGE = "node:22-bookworm"


def resp(r):
    code = getattr(r, "exit_code", getattr(r, "code", None))
    txt = getattr(r, "result", None)
    if txt is None:
        art = getattr(r, "artifacts", None)
        txt = getattr(art, "stdout", None) if art is not None else None
    if txt is None:
        txt = getattr(r, "stdout", "") or ""
    return code, txt


def main():
    if not os.path.isfile(TGZ):
        sys.exit(f"tgz not found: {TGZ}")
    cfg = DaytonaConfig(
        api_key=os.environ["DAYTONA_API_KEY"],
        target=os.environ.get("DAYTONA_TARGET"),
    )
    c = Daytona(cfg)
    print(f"creating sandbox ({IMAGE}) ...")
    sb = c.create(
        CreateSandboxFromImageParams(image=IMAGE, ttl_minutes=30), timeout=240
    )
    print(f"sandbox: {getattr(sb, 'id', '?')}")

    def run(cmd, cwd="/root", env=None, timeout=300, label=None):
        if label:
            print(f"\n===== {label} =====")
        r = sb.process.exec(cmd, cwd=cwd, env=env, timeout=timeout)
        code, txt = resp(r)
        print(f"[exit {code}]")
        if txt and txt.strip():
            print(txt[-2000:])
        return code, (txt or "")

    try:
        # dirs + uploads (upload_file does not mkdir)
        run("mkdir -p /root/.unerr /work/src", label="mkdir")
        with open(TGZ, "rb") as f:
            sb.fs.upload_file(f.read(), "/root/unerr.tgz")

        # file-based dev mode: NO env, just two files
        sb.fs.upload_file(json.dumps({"tier": "pro"}).encode(), "/root/.unerr/dev.json")
        sb.fs.upload_file(
            json.dumps(
                {
                    "api_url": "https://app.unerr.ai",
                    "token": "unerr_sk_devmode_verify_0000000000",
                    "organization_id": "dev-org",
                    "machine_id": "dev-machine",
                    "machine_name": "daytona-verify",
                }
            ).encode(),
            "/root/.unerr/credentials.json",
        )

        # tiny real project (package.json => detected as a project)
        sb.fs.upload_file(
            json.dumps({"name": "verify-fixture", "version": "1.0.0"}).encode(),
            "/work/package.json",
        )
        sb.fs.upload_file(
            b"export function hello(n){ return 'hi ' + n; }\n"
            b"export function greet(name){ return hello(name); }\n",
            "/work/src/a.ts",
        )
        sb.fs.upload_file(
            b"import { greet } from './a';\n"
            b"export function main(){ return greet('world'); }\n",
            "/work/src/b.ts",
        )

        run("npm install -g /root/unerr.tgz >/dev/null 2>&1; "
            "echo \"unerr at: $(command -v unerr)\"; unerr --version",
            label="install unerr (official node image: npm -g -> /usr/local/bin, already on PATH)")
        run("chmod 600 /root/.unerr/credentials.json; ls -la /root/.unerr/", label="dev-mode files")

        # NO env is passed to any command below — pure file-based dev mode.
        run("unerr index --force --json", cwd="/work", label="index /work (no login env)")
        run("unerr whoami 2>&1; echo '----- status -----'; unerr status 2>&1 | head -25",
            cwd="/work", label="auth state — expect logged-in, NOT signed out")
        run("unerr pm start 2>&1", cwd="/work", label="pm start (WALL bucket — tests login wall via credential file)")
        run("echo '--- entitlement cache ---'; cat /root/.unerr/entitlements.json 2>&1 | head -40; "
            "echo; echo '--- ~/.unerr tree ---'; ls -la /root/.unerr /root/.unerr/dev 2>&1",
            label="entitlement cache after pm start (dev Pro minted?)")
        # Definitive blocked/not-blocked signal: handledByLoginGate() writes
        # .unerr/state/login-nudge.stamp ONLY when the hook is login-blocked.
        # Its absence after the hook == the hook was NOT signed out.
        run("rm -f /work/.unerr/state/login-nudge.stamp; "
            "printf '{}' | unerr hook session-start >/tmp/hook.out 2>/tmp/hook.err; "
            "echo \"[hook exit $?]\"; echo '--- hook STDOUT ---'; cat /tmp/hook.out; echo; "
            "echo '--- hook STDERR (signed-out nudge lands here) ---'; cat /tmp/hook.err; echo; "
            "echo -n 'login-nudge.stamp after hook: '; "
            "test -f /work/.unerr/state/login-nudge.stamp "
            "&& echo 'EXISTS -> hook WAS login-blocked' "
            "|| echo 'ABSENT -> hook NOT login-blocked (logged-in)'",
            cwd="/work", label="hook session-start — stamp check settles signed-out definitively")

        frames = "\n".join([
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                        "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                                   "clientInfo": {"name": "verify", "version": "0"}}}),
            json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
            json.dumps({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                        "params": {"name": "search_code", "arguments": {"query": "greet"}}}),
        ])
        # Hold stdin open (sleep after the frames) so EOF does not race the
        # daemon auto-spawn — otherwise the bridge exits mid-handshake and id 3
        # (tools/call) never gets served.
        probe = (
            "{ printf '%s\\n' " + shlex.quote(frames) + "; sleep 30; } | "
            "timeout 90 unerr --mcp > /tmp/mcp.out 2>/tmp/mcp.err; "
            "echo \"[mcp exit $?]\"; "
            "echo '--- tools/list (id2) tool names ---'; "
            "grep -oE '\"name\":\"(search_code|file_read|file_edit|get_references|fetch_url)\"' /tmp/mcp.out | sort -u; "
            "echo '--- tools/call search_code (id3) result ---'; "
            "grep '\"id\":3' /tmp/mcp.out | head -c 1800; echo; "
            "echo '--- markers: -32004 count / entity names / signed-out ---'; "
            "echo \"minus32004=$(grep -c -- -32004 /tmp/mcp.out)\"; "
            "grep -o 'greet\\|hello\\|signed out\\|not logged in' /tmp/mcp.out | sort | uniq -c; "
            "echo '--- mcp.err tail ---'; tail -8 /tmp/mcp.err"
        )
        run(probe, cwd="/work", timeout=140,
            label="MCP probe (stdin held open): tools/list + tools/call search_code")

        run("echo '--- proxy.log tail ---'; tail -40 /work/.unerr/logs/proxy.log 2>&1; "
            "echo '--- bridge.log tail ---'; tail -20 /work/.unerr/logs/bridge.log 2>&1",
            cwd="/work", label="proxy/bridge logs (diagnose any -32004 / signed-out)")

        print("\n===== VERDICT GUIDE =====")
        print("PASS if: tools/list lists search_code/file_read/... AND the tools/call")
        print("response (id 3) contains graph entities (greet/hello), NOT error -32004,")
        print("AND the hook step printed no 'signed out' line.")
    finally:
        print("\ndeleting sandbox ...")
        try:
            c.delete(sb)
            print("deleted.")
        except Exception as e:
            print(f"delete failed ({e}); ttl_minutes=30 will reap it.")


if __name__ == "__main__":
    main()
