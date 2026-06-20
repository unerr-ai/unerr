/**
 * `unerr recon "<prompt>"` — one-shot composite context for a coding turn.
 *
 * Sprint 1 (R1+R2+R3) of the token-overhead work
 * (`.internal/research/TOKEN_ECONOMICS_AND_SAVINGS.md`). The research showed the
 * dominant unerr-vs-no-unerr cost is round-trip amplification: every separate
 * MCP tool call re-bills the whole accumulated prefix. A "before I edit X" turn
 * normally fans out into search_code → get_references → get_conventions — three
 * sequential model round-trips, each re-paying for the growing prefix.
 *
 * `unerr recon` collapses that into a SINGLE Bash call. The agent runs one
 * `unerr recon "<what I'm about to do>"`; inside this one subprocess we open the
 * graph and run the whole discovery sequence locally (no LLM round-trips, no
 * cache re-billing), then print one merged, budget-trimmed bundle. Same
 * information, one model round-trip instead of three-plus.
 *
 * The orchestration logic lives in `src/intelligence/recon.ts` (pure, injected
 * runner). This command supplies a runner backed by the on-disk graph, so it
 * works standalone without a running proxy.
 */

import type { Command } from "commander";
import { nudgeIfLoggedOut } from "../hooks/login-nudge.js";
import { readEntityBodyLines } from "../intelligence/entity-source.js";
import {
  hasPersistedGraph,
  openPersistentDb,
} from "../intelligence/persistent-db.js";
import {
  type ReconRunner,
  SWEEP_SEARCH_LIMIT,
  composeRecon,
  reconEntityCount,
  reconFileSpread,
  renderReconDigest,
  renderReconText,
} from "../intelligence/recon.js";
import {
  type AnnotationDb,
  attachAnnotations,
  fetchActiveDomainTags,
  fetchVocabularyNudges,
} from "../intelligence/semantic/annotation-indexer.js";
import { classifyTaskSize } from "../intelligence/task-size.js";
import { getOrCreateSid } from "../utils/log-paths.js";
import { initFileLog, startupLog } from "../utils/startup-log.js";

/** Parse argv for the prompt and flags after `recon`. */
export function parseReconArgs(argv: string[]): {
  prompt: string;
  budget: number;
  json: boolean;
  digest: boolean;
} {
  const i = argv.indexOf("recon");
  const rest = i >= 0 ? argv.slice(i + 1) : argv;
  let budget = 2000;
  let json = false;
  let digest = false;
  const promptParts: string[] = [];
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k];
    if (a === "--budget" && rest[k + 1]) {
      const n = Number.parseInt(rest[++k]!, 10);
      if (Number.isFinite(n) && n > 0) budget = n;
    } else if (a === "--json") {
      json = true;
    } else if (a === "--digest") {
      digest = true;
    } else if (a === "--") {
      // everything after `--` is prompt
      promptParts.push(...rest.slice(k + 1));
      break;
    } else if (a && !a.startsWith("--")) {
      promptParts.push(a);
    }
  }
  return { prompt: promptParts.join(" ").trim(), budget, json, digest };
}

/**
 * Build a runner backed by the on-disk graph. Returns the raw structured shapes
 * `composeRecon` expects — the same shapes `QueryRouter.executeLocal` returns
 * for these tools. Notes (`unerr_recall_notes`) need the warm notes store, so
 * the cold CLI path returns `undefined` for them; `composeRecon` skips a
 * `undefined` section cleanly. The agent's own Moment-1 recall_notes call
 * already covers anchored notes.
 */
