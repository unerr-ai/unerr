/**
 * SARIF 2.1.0 export for review findings (.internal/reviewer-architecture.md §16).
 *
 * SARIF (Static Analysis Results Interchange Format) is the standard JSON shape
 * GitHub Code-Scanning, VS Code, and other tools ingest. This converts a review
 * report into a valid SARIF 2.1.0 log — no npm dependency, just a minimal local
 * type and a pure builder. The mapping:
 *
 *   checkerId   → reporting descriptor (rule) id + driver `rules[]`
 *   severity    → SARIF `level` (info/low/medium → note, high → warning,
 *                 critical → error) + a `security-severity` rank property
 *   title       → result message text
 *   targetFile  → `physicalLocation.artifactLocation.uri`
 *   startLine   → `physicalLocation.region.startLine`
 *
 * @sem domain=review role=export
 */

import type { ReviewReportView } from "./report.js";
import type { Severity } from "./types.js";

/** SARIF severity level — the three-value scale tools render. */
export type SarifLevel = "none" | "note" | "warning" | "error";

interface SarifArtifactLocation {
  uri: string;
}

interface SarifRegion {
  startLine: number;
}

interface SarifPhysicalLocation {
  artifactLocation: SarifArtifactLocation;
  region?: SarifRegion;
}

interface SarifLocation {
  physicalLocation: SarifPhysicalLocation;
}

interface SarifReportingDescriptor {
  id: string;
  name?: string;
  shortDescription?: { text: string };
  properties?: Record<string, unknown>;
}

interface SarifResult {
  ruleId: string;
  level: SarifLevel;
  message: { text: string };
  locations?: SarifLocation[];
  properties?: Record<string, unknown>;
}

interface SarifTool {
  driver: {
    name: string;
    informationUri?: string;
    version?: string;
    rules: SarifReportingDescriptor[];
  };
}

interface SarifRun {
  tool: SarifTool;
  results: SarifResult[];
}

/** A complete SARIF 2.1.0 log — JSON-serialisable as-is. */
export interface SarifLog {
  $schema: string;
  version: "2.1.0";
  runs: SarifRun[];
}

const SARIF_SCHEMA =
  "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json";

/** Map a review {@link Severity} to a SARIF level. */
export function severityToSarifLevel(severity: Severity): SarifLevel {
  switch (severity) {
    case "critical":
      return "error";
    case "high":
      return "warning";
    default:
      // info | low | medium → note (the advisory tier in SARIF's 3-level scale).
      return "note";
  }
}

/**
 * A GitHub `security-severity` numeric rank (0.0–10.0) derived from the 5-level
 * review severity, so Code-Scanning can sort/filter by it. The exact 5-level
 * value is preserved separately in result properties.
 */
function securitySeverityRank(severity: Severity): string {
  switch (severity) {
    case "critical":
      return "9.0";
    case "high":
      return "7.0";
    case "medium":
      return "5.0";
    case "low":
      return "3.0";
    default:
      return "1.0";
  }
}

/**
 * Convert a {@link ReviewReportView} into a valid SARIF 2.1.0 log. Each distinct
 * `checkerId` becomes one reporting descriptor (rule) in the driver; each finding
 * becomes one result anchored to its file + line when file-bound. Entity-bound
 * findings (no `target_file`) carry no physical location — SARIF allows a result
 * with no location.
 *
 * @sem domain=review role=export
 */
export function reviewReportToSarif(
  view: ReviewReportView,
  toolVersion?: string
): SarifLog {
  const ruleById = new Map<string, SarifReportingDescriptor>();
  const results: SarifResult[] = [];

  for (const group of view.groups) {
    const isFile = group.anchorKind === "file";
    const anchorValue = group.anchor.replace(/^[fe]:/, "");

    for (const f of group.findings) {
      if (!ruleById.has(f.checkerId)) {
        ruleById.set(f.checkerId, {
          id: f.checkerId,
          name: f.checkerId,
          shortDescription: { text: `unerr review checker: ${f.checkerId}` },
        });
      }

      const result: SarifResult = {
        ruleId: f.checkerId,
        level: severityToSarifLevel(f.severity),
        message: {
          text: f.action ? `${f.title} — ${f.action}` : f.title,
        },
        properties: {
          severity: f.severity,
          tier: f.tier,
          needsModel: f.needsModel,
          "security-severity": securitySeverityRank(f.severity),
        },
      };

      if (isFile) {
        const physicalLocation: SarifPhysicalLocation = {
          artifactLocation: { uri: anchorValue },
        };
        if (f.line !== undefined) {
          physicalLocation.region = { startLine: f.line };
        }
        result.locations = [{ physicalLocation }];
      }

      results.push(result);
    }
  }

  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "unerr",
            informationUri: "https://unerr.ai",
            ...(toolVersion ? { version: toolVersion } : {}),
            rules: [...ruleById.values()],
          },
        },
        results,
      },
    ],
  };
}
