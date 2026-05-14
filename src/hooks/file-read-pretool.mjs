#!/usr/bin/env node
/**
 * Sprint FE-B — PreToolUse helper for IDE hooks that can rewrite Read inputs.
 * When a text file exceeds 200 lines and no window was requested, suggest the first 120 lines.
 *
 * Stdin: hook JSON (shape varies by IDE). We accept common `tool_input` / `path` / `file_path` keys.
 * Stdout: JSON hook response, or `{}` for passthrough.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const stdin = readFileSync(0, "utf-8").trim();
if (!stdin) {
  process.stdout.write("{}");
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(stdin);
} catch {
  process.stdout.write("{}");
  process.exit(0);
}

const input = payload.tool_input ?? payload.input ?? payload;
const fp =
  input?.file_path ?? input?.path ?? input?.filePath ?? payload.file_path;
if (typeof fp !== "string" || fp.length === 0) {
  process.stdout.write("{}");
  process.exit(0);
}

const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
const abs = resolve(cwd, fp);

if (!existsSync(abs)) {
  process.stdout.write("{}");
  process.exit(0);
}

const content = readFileSync(abs, "utf-8");
const lines = content.split("\n");
if (
  lines.length <= 200 ||
  input.offset != null ||
  input.limit != null ||
  input.entity != null
) {
  process.stdout.write("{}");
  process.exit(0);
}

const updatedInput = { ...input, offset: 1, limit: 120 };

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      permissionDecision: "allow",
      updatedInput,
    },
  }),
);
