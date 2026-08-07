/**
 * unerr cloud — sync facade.
 *
 * This is the only module under `src/cloud/sync/` that code outside
 * `src/cloud/` may import from. It re-exports exactly the client,
 * conventions-sync, push-drain, and identity symbols that external callers
 * use today — nothing else, no logic of its own.
 *
 * Rule for code INSIDE `src/cloud/`: always import the concrete module
 * directly (e.g. `../sync/client.js`), never this facade or a sibling
 * folder's facade. Routing an internal import through a facade creates a
 * module-init cycle — `auth/device-flow.ts` needs `sync/client.js`,
 * `plan/entitlements.ts` needs `sync/client.js`'s types, `sync/client.ts`
 * needs `config.js` — importing the facade instead of the concrete file
 * pulls in every other export in the folder, including ones that import
 * back into `auth/` or `plan/`.
 */

export { CloudClient, assertSafeBaseUrl } from "./client.js";
export {
  PERSONAL_SCOPE_MESSAGE,
  isPersonalScope,
  readTeamConventions,
  scopeFromEntitlements,
  syncConventions,
  writeTeamConventions,
} from "./conventions-sync.js";
export { hashEntityKey } from "./drainers/envelope.js";
export { assembleDrainers } from "./drainers/index.js";
export {
  reapDrainedDeadSegments,
  truncateDrainedLongLivedSegments,
} from "./drainers/ingest.js";
export { validateBody } from "./drainers/validate.js";
export { deterministicId } from "./event-id.js";
export { computeMachineFingerprint } from "./machine-fingerprint.js";
export { PushCursor } from "./push-cursor.js";
export type { BuildDrainers, DrainOutcome } from "./push-drainer.js";
export { drainRepo } from "./push-drainer.js";
export { deriveRepoId } from "./repo-identity.js";
export { emitRepoRemoved } from "./repo-removal.js";
