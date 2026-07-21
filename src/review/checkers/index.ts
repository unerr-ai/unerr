/**
 * Checker registry (.internal/reviewer-architecture.md §4.1, §11).
 *
 * `defaultCheckers()` is the canonical Tier-1 set the engine registers. Phases
 * append here: P0.3 breaking_callers + blast_radius; P0.4 wraps existing logic
 * (architecture_boundary, convention_rule, incomplete_refactor,
 * untested_export); P0.5 adds duplicate_logic, secret_scan, dead_code.
 */

import type { ReviewChecker } from "../checker.js";
import { ArchitectureBoundaryChecker } from "./architecture-boundary.js";
import { BlastRadiusChecker } from "./blast-radius.js";
import { BreakingCallersChecker } from "./breaking-callers.js";
import { ConventionRuleChecker } from "./convention-rule.js";
import { DeadCodeChecker } from "./dead-code.js";
import { DuplicateLogicChecker } from "./duplicate-logic.js";
import { IncompleteRefactorChecker } from "./incomplete-refactor.js";
import { SecretScanChecker } from "./secret-scan.js";
import { UntestedExportChecker } from "./untested-export.js";

export { ArchitectureBoundaryChecker } from "./architecture-boundary.js";
export { BlastRadiusChecker } from "./blast-radius.js";
export { BreakingCallersChecker } from "./breaking-callers.js";
export { ConventionRuleChecker } from "./convention-rule.js";
export { DeadCodeChecker } from "./dead-code.js";
export { DuplicateLogicChecker } from "./duplicate-logic.js";
export { IncompleteRefactorChecker } from "./incomplete-refactor.js";
export { SecretScanChecker } from "./secret-scan.js";
export {
  bodyTokens,
  callerEvidence,
  jaccardSimilarity,
  resolveChangedEntity,
} from "./shared.js";
export { UntestedExportChecker } from "./untested-export.js";

/** The default Tier-1 checker set, in dispatch order (most severe class first). */
export function defaultCheckers(): ReviewChecker[] {
  return [
    new SecretScanChecker(),
    new BreakingCallersChecker(),
    new IncompleteRefactorChecker(),
    new ArchitectureBoundaryChecker(),
    new BlastRadiusChecker(),
    new ConventionRuleChecker(),
    new DuplicateLogicChecker(),
    new UntestedExportChecker(),
    new DeadCodeChecker(),
  ];
}
