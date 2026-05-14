/**
 * Test File & Entity Detection — Single Source of Truth (Sprint R.8)
 *
 * Determines whether a file/entity is test code across all supported languages.
 * All consumers (health-grade, convention-detector, blast-radius, community detection)
 * should use these functions instead of inline regex.
 *
 * Supported languages: TypeScript/JavaScript, Python, Go, Java, Rust, Ruby, C#, C/C++
 */

import { basename } from "node:path";

// ── File-Level Patterns ─────────────────────────────────────────

/** Directory-based test patterns (match against full path) */
const TEST_DIR_PATTERNS: RegExp[] = [
  /(?:^|[/\\])__tests__[/\\]/,
  /(?:^|[/\\])tests?[/\\]/,
  /(?:^|[/\\])spec[/\\]/,
  /(?:^|[/\\])src[/\\]test[/\\]/, // Java Maven/Gradle convention
];

/** Suffix/prefix-based test patterns (match against full path or basename) */
const TEST_FILE_PATTERNS: RegExp[] = [
  // TS/JS: foo.test.ts, foo.spec.tsx
  /\.(?:test|spec)\.[^.]+$/,
  // Go: foo_test.go
  /_test\.go$/,
  // Python: test_foo.py
  /(?:^|[/\\])test_[^/\\]+\.py$/,
  // Python: foo_test.py
  /_test\.py$/,
  // Python: conftest.py (test infrastructure)
  /conftest\.py$/,
  // Java/Kotlin: FooTest.java, FooTests.java, FooIT.java (integration test)
  /(?:Test|Tests|IT)\.(?:java|kt)$/,
  // Ruby: foo_spec.rb, foo_test.rb
  /[_.](?:spec|test)\.rb$/,
  // C#: FooTests.cs, FooTest.cs
  /Tests?\.cs$/,
  // C/C++: foo_test.cpp, test_foo.c
  /(?:_test|_spec)\.[ch](?:pp|c|xx)?$/,
  /(?:^|[/\\])test_[^/\\]+\.[ch](?:pp|c|xx)?$/,
  // Rust: in tests/ directory (caught by dir pattern), or _test.rs
  /_test\.rs$/,
];

/**
 * Determine if a file path represents a test file.
 *
 * @param filePath - Relative file path from project root
 * @returns true if the file is a test file
 */
export function isTestFile(filePath: string): boolean {
  // Check directory patterns
  for (const pattern of TEST_DIR_PATTERNS) {
    if (pattern.test(filePath)) return true;
  }
  // Check file name patterns
  for (const pattern of TEST_FILE_PATTERNS) {
    if (pattern.test(filePath)) return true;
  }
  return false;
}

/**
 * Determine if an entity should be marked as a test entity.
 *
 * For most languages, all entities in a test file are test entities.
 * Future: Rust `#[cfg(test)]` inline modules could use AST scope detection.
 *
 * @param filePath - Entity's file path
 * @returns true if the entity is a test entity
 */
export function isTestEntity(filePath: string): boolean {
  return isTestFile(filePath);
}

/**
 * Given a test file path, attempt to resolve the source file it tests.
 * Uses naming conventions (file stem matching) across all languages.
 *
 * @param testFilePath - Path to the test file
 * @param projectFiles - Set of all project file paths
 * @returns The source file path, or null if not determinable
 */
