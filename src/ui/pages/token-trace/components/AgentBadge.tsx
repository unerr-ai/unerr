/**
 * AgentBadge — small colored chip showing which IDE/agent ran a session.
 * Falls back to `unknown` when neither the MCP `initialize.clientInfo.name`
 * nor the install-time `--coding-agent=<id>` flag is present. With the
 * flag baked into per-IDE MCP configs, every session now lands here with
 * a known id; this map covers every IDE in `agent-registry.ts`.
 */

const AGENT_STYLES: Record<
  string,
  { bg: string; text: string; label: string }
> = {
  "claude-code": {
    bg: "bg-amber-500/20",
    text: "text-amber-400",
    label: "Claude Code",
  },
  "claude-desktop": {
    bg: "bg-amber-500/20",
    text: "text-amber-400",
    label: "Claude Desktop",
  },
  cursor: { bg: "bg-blue-500/20", text: "text-blue-400", label: "Cursor" },
  cline: { bg: "bg-emerald-500/20", text: "text-emerald-400", label: "Cline" },
  windsurf: { bg: "bg-cyan-500/20", text: "text-cyan-400", label: "Windsurf" },
  copilot: { bg: "bg-zinc-500/20", text: "text-zinc-400", label: "Copilot" },
  vscode: { bg: "bg-blue-500/20", text: "text-blue-400", label: "VS Code" },
  zed: { bg: "bg-violet-500/20", text: "text-violet-400", label: "Zed" },
  kiro: {
    bg: "bg-fuchsia-500/20",
    text: "text-fuchsia-400",
    label: "Kiro",
  },
  "gemini-cli": {
    bg: "bg-cyan-500/20",
    text: "text-cyan-400",
    label: "Gemini CLI",
  },
  codex: {
    bg: "bg-emerald-500/20",
    text: "text-emerald-400",
    label: "Codex",
  },
  aider: { bg: "bg-rose-500/20", text: "text-rose-400", label: "Aider" },
  opencode: {
    bg: "bg-violet-500/20",
    text: "text-violet-400",
    label: "OpenCode",
  },
  trae: { bg: "bg-amber-500/20", text: "text-amber-400", label: "Trae" },
  augment: {
    bg: "bg-emerald-500/20",
    text: "text-emerald-400",
    label: "Augment",
  },
  "github-copilot-cli": {
    bg: "bg-zinc-500/20",
    text: "text-zinc-400",
    label: "Copilot CLI",
  },
  continue: {
    bg: "bg-violet-500/20",
    text: "text-violet-400",
    label: "Continue",
  },
  antigravity: {
    bg: "bg-fuchsia-500/20",
    text: "text-fuchsia-400",
    label: "Antigravity",
  },
};

export function AgentBadge({ name }: { name: string | null }) {
  if (!name) return <span className="t-tertiary text-[10px]">unknown</span>;
  const normalized = name.toLowerCase().replace(/\s+/g, "-");
  const style = AGENT_STYLES[normalized] ?? {
    bg: "bg-zinc-500/20",
    text: "text-zinc-400",
    label: name,
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 ${style.bg} ${style.text} text-[10px] font-medium`}
    >
      {style.label}
    </span>
  );
}
