/**
 * One-off overhead accounting after the token-tax trims (#6-#9).
 * Measures the deterministic injection components in tokens (estimateTokens),
 * split by cacheability. Not a Track4 A/B — a static budget of what unerr adds.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateCustomInstructions } from "../src/config/instruction-writer.js";
import { runUserPromptSubmitHook } from "../src/hooks/prompt-hooks.js";
import { ADVERTISED_TOOL_DEFINITIONS } from "../src/proxy/tool-definitions.js";
import { estimateTokens } from "../src/intelligence/token-estimator.js";

const tok = (s: unknown) => estimateTokens(s);

// --- Cached prefix (#6 instruction block, #8 tools/list) ---------------------
// Paid once at cache-write (1.25x), re-read each later turn at 0.1x.
const instrClaude = generateCustomInstructions("claude-code");
const instrCursor = generateCustomInstructions("cursor");
const instrGeneric = generateCustomInstructions();

// tools/list as the MCP server advertises it (name + description + inputSchema).
const toolsListJson = JSON.stringify(
  ADVERTISED_TOOL_DEFINITIONS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: (t as { inputSchema?: unknown }).inputSchema,
  }))
);

// --- Per-turn injection (#7 static tail gated, + always-on floor) ------------
const cwd0 = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), "unerr-overhead-"));
process.chdir(tmp);

const mkPayload = (prompt: string) =>
  JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: "overhead-measure-sess",
    cwd: tmp,
    prompt,
  });

const codePrompt = "refactor the proxy boot sequence to add a retry on bind";
const extract = (hookOut: string): string => {
  try {
    const o = JSON.parse(hookOut);
    return (
      o?.hookSpecificOutput?.additionalContext ??
      o?.additionalContext ??
      o?.systemMessage ??
      ""
    );
  } catch {
    return "";
  }
};

const call1 = extract(runUserPromptSubmitHook(mkPayload(codePrompt))); // first turn
const call2 = extract(runUserPromptSubmitHook(mkPayload(codePrompt))); // gated
const call3 = extract(runUserPromptSubmitHook(mkPayload(codePrompt))); // gated (stable)

process.chdir(cwd0);

const tInstrClaude = tok(instrClaude);
const tTools = tok(toolsListJson);
const tCall1 = tok(call1);
const tCall2 = tok(call2);
const tCall3 = tok(call3);
const staticTail = tCall1 - tCall2; // #7 per-turn saving after turn 1

const fmt = (n: number) => n.toLocaleString();
console.error("\n================ unerr overhead accounting (post-trim) ================\n");
console.error("CACHED PREFIX  (write 1.25x once, re-read 0.1x/turn):");
console.error(`  Instruction block (#6) claude-code : ${fmt(tInstrClaude)} tok  (${instrClaude.length} chars)`);
console.error(`  Instruction block        cursor     : ${fmt(tok(instrCursor))} tok`);
console.error(`  Instruction block        generic    : ${fmt(tok(instrGeneric))} tok`);
console.error(`  tools/list (#8) ${ADVERTISED_TOOL_DEFINITIONS.length} tools         : ${fmt(tTools)} tok`);
console.error(`  -> cached prefix subtotal (claude)  : ${fmt(tInstrClaude + tTools)} tok`);
console.error("");
console.error("PER-TURN INJECTION (uncacheable, re-billed fresh 1x EVERY turn):");
console.error(`  Turn 1 (first, incl. static tail)   : ${fmt(tCall1)} tok`);
console.error(`  Turn 2 (gated)                      : ${fmt(tCall2)} tok`);
console.error(`  Turn 3 (gated, stable)              : ${fmt(tCall3)} tok`);
console.error(`  static tail #7 (saved/turn after T1): ${fmt(staticTail)} tok`);
console.error("");
console.error("PER-TURN FLOOR (what every later coding turn still pays):");
console.error(`  ${fmt(tCall2)} tok/turn  (moment1 + any ur|act/stitch/shift lines)`);
console.error("\n=======================================================================\n");
// Compact JSON line for the agent to read back.
console.error(
  "JSON " +
    JSON.stringify({
      cached_prefix_claude: tInstrClaude + tTools,
      instr_claude: tInstrClaude,
      instr_cursor: tok(instrCursor),
      tools_list: tTools,
      n_tools: ADVERTISED_TOOL_DEFINITIONS.length,
      turn1: tCall1,
      turn_gated: tCall2,
      static_tail_7: staticTail,
    })
);