function buildGraphRunner(graph: {
  db: AnnotationDb;
  searchEntities: (
    q: string,
    limit?: number
  ) => Promise<
    Array<{
      key: string;
      name: string;
      kind: string;
      file_path: string;
      score: number;
    }>
  >;
  getEntity: (key: string) => Promise<{
    key: string;
    name: string;
    kind: string;
    file_path: string;
    start_line: number;
    end_line: number;
    signature: string;
  } | null>;
  getCallersOf: (key: string) => Promise<Array<Record<string, unknown>>>;
  getConventions: () => Promise<
    Array<{ kind: string } & Record<string, unknown>>
  >;
}): ReconRunner {
  return async (tool, args) => {
    switch (tool) {
      case "search_code": {
        const query = String(args.query ?? "");
        if (!query) return [];
        // Profile mode (detail/include_body): recon's focus-body fetch resolves
        // ONE entity by key and wants its verbatim source inlined. Mirror the
        // warm get_entity path (read body from source via the shared reader) so
        // the cold CLI inlines the SAME body the warm unerr_context does.
        if (args.detail === true || args.include_body === true) {
          const entity = await graph.getEntity(query);
          if (!entity) return null;
          const bodyLines = readEntityBodyLines(
            entity.file_path,
            entity.start_line,
            entity.end_line,
            process.cwd()
          );
          if (!bodyLines) return entity; // no source on disk → signature only
          const tokenBudget =
            typeof args.token_budget === "number" && args.token_budget >= 100
              ? args.token_budget
              : 400;
          const maxChars = tokenBudget * 4; // CHARS_PER_TOKEN, mirrors get_entity
          const fullBody = bodyLines.join("\n");
          const truncated = fullBody.length > maxChars;
          return {
            ...entity,
            body: truncated ? fullBody.slice(0, maxChars) : fullBody,
            ...(truncated ? { _truncated: { partial: true } } : {}),
          };
        }
        const limit = typeof args.limit === "number" ? args.limit : 10;
        const rows = await graph.searchEntities(query, limit);
        // Layer 8 §5.4: attach domain annotations to the recon "Entities"
        // section; best-effort, un-annotated hits pass through unchanged.
        return await attachAnnotations(graph.db, rows);
      }
      case "domain_tags": {
        // Layer 8 §5.4 "reuse before invent": active domain-tag vocabulary by
        // entity count. Best-effort — [] on any error.
        return { tags: await fetchActiveDomainTags(graph.db) };
      }
      case "vocab_nudges": {
        // Layer 8 §5.2 / §6.4: canonical/provisional split + near-duplicate
        // merge hints. Best-effort — empty sets on any error.
        return await fetchVocabularyNudges(graph.db);
      }
      case "get_references": {
        const key = String(args.key ?? "");
        if (!key)
          return {
            references: [],
            direction: "callers",
            total: 0,
            truncated: false,
          };
        const limit = typeof args.limit === "number" ? args.limit : 15;
        const raw = await graph.getCallersOf(key);
        const total = raw.length;
        // Strip body to keep the references section navigation-only (mirrors executeLocal).
        const capped = raw
          .slice(0, limit)
          .map(({ body: _body, ...rest }) => rest);
        return {
          references: capped,
          direction: "callers",
          total,
          truncated: total > limit,
        };
      }
      case "get_conventions": {
        const raw = await graph.getConventions();
        const naming: typeof raw = [];
        const import_direction: typeof raw = [];
        const structure: typeof raw = [];
        const other: typeof raw = [];
        for (const c of raw) {
          if (c.kind === "naming") naming.push(c);
          else if (c.kind === "import_direction") import_direction.push(c);
          else if (c.kind === "structure") structure.push(c);
          else other.push(c);
        }
        return {
          naming,
          import_direction,
          structure,
          ...(other.length > 0 ? { other } : {}),
        };
      }
      default:
        // Notes and any non-graph tool are skipped in the cold CLI path.
        return undefined;
    }
  };
}

