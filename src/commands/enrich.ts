/**
 * `unerr enrich` — BYO-LLM Business Context Generation (Sprint L8.2).
 *
 * Uses the local LLM chat endpoint to generate `purpose`, `taxonomy`, and
 * `feature_area` for entities that lack business context. Results are stored
 * in the CozoDB `justifications` relation so `get_business_context` returns
 * enriched data.
 *
 * This is opt-in (never runs automatically) per Decision TL.11.
 */

import type { Command } from "commander";

// ── Types ──────────────────────────────────────────────────────

interface EnrichableEntity {
  key: string;
  kind: string;
  name: string;
  filePath: string;
  signature: string;
}

interface EnrichmentResult {
  purpose: string;
  taxonomy: string;
  feature_area: string;
}

// ── Prompt Builder ─────────────────────────────────────────────

function buildEnrichmentPrompt(entities: EnrichableEntity[]): string {
  const entityBlock = entities
    .map(
      (e, i) =>
        `[${i + 1}] ${e.kind} "${e.name}" in ${e.filePath}\n    Signature: ${e.signature || "(none)"}`,
    )
    .join("\n");

  return `You are a code analysis assistant. For each code entity below, generate:
1. **purpose**: A single sentence describing what this entity does and why it exists.
2. **taxonomy**: A domain category (e.g., "authentication", "data-access", "ui-rendering", "error-handling", "configuration", "testing", "api-integration").
3. **feature_area**: The product feature area this entity belongs to (e.g., "user-auth", "payment-processing", "dashboard", "notifications").

Respond with a JSON array. Each element must have: { "index": <number>, "purpose": "<string>", "taxonomy": "<string>", "feature_area": "<string>" }

Entities:
${entityBlock}

Respond ONLY with the JSON array, no other text.`;
}

// ── Response Parser ────────────────────────────────────────────

function parseEnrichmentResponse(
  text: string,
  count: number,
): EnrichmentResult[] {
  // Extract JSON array from response (may be wrapped in markdown code blocks)
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    return Array.from({ length: count }, () => ({
      purpose: "",
      taxonomy: "unknown",
      feature_area: "unknown",
    }));
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      index?: number;
      purpose?: string;
      taxonomy?: string;
      feature_area?: string;
    }>;

    // Map by index (1-based) or by position
    const results: EnrichmentResult[] = [];
    for (let i = 0; i < count; i++) {
      const entry = parsed.find((p) => p.index === i + 1) ?? parsed[i] ?? {};
      results.push({
        purpose: entry.purpose ?? "",
        taxonomy: entry.taxonomy ?? "unknown",
        feature_area: entry.feature_area ?? "unknown",
      });
    }
    return results;
  } catch {
    return Array.from({ length: count }, () => ({
      purpose: "",
      taxonomy: "unknown",
      feature_area: "unknown",
    }));
  }
}

// ── Core Enrichment Logic ──────────────────────────────────────

