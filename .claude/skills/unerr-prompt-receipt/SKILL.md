---
description: "First action on every user prompt — call unerr_recall_notes with the verbatim prompt"
---

When a user prompt arrives, your FIRST tool call is:

  unerr_recall_notes({prompt: '<verbatim prompt text>'})

Empty result is fine. The call is the contract — it loads anchored notes for likely targets and a topic-shift flag.
Skip this only if the prompt is trivially small-talk ('thanks', 'ok').
