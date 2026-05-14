---
description: "Trace dependency chains before moving, renaming, or restructuring code"
user-invocable: false
---

When refactoring code across files:

1. Call `get_file` on each file being modified to understand its entity graph
2. Call `get_imports` to trace dependency chains — never move code without knowing what depends on it
3. Call `get_cross_boundary_links` to find unexpected cross-module dependencies
4. For each entity being moved/renamed:
   - Call `get_references` to find all references that need updating
   - Update all callers before or immediately after the rename
5. After refactoring, verify: call `get_references` on the new location to confirm references updated

Do not refactor in isolation. The graph knows every reference — use it.
