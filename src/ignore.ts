/**
 * Shared ignore-file loader for CLI commands.
 * Supports .gitignore + .unerrignore with gitignore syntax.
 *
 * Standard ignore patterns for indexing. The CLI adds `.unerr`
 * (local config dir) to the standard set.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Directories always excluded — standard ignore patterns
 * plus `.unerr` (CLI local config directory).
 */
const ALWAYS_IGNORE = [
  // Version control
  ".git",
  ".svn",
  ".hg",
  // JavaScript / TypeScript
  "node_modules",
  ".next",
  ".turbo",
  ".yarn",
  ".pnp",
  // Python
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "venv",
  ".eggs",
  // Rust
  "target",
  // Java / Kotlin / Scala
  ".gradle",
  ".mvn",
  // C# / .NET
  "bin",
  "obj",
  ".nuget",
  // Ruby
  ".bundle",
  // Generic build / tooling
  "dist",
  "build",
  "out",
  "vendor",
  ".cache",
  "coverage",
  ".idea",
  ".vscode",
  // CI / DevOps
  ".github",
  ".circleci",
  ".devcontainer",
  // Test infrastructure
  "__tests__",
  "__mocks__",
  "__snapshots__",
  "__fixtures__",
  "test-d",
  // Developer tooling configs
  ".storybook",
  ".husky",
  ".changeset",
  ".nx",
  ".parcel-cache",
  ".swc",
  ".esbuild",
  ".docusaurus",
  // CLI-specific
  ".unerr",
];

/**
 * Glob patterns that require the `ignore` package for matching.
 * Standard ignore patterns.
 */
const ALWAYS_IGNORE_GLOBS = [
  "*.egg-info/",
  "*.test-d.ts",
  "*.bench.js",
  "*.bench.ts",
  "*.min.js",
  "*.min.css",
  "*.d.ts.map",
  "*.js.map",
];

/**
 * Create an ignore filter for a project root.
 * @returns An ignore instance with .ignores(relativePath) method.
 */
export async function createIgnoreFilter(cwd: string) {
  // `ignore` is CJS (`export = ignore`), so a dynamic import hands back the
  // callable itself under some interop paths and `{default: callable}` under
  // others — hence the `??`. Its types carried a `default` member up to v6 and
  // dropped it in v7, so name the published `Ignore` type instead of reaching
  // through `["default"]`, which no longer exists.
  const ignoreMod = await import("ignore");
  const ignore = ignoreMod.default ?? ignoreMod;
  const ig = (ignore as unknown as () => import("ignore").Ignore)();

  ig.add(ALWAYS_IGNORE.map((d) => `${d}/`));
  ig.add(ALWAYS_IGNORE_GLOBS);

  // .gitignore
  const gitignorePath = path.join(cwd, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, "utf-8"));
  }

  // .unerrignore
  const unerrignorePath = path.join(cwd, ".unerrignore");
  if (fs.existsSync(unerrignorePath)) {
    ig.add(fs.readFileSync(unerrignorePath, "utf-8"));
  }

  return ig;
}
