import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { parseReconArgs, registerReconCommand } from "../commands/recon.js";

describe("parseReconArgs", () => {
  it("reads a single quoted-prompt operand", () => {
    const r = parseReconArgs(["recon", "edit fooBar and check callers"]);
    expect(r.prompt).toBe("edit fooBar and check callers");
    expect(r.budget).toBe(2000);
    expect(r.json).toBe(false);
  });

  it("joins multiple bare operands into the prompt", () => {
    const r = parseReconArgs(["recon", "edit", "fooBar", "now"]);
    expect(r.prompt).toBe("edit fooBar now");
  });

  it("parses --budget and --json flags", () => {
    const r = parseReconArgs([
      "recon",
      "do thing",
      "--budget",
      "500",
      "--json",
    ]);
    expect(r.budget).toBe(500);
    expect(r.json).toBe(true);
    expect(r.prompt).toBe("do thing");
    expect(r.digest).toBe(false);
  });

  it("parses the --digest flag (large-sweep return shape)", () => {
    const r = parseReconArgs(["recon", "rename fooBar everywhere", "--digest"]);
    expect(r.digest).toBe(true);
    expect(r.prompt).toBe("rename fooBar everywhere");
  });

  it("treats everything after `--` as the prompt", () => {
    const r = parseReconArgs(["recon", "--", "--budget", "is", "literal"]);
    expect(r.prompt).toBe("--budget is literal");
    // flags after -- are not consumed as options
    expect(r.budget).toBe(2000);
  });

  it("ignores a non-positive or non-numeric budget", () => {
    expect(parseReconArgs(["recon", "x", "--budget", "0"]).budget).toBe(2000);
    expect(parseReconArgs(["recon", "x", "--budget", "abc"]).budget).toBe(2000);
  });

  it("returns an empty prompt when none given", () => {
    expect(parseReconArgs(["recon", "--json"]).prompt).toBe("");
  });

  it("works when argv has leading noise before `recon`", () => {
    const r = parseReconArgs(["node", "cli.js", "recon", "find writers"]);
    expect(r.prompt).toBe("find writers");
  });
});

// T5.2 — namespace sanity: registering recon must not disturb the rest of the
// CLI surface, and the command must register cleanly under its own name.
describe("registerReconCommand", () => {
  it("adds a `recon` command without throwing or shadowing siblings", () => {
    const program = new Command();
    // a representative sibling so we'd catch a name collision / clobber
    program.command("status").description("existing");
    registerReconCommand(program);
    const names = program.commands.map((c) => c.name());
    expect(names).toContain("recon");
    expect(names).toContain("status");
    // exactly one recon command — no accidental duplicate registration
    expect(names.filter((n) => n === "recon").length).toBe(1);
  });

  it("describes recon as a one-shot composite", () => {
    const program = new Command();
    registerReconCommand(program);
    const recon = program.commands.find((c) => c.name() === "recon");
    expect(recon?.description().toLowerCase()).toContain("composite");
  });
});
