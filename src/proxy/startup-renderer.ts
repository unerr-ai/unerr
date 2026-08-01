/**
 * Startup renderer — bridge between proxy boot sequence and Ink display.
 *
 * The proxy calls StartupRenderer methods during boot steps.
 * The renderer drives the Ink StartupDisplay component on stderr.
 *
 */

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
import { buildDeepLink } from "../utils/deep-link.js";

export class StartupRenderer {
  private state: StartupState;
  private instance: Instance | null = null;
  private stepMap = new Map<string, number>();
  private repoId: string | undefined;

  constructor() {
    this.state = {
      steps: [],
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

  /** Mark proxy as ready (Act 3). */
  setReady(proxyMode?: string): void {
    this.state.ready = true;
    this.state.proxyMode = proxyMode;

    // Show the deep link — NEVER in Local Mode (TL-18)
    if (!this.state.deepLink && this.repoId && !this.state.localMode) {
      this.state.deepLink = buildDeepLink(this.repoId, {
        utm_source: "cli_startup",
      });
    }

    this.rerender();
  }

  // ── Local Mode Methods ────────────────────────────────────────────

  /** Enable Local Mode rendering. Must be called before setReady. */
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
