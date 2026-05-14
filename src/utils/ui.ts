/**
 * Branded terminal output utilities.
 *
 * Follows Claude Code-style output patterns:
 *  - Section markers: ● (in progress), ✓ (done), ✗ (failed)
 *  - 2-space indent for detail lines
 *  - Colors: cyan for info, green for success, red for error, dim for metadata
 */

import pc from "picocolors";

export const brand = {
  name: "unerr",
  tagline: "Code intelligence for AI agents",
};

export function banner(): void {
  console.log("");
  console.log(`  ${pc.bold(pc.cyan(brand.name))}  ${pc.dim(brand.tagline)}`);
  console.log("");
}

export function section(label: string): void {
  console.log(`  ${pc.cyan("●")} ${label}`);
}

export function success(label: string): void {
  console.log(`  ${pc.green("✓")} ${label}`);
}

export function fail(label: string): void {
  console.log(`  ${pc.red("✗")} ${label}`);
}

export function info(label: string): void {
  console.log(`    ${label}`);
}

export function detail(label: string): void {
  console.log(`    ${pc.dim(label)}`);
}

export function warn(label: string): void {
  console.log(`    ${pc.yellow(label)}`);
}

export function blank(): void {
  console.log("");
}

export function done(label: string): void {
  console.log("");
  console.log(`  ${pc.green("✓")} ${pc.bold(pc.green(label))}`);
  console.log("");
}

export function dimLabel(key: string, value: string): string {
  return `${pc.dim(`${key}:`)} ${value}`;
}

/**
 * Format a choices list for display (used alongside prompts).
 */
export function formatChoice(label: string, meta?: string): string {
  if (meta) return `${label} ${pc.dim(`(${meta})`)}`;
  return label;
}

export { pc };