export async function runReconMain(argv: string[]): Promise<number> {
  const { prompt, budget, json, digest } = parseReconArgs(argv);
  if (!prompt) {
    process.stderr.write(
      'usage: unerr recon "<what you are about to do>" [--budget N] [--json] [--digest]\n'
    );
    return 1;
  }

  const cwd = process.cwd();
  getOrCreateSid();
  initFileLog(cwd);

  if (!hasPersistedGraph(cwd)) {
    process.stderr.write(
      "[unerr:recon] no indexed graph for this repo yet — run `unerr` once to index, then retry.\n"
    );
    return 1;
  }

  let db: { close?: () => void } | undefined;
  try {
    const opened = await openPersistentDb(cwd);
    db = opened.db as unknown as { close?: () => void };
    const { CozoGraphStore } = await import("../intelligence/local-graph.js");
    const graph = await CozoGraphStore.create(opened.db);

    const runner = buildGraphRunner(
      graph as unknown as Parameters<typeof buildGraphRunner>[0]
    );

    // Size-gate (Sprint 3 T3.1 + Sprint 4 R6): classify from the prompt first to
    // pick the search width, then re-classify with the *actual* entity count
    // recon found so the verdict reflects reality, not just verbs.
    const preVerdict = classifyTaskSize(prompt);
    const searchLimit =
      preVerdict.size === "large_sweep" ? SWEEP_SEARCH_LIMIT : undefined;
    // Large sweeps orient (concise — no body fetch, flat digest); focused edits
    // front-load the verbatim body (detailed). Mirrors the warm unerr_context
    // handler so cold and warm paths render identically.
    const responseFormat: "concise" | "detailed" =
      preVerdict.size === "large_sweep" ? "concise" : "detailed";

    const bundle = await composeRecon({
      prompt,
      runner,
      budget,
      searchLimit,
      responseFormat,
    });

    const entityCount = reconEntityCount(bundle);
    const verdict = classifyTaskSize(prompt, { entityCount });
    const files = reconFileSpread(bundle);
    // Digest ⟺ no bodies inlined (concise) or the user forced --digest. The
    // digest collapses bodies to file:line ranges and stays flat as files-scanned
    // grows; a detailed bundle renders verbatim bodies via renderReconText.
    const useDigest = digest || responseFormat === "concise";

    if (json) {
      process.stdout.write(`${JSON.stringify(bundle)}\n`);
    } else {
      const text = useDigest
        ? renderReconDigest(bundle)
        : renderReconText(bundle);
      process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
      // Large sweeps amplify the main thread (every hop re-bills the prefix).
      // Route the scan into an isolated subagent and surface only the digest.
      if (verdict.size === "large_sweep" && !digest) {
        process.stdout.write(
          `\n[unerr] large sweep: ${entityCount} entities across ${files.length} file${
            files.length === 1 ? "" : "s"
          }. Run \`unerr recon\` inside a Task subagent and return only this digest to the main thread — keeps main-thread context flat as files scanned grows.\n`
        );
      }
    }

    startupLog.fileOnly("telemetry", "recon_cli_served", {
      prompt_len: prompt.length,
      terms: bundle.terms.length,
      sections: bundle.sections.length,
      focus: bundle.focusKey,
      tokens: bundle.totalTokens,
      truncated: bundle.truncated,
      // Sprint 4 T4.3 — feed threshold tuning: realized size + cardinality.
      task_size: verdict.size,
      entity_count: entityCount,
      file_spread: files.length,
      digest: useDigest,
    });
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    startupLog.fileOnly("warn", `recon failed: ${msg}`);
    process.stderr.write(`[unerr:recon] failed: ${msg}\n`);
    return 1;
  } finally {
    try {
      db?.close?.();
    } catch {
      /* best-effort close */
    }
  }
}

export function registerReconCommand(program: Command): void {
  program
    .command("recon")
    .description(
      "One-shot composite context for a coding turn (search + callers + conventions in a single call)"
    )
    .allowUnknownOption(true)
    .action(async () => {
      // Agent surface: never wall. Pass through and emit one throttled login
      // nudge on stderr (stdout stays the clean recon digest the agent parses).
      nudgeIfLoggedOut();
      const code = await runReconMain(process.argv);
      process.exit(code);
    });
}
