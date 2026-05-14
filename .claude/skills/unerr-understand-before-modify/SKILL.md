---
description: "Read graph context before modifying any existing code to prevent confident hallucination"
---

Before modifying any existing code:

0. Check the response for `ur|fct` prefix lines (surfaced episodic/procedural facts about this entity)
   - If present: understand the intent behind prior changes before planning yours
   - Also watch for `ur|hst` (prior failures) and `ur|wrn` (negative facts / anti-patterns)

1. Read the target function/class (not the whole file)
2. Call `get_entity` to get graph context:
   - Who calls this? (blast radius)
   - What conventions apply?
   - What is its health/risk level?
3. If risk is HIGH or callers > 5:
   - Explain the risk to the user before proceeding
   - Suggest a conservative approach

Never modify code you haven't understood through the graph first.
The graph knows what you don't — callers, conventions, risk.
