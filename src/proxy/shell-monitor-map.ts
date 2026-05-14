/**
 * Map shell classifier categories → compression quality monitor content types (FE-F.7).
 */

import type { ContentType } from "./compression-quality-monitor.js";
import type { OutputCategory } from "./shell-classifier.js";

const MAP: Record<OutputCategory, ContentType> = {
  tabular: "shell_tabular",
  structured: "shell_structured",
  log_text: "shell_log_text",
  diff: "shell_diff",
  tree_paths: "shell_tree_paths",
  key_value: "shell_key_value",
  error_diagnostic: "shell_error_diagnostic",
  test_results: "shell_test_results",
  progress_streaming: "shell_progress_streaming",
  yaml: "shell_yaml",
};

export function shellCategoryToContentType(
  category: OutputCategory,
): ContentType {
  return MAP[category];
}