export async function runEnrich(opts: {
  batchSize: number;
  limit?: number;
  force?: boolean;
  json?: boolean;
}): Promise<void> {
  const cwd = process.cwd();

  // 1. Load settings + verify BYO-LLM
  const { loadSettings } = await import("../config/settings.js");
  const settings = loadSettings(cwd);

  if (!settings.localLlm) {
    process.stderr.write(
      "[unerr] Error: BYO-LLM required for enrichment.\n" +
        "[unerr] Configure localLlm in ~/.unerr/settings.json:\n" +
        '[unerr]   { "localLlm": { "provider": "ollama", "chatModel": "llama3" } }\n',
    );
    process.exit(1);
  }

  // 2. Load persistent graph
  const { openPersistentDb, hasPersistedGraph } = await import(
    "../intelligence/persistent-db.js"
  );
  if (!hasPersistedGraph(cwd)) {
    process.stderr.write(
      "[unerr] No persistent graph found. Run 'unerr index' first.\n",
    );
    process.exit(1);
  }

  const { CozoGraphStore } = await import("../intelligence/local-graph.js");
  const { db } = await openPersistentDb(cwd);
  const graph = await CozoGraphStore.create(db);

  // 3. Get entities without justifications (or all if --force)
  let entities: EnrichableEntity[];
  if (opts.force) {
    const result = await db.run(
      "?[key, kind, name, file_path, signature] := *entities{key, kind, name, file_path, signature}",
    );
    entities = result.rows.map((row) => ({
      key: row[0] as string,
      kind: row[1] as string,
      name: row[2] as string,
      filePath: row[3] as string,
      signature: row[4] as string,
    }));
  } else {
    // Entities that DON'T have a justification yet
    const result = await db.run(
      `?[key, kind, name, file_path, signature] :=
        *entities{key, kind, name, file_path, signature},
        not *justifications{entity_key: key}`,
    );
    entities = result.rows.map((row) => ({
      key: row[0] as string,
      kind: row[1] as string,
      name: row[2] as string,
      filePath: row[3] as string,
      signature: row[4] as string,
    }));
  }

  if (opts.limit && opts.limit > 0) {
    entities = entities.slice(0, opts.limit);
  }

  if (entities.length === 0) {
    process.stderr.write(
      "[unerr] All entities already have business context. Use --force to re-enrich.\n",
    );
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ enriched: 0, total: 0, skipped: true })}\n`,
      );
    }
    return;
  }

  process.stderr.write(
    `[unerr] Enriching ${entities.length} entities via ${settings.localLlm.chatModel ?? settings.localLlm.provider}...\n`,
  );

  // 4. Create chat provider for LLM calls
  const { LocalChatProvider } = await import("../core/local-chat-provider.js");
  const chatProvider = new LocalChatProvider(settings.localLlm);

  // 5. Process in batches
  const t0 = performance.now();
  let enriched = 0;
  const batchSize = opts.batchSize;

  for (let i = 0; i < entities.length; i += batchSize) {
    const batch = entities.slice(i, i + batchSize);
    const prompt = buildEnrichmentPrompt(batch);

    try {
      const response = await chatProvider.streamChat(
        [{ role: "user", content: prompt }],
        [],
        "You are a precise code analysis assistant. Always respond with valid JSON.",
        4096,
        () => {}, // No streaming UI needed for enrichment
      );

      const results = parseEnrichmentResponse(response.text, batch.length);

      for (let j = 0; j < batch.length; j++) {
        const entity = batch[j];
        const result = results[j];
        if (!entity || !result) continue;

        await graph.loadJustifications([
          {
            entity_key: entity.key,
            purpose: result.purpose,
            taxonomy: result.taxonomy,
            feature_area: result.feature_area,
            confidence: 0.7, // local LLM confidence
          },
        ]);
        enriched++;
      }
    } catch (err) {
      process.stderr.write(
        `[unerr] Batch ${Math.floor(i / batchSize) + 1} failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }

    process.stderr.write(
      `[unerr] Enriched ${enriched}/${entities.length} entities...\n`,
    );
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

  // Justifications are persisted directly in CozoDB — no snapshot re-export needed.

  process.stderr.write(
    `[unerr] Enrichment complete: ${enriched} entities via ${settings.localLlm.chatModel ?? settings.localLlm.provider} in ${elapsed}s\n`,
  );
  process.stderr.write(
    "[unerr]   get_business_context now returns full context for enriched entities\n",
  );

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({
        enriched,
        total: entities.length,
        model: settings.localLlm.chatModel,
        elapsedSeconds: Number.parseFloat(elapsed),
      })}\n`,
    );
  }
}

// ── Commander Registration ─────────────────────────────────────

export function registerEnrichCommand(program: Command): void {
  program
    .command("enrich")
    .description(
      "Generate business context (purpose, taxonomy, feature_area) for code entities via BYO-LLM",
    )
    .option("--batch-size <n>", "Entities per LLM batch", "10")
    .option("--limit <n>", "Max entities to enrich")
    .option("--force", "Re-enrich already-enriched entities")
    .option("--json", "Output results as JSON")
    .action(
      async (opts: {
        batchSize: string;
        limit?: string;
        force?: boolean;
        json?: boolean;
      }) => {
        await runEnrich({
          batchSize: Number.parseInt(opts.batchSize, 10) || 10,
          limit: opts.limit ? Number.parseInt(opts.limit, 10) : undefined,
          force: opts.force,
          json: opts.json,
        });
      },
    );
}
