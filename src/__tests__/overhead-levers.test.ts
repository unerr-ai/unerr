import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type LeverEvent,
  readOverheadLeverEvents,
  summarizeOverheadLevers,
} from "../tracking/overhead-levers.js";

describe("summarizeOverheadLevers", () => {
  it("aggregates recon adoption, task-size mix, and digest rate", () => {
    const events: LeverEvent[] = [
      {
        msg: "recon_cli_served",
        sections: 4,
        tokens: 1900,
        task_size: "large_sweep",
        digest: true,
      },
      {
        msg: "recon_cli_served",
        sections: 2,
        tokens: 800,
        task_size: "single_entity",
        digest: false,
      },
      {
        msg: "recon_cli_served",
        sections: 3,
        tokens: 1200,
        task_size: "single_entity",
        digest: false,
      },
      {
        msg: "recon_cli_served",
        sections: 1,
        tokens: 300,
        task_size: "trivial",
        digest: false,
      },
    ];
    const s = summarizeOverheadLevers(events);
    expect(s.recon.count).toBe(4);
    expect(s.recon.avg_sections).toBe(2.5); // (4+2+3+1)/4
    expect(s.recon.avg_tokens).toBe(1050); // (1900+800+1200+300)/4
    expect(s.recon.pct_digest).toBe(25); // 1 of 4
    expect(s.recon.pct_large_sweep).toBe(25); // 1 of 4
    expect(s.recon.by_task_size).toEqual({
      large_sweep: 1,
      single_entity: 2,
      trivial: 1,
    });
  });

  it("counts ceremony suppression per banner", () => {
    const events: LeverEvent[] = [
      { msg: "ceremony_suppressed", banner: "edit-read-prereq" },
      { msg: "ceremony_suppressed", banner: "edit-read-prereq" },
      { msg: "ceremony_suppressed", banner: "read-routing" },
    ];
    const s = summarizeOverheadLevers(events);
    expect(s.ceremony.suppressed_count).toBe(3);
    expect(s.ceremony.by_banner).toEqual({
      "edit-read-prereq": 2,
      "read-routing": 1,
    });
  });

  it("tolerates missing fields and unknown task_size", () => {
    const events: LeverEvent[] = [
      { msg: "recon_cli_served" }, // no sections/tokens/task_size
      {
        msg: "recon_cli_served",
        sections: 2,
        tokens: 500,
        task_size: "single_entity",
      },
      { msg: "ceremony_suppressed" }, // no banner
    ];
    const s = summarizeOverheadLevers(events);
    expect(s.recon.count).toBe(2);
    // only the second contributed to the section/token sums → /2 still
    expect(s.recon.avg_sections).toBe(1); // (0+2)/2
    expect(s.recon.by_task_size.unknown).toBe(1);
    expect(s.ceremony.by_banner.unknown).toBe(1);
  });

  it("returns zeroed summary for no events", () => {
    const s = summarizeOverheadLevers([]);
    expect(s.recon.count).toBe(0);
    expect(s.recon.avg_sections).toBe(0);
    expect(s.recon.pct_digest).toBe(0);
    expect(s.ceremony.suppressed_count).toBe(0);
  });
});

describe("readOverheadLeverEvents", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "unerr-levers-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads lever rows and skips mirrors + malformed + unrelated lines", () => {
    const path = join(dir, "events.jsonl");
    const lines = [
      JSON.stringify({
        ts: "t",
        pid: 1,
        level: "telemetry",
        msg: "recon_cli_served",
        sections: 3,
        task_size: "single_entity",
      }),
      // mirrored step row — msg is prefixed, must be ignored
      JSON.stringify({
        ts: "t",
        pid: 2,
        level: "step",
        msg: "[pid:1] recon_cli_served",
      }),
      JSON.stringify({
        ts: "t",
        pid: 1,
        level: "telemetry",
        msg: "ceremony_suppressed",
        banner: "write-check",
      }),
      // unrelated event
      JSON.stringify({
        ts: "t",
        pid: 1,
        level: "token_flow",
        msg: "shell: 212 saved",
      }),
      "{ not json",
      "",
    ];
    writeFileSync(path, `${lines.join("\n")}\n`);
    const events = readOverheadLeverEvents(path);
    expect(events.length).toBe(2);
    const s = summarizeOverheadLevers(events);
    expect(s.recon.count).toBe(1);
    expect(s.ceremony.suppressed_count).toBe(1);
  });

  it("returns [] when the file is absent", () => {
    expect(readOverheadLeverEvents(join(dir, "nope.jsonl"))).toEqual([]);
  });
});