export function resolveTestSubject(
  testFilePath: string,
  projectFiles: Set<string>,
): string | null {
  const base = basename(testFilePath);

  // Strip test indicators from filename to get source stem
  const candidates = getSourceCandidates(testFilePath, base);

  for (const candidate of candidates) {
    if (projectFiles.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Generate candidate source file paths from a test file path.
 */
function getSourceCandidates(testFilePath: string, base: string): string[] {
  const dir = testFilePath.slice(0, testFilePath.length - base.length);
  const candidates: string[] = [];

  // TS/JS: foo.test.ts → foo.ts
  const tsMatch = base.match(/^(.+)\.(?:test|spec)(\.[^.]+)$/);
  if (tsMatch) {
    const [, stem, ext] = tsMatch;
    // Same directory
    candidates.push(`${dir}${stem}${ext}`);
    // Parent directory (for __tests__/foo.test.ts → ../foo.ts)
    const parentDir = dir.replace(/(?:__tests__|tests?|spec)[/\\]$/, "");
    if (parentDir !== dir) {
      candidates.push(`${parentDir}${stem}${ext}`);
    }
    return candidates;
  }

  // Go: foo_test.go → foo.go
  if (base.endsWith("_test.go")) {
    const stem = base.slice(0, -8); // remove _test.go
    candidates.push(`${dir}${stem}.go`);
    return candidates;
  }

  // Python: test_foo.py → foo.py
  const pyPrefixMatch = base.match(/^test_(.+\.py)$/);
  if (pyPrefixMatch) {
    candidates.push(`${dir}${pyPrefixMatch[1]}`);
    // Also check parent (tests/test_foo.py → ../foo.py)
    const parentDir = dir.replace(/(?:tests?)[/\\]$/, "");
    if (parentDir !== dir) {
      candidates.push(`${parentDir}${pyPrefixMatch[1]}`);
    }
    return candidates;
  }

  // Python: foo_test.py → foo.py
  if (base.endsWith("_test.py")) {
    const stem = base.slice(0, -8);
    candidates.push(`${dir}${stem}.py`);
    return candidates;
  }

  // Java/Kotlin: FooTest.java → Foo.java
  const javaMatch = base.match(/^(.+?)(?:Test|Tests|IT)(\.(java|kt))$/);
  if (javaMatch) {
    const [, stem, ext] = javaMatch;
    candidates.push(`${dir}${stem}${ext}`);
    // Maven: src/test/java/... → src/main/java/...
    const mainDir = dir.replace(/src[/\\]test[/\\]/, "src/main/");
    if (mainDir !== dir) {
      candidates.push(`${mainDir}${stem}${ext}`);
    }
    return candidates;
  }

  // Ruby: foo_spec.rb → foo.rb
  const rbMatch = base.match(/^(.+)[_.](?:spec|test)(\.rb)$/);
  if (rbMatch) {
    const [, stem, ext] = rbMatch;
    candidates.push(`${dir}${stem}${ext}`);
    // spec/models/user_spec.rb → app/models/user.rb or lib/models/user.rb
    const specDir = dir.replace(/(?:spec|test)[/\\]/, "");
    if (specDir !== dir) {
      candidates.push(`${specDir}${stem}${ext}`);
      candidates.push(`${specDir.replace(/^/, "app/")}${stem}${ext}`);
      candidates.push(`${specDir.replace(/^/, "lib/")}${stem}${ext}`);
    }
    return candidates;
  }

  // C#: FooTests.cs → Foo.cs
  const csMatch = base.match(/^(.+?)Tests?(\.cs)$/);
  if (csMatch) {
    const [, stem, ext] = csMatch;
    candidates.push(`${dir}${stem}${ext}`);
    // Tests/FooTests.cs → Src/Foo.cs or Services/Foo.cs
    const srcDir = dir.replace(/\.?Tests?[/\\]/, "/");
    if (srcDir !== dir) {
      candidates.push(`${srcDir}${stem}${ext}`);
    }
    return candidates;
  }

  // Rust: foo_test.rs → foo.rs
  if (base.endsWith("_test.rs")) {
    const stem = base.slice(0, -8);
    candidates.push(`${dir}${stem}.rs`);
    // tests/foo_test.rs → src/foo.rs
    const srcDir = dir.replace(/tests?[/\\]/, "src/");
    if (srcDir !== dir) {
      candidates.push(`${srcDir}${stem}.rs`);
    }
    return candidates;
  }

  // C/C++: foo_test.cpp → foo.cpp
  const cMatch = base.match(/^(.+?)_test(\.[ch](?:pp|c|xx)?)$/);
  if (cMatch) {
    const [, stem, ext] = cMatch;
    candidates.push(`${dir}${stem}${ext}`);
    return candidates;
  }
  const cPrefixMatch = base.match(/^test_(.+\.[ch](?:pp|c|xx)?)$/);
  if (cPrefixMatch) {
    candidates.push(`${dir}${cPrefixMatch[1]}`);
    return candidates;
  }

  return candidates;
}
