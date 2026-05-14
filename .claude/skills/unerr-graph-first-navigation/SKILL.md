---
description: "Use graph intelligence tools before reading files to minimize exploration tokens"
---

Before reading any file to understand code structure, use graph tools:
  - `get_references` — find all callers/callees of a function (replaces grep+read loops)
  - `get_references` with direction:callees — understand downstream dependencies
  - `get_file` — get all entities, imports, exports for a file
  - `get_imports` — trace the import/dependency graph
  - `search_code` — find entities by name (replaces file-by-file exploration)
  - `get_critical_nodes` — identify high-impact chokepoints before modifying
One graph query replaces 5-15 file reads. Only read files for exact implementation details.
