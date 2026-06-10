/**
 * Startup renderer — bridge between proxy boot sequence and Ink display.
 *
 * The proxy calls StartupRenderer methods during boot steps.
 * The renderer drives the Ink StartupDisplay component on stderr.
 *
 * Handles first_boot_shown flag persistence in .unerr/state/graph_version.json.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Instance } from "ink";
import React from "react";
import {
  type LocalIndexStats,
  StartupDisplay,
  type StartupState,
  type StartupStep,
} from "../components/StartupDisplay.js";
import type { StepStatus } from "../components/StepLine.js";
import { ThemeProvider } from "../components/Theme.js";
import { renderToStderr } from "../components/render.js";
import type { HealthGradeResult } from "../intelligence/health-grade.js";
import { buildDeepLink } from "../utils/deep-link.js";

export class StartupRenderer {
  private state: StartupState;
  private instance: Instance | null = null;
  private stepMap = new Map<string, number>();
  private repoId: string | undefined;

  constructor() {
    this.state = {
      steps: [],
      firstBoot: false,
      ready: false,
      localMode: false,
    };
  }

  /** Start the Ink display on stderr. */
  mount(): void {
    this.instance = renderToStderr(this.renderElement());
  }

  /** Add a step to the sequence. Returns step index for updates. */
  addStep(label: string, status: StepStatus = "pending", value?: string): void {
    this.stepMap.set(label, this.state.steps.length);
    this.state.steps.push({ label, value, status });
    this.rerender();
  }

  /** Update a step's status and optional value. */
  updateStep(label: string, status: StepStatus, value?: string): void {
    const idx = this.stepMap.get(label);
    if (idx === undefined) return;
    const step = this.state.steps[idx];
    if (!step) return;
    step.status = status;
    if (value !== undefined) step.value = value;
    this.rerender();
  }

  /** Set the health grade result for Act 2 display. */
  setHealth(health: HealthGradeResult, repoId?: string): void {
    this.repoId = repoId;
    this.state.health = health;
    this.state.firstBoot = this.isFirstBoot();

    // Pick most interesting entity for invitation
    if (health.highRiskEntities.length > 0) {
      this.state.invitationEntity = health.highRiskEntities[0]?.name;
    }

    // Set deep link — NEVER in Local Mode (TL-18)
    if (repoId && !this.state.localMode) {
      this.state.deepLink = buildDeepLink(repoId, {
        view: "health",
        utm_source: this.state.firstBoot ? "cli_first_boot" : "cli_startup",
      });
    }

    // Mark first boot as shown
    if (this.state.firstBoot) {
      this.markFirstBootShown();
    }

    this.rerender();
  }

  /** Mark proxy as ready (Act 3). */
  setReady(proxyMode?: string): void {
    this.state.ready = true;
    this.state.proxyMode = proxyMode;

    // If no health data, still show deep link — NEVER in Local Mode (TL-18)
    if (!this.state.deepLink && this.repoId && !this.state.localMode) {
      this.state.deepLink = buildDeepLink(this.repoId, {
        utm_source: "cli_startup",
      });
    }

    this.rerender();
  }

  // ── Local Mode Methods ────────────────────────────────────────────

  /** Enable Local Mode rendering. Must be called before setHealth/setReady. */
  setLocalMode(enabled: boolean): void {
    this.state.localMode = enabled;
    if (enabled) {
      this.state.deepLink = undefined;
    }
    this.rerender();
  }

  /** Set Local Mode indexing statistics for Act 1. */
  setLocalIndexStats(indexStats: LocalIndexStats): void {
    this.state.localIndexStats = indexStats;
    this.rerender();
  }

  /** Set the total tool count for Act 3. */
  setToolCount(count: number): void {
    this.state.toolCount = count;
    this.rerender();
  }

  /** Unmount the Ink display (after startup completes). */
  unmount(): void {
    this.instance?.unmount();
    this.instance = null;
  }

  // ── First boot tracking ──────────────────────────────────────────

  private isFirstBoot(): boolean {
    const versionPath = join(
      process.cwd(),
      ".unerr",
      "state",
      "graph_version.json"
    );
    if (!existsSync(versionPath)) return true;
    try {
      const data = JSON.parse(readFileSync(versionPath, "utf-8")) as {
        first_boot_shown?: boolean;
      };
      return !data.first_boot_shown;
    } catch {
      return true;
    }
  }

  private markFirstBootShown(): void {
    const stateDir = join(process.cwd(), ".unerr", "state");
    const versionPath = join(stateDir, "graph_version.json");
    try {
      let data: Record<string, unknown> = {};
      if (existsSync(versionPath)) {
        data = JSON.parse(readFileSync(versionPath, "utf-8")) as Record<
          string,
          unknown
        >;
      }
      data.first_boot_shown = true;
      writeFileSync(versionPath, JSON.stringify(data, null, 2));
    } catch {
      // Non-critical
    }
  }

  // ── Ink rendering ────────────────────────────────────────────────

  private renderElement(): React.ReactElement {
    return React.createElement(
      ThemeProvider,
      null,
      React.createElement(StartupDisplay, {
        state: this.state,
      })
    );
  }

  private rerender(): void {
    if (this.instance) {
      this.instance.rerender(this.renderElement());
    }
  }
}
