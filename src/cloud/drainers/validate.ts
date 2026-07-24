/**
 * unerr cloud — contract validation for outbound wire rows.
 *
 * Every row a drainer builds is validated against its `@unerr-ai/contracts`
 * body BEFORE it leaves the machine. The contract is the single source of the
 * wire shape, so a drainer whose hand-built row drifts from the contract is
 * caught here instead of in production.
 *
 * Fail mode:
 *   - production (default): an invalid row is DROPPED and logged. Telemetry
 *     must never crash a turn, and the web-service validates with the SAME
 *     contract, so a contract-invalid row was never going to be ingested —
 *     dropping it client-side loses nothing the server would have kept.
 *   - tests / CI (`UNERR_CONTRACT_STRICT=1`): the first mismatch THROWS, so a
 *     shape drift fails the suite instead of silently shrinking telemetry.
 *
 * LIMIT — `detail` is a `looseObject`. The `/events` and `/traces` `detail`
 * tails keep unknown keys for forward compatibility, so this catches a
 * missing-required or wrong-typed `detail` field and any envelope / top-level
 * drift, but NOT an extra or renamed `detail` key. Renamed detail keys are a
 * review concern, not something zod can police here.
 *
 */

/**
 * The minimal surface we use from a contract zod schema: `safeParse`. Typing on
 * this structural shape — rather than zod's `ZodType` — keeps the validators
 * assignable across the CLI's zod and the contract's bundled zod (whose deeply
 * generic `ZodObject` types are not mutually assignable under zod 4 variance).
 */
export interface ContractSchema {
  safeParse(value: unknown):
    | { success: true; data: unknown }
    | {
        success: false;
        error: { issues: Array<{ path: PropertyKey[]; message: string }> };
      };
}

/**
 * Whether contract validation should THROW on a mismatch instead of dropping
 * the row. Set `UNERR_CONTRACT_STRICT=1` in tests / CI so a wire-shape drift
 * fails loudly; production leaves it unset so a bad row is dropped, not fatal.
 */
export function contractStrict(): boolean {
  return process.env.UNERR_CONTRACT_STRICT === "1";
}

/** The first zod issue as a compact `path: message` string for one log line. */
function firstIssue(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string {
  const issue = error.issues[0];
  if (!issue) return "invalid";
  const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
  return `${path}: ${issue.message}`;
}

/**
 * Validate a batch of built wire rows against a contract schema. Returns the
 * rows that pass; drops (and logs) the rows that fail. Under
 * `UNERR_CONTRACT_STRICT=1` the first failing row throws instead.
 *
 */
export function validateRows(
  schema: ContractSchema,
  rows: unknown[],
  streamKey: string,
  log?: (msg: string) => void
): unknown[] {
  const kept: unknown[] = [];
  for (const row of rows) {
    const res = schema.safeParse(row);
    if (res.success) {
      kept.push(row);
      continue;
    }
    const msg = `contract mismatch on ${streamKey}: ${firstIssue(res.error)}`;
    if (contractStrict()) throw new Error(msg);
    log?.(`push: ${msg} — row dropped`);
  }
  return kept;
}

/**
 * Validate a whole request body (e.g. a fleet snapshot) against a contract
 * schema. Returns true when it conforms. On a mismatch: throws under
 * `UNERR_CONTRACT_STRICT=1`, else logs and returns false. The caller decides
 * whether a false result blocks the send.
 *
 */
export function validateBody(
  schema: ContractSchema,
  body: unknown,
  label: string,
  log?: (msg: string) => void
): boolean {
  const res = schema.safeParse(body);
  if (res.success) return true;
  const msg = `contract mismatch on ${label}: ${firstIssue(res.error)}`;
  if (contractStrict()) throw new Error(msg);
  log?.(`${msg}`);
  return false;
}
