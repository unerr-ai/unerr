/**
 * Public surface of the unerr review engine (.internal/reviewer-architecture.md §4).
 * One engine, three surfaces — import from here, not from internal modules.
 */

export type { ReviewChecker } from "./checker.js";
export { BaseChecker } from "./checker.js";
export {
  ArchitectureBoundaryChecker,
  BlastRadiusChecker,
  bodyTokens,
  BreakingCallersChecker,
  callerEvidence,
  ConventionRuleChecker,
  DeadCodeChecker,
  defaultCheckers,
  DuplicateLogicChecker,
  IncompleteRefactorChecker,
  jaccardSimilarity,
  MemoryDriftChecker,
  resolveChangedEntity,
  SecretScanChecker,
  UntestedExportChecker,
} from "./checkers/index.js";
export { ReviewEngine, type RunOptions } from "./engine.js";
export {
  findingTag,
  formatFindingLine,
  formatReviewFindings,
} from "./format.js";
export {
  buildChangeSet,
  collectRangeChangeFiles,
  collectStagedChangeFiles,
  type GitReviewDeps,
  type GitReviewOptions,
  type GitReviewOutcome,
  isReviewableFile,
  parseRangeScope,
  reviewNotesFromStore,
  reviewRulesFromGraph,
  reviewScopedChanges,
  reviewSearchFromGraph,
  type ReviewScope,
  reviewStagedChanges,
} from "./git-review.js";
export {
  dedupFindings,
  gateFindings,
  meetsFloor,
  sortBySeverity,
  type GateResult,
} from "./gating.js";
export {
  buildReviewReportView,
  renderReviewReportText,
  type ReviewReportFindingView,
  type ReviewReportGroup,
  type ReviewReportView,
  summarizeReviewReport,
} from "./report.js";
export {
  loadStandaloneGraph,
  loadStandaloneNotes,
} from "./standalone-load.js";
export {
  buildSynthesisBlock,
  formatEvidenceContext,
  routeSynthesis,
  selectTier2Findings,
  type SynthesisBlock,
} from "./synthesis.js";
export {
  DEFAULT_REVIEW_CONFIG,
  SEVERITY_RANK,
  type ChangeEntity,
  type ChangeFile,
  type ChangeKind,
  type ChangeSet,
  type ChangeSource,
  type CheckerError,
  type FindingAnchor,
  type ReviewConfig,
  type ReviewContext,
  type ReviewDrift,
  type ReviewFinding,
  type ReviewGraph,
  type ReviewNote,
  type ReviewNotes,
  type ReviewReport,
  type ReviewRules,
  type ReviewRuleViolation,
  type ReviewSearch,
  type ReviewSearchHit,
  type Severity,
} from "./types.js";
