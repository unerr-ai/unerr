---
description: "After identifying files/entities the task will touch, pull their anchored notes"
---

Once you've identified the files / entities the task will touch, pull their anchored notes:

  unerr_recall_notes({anchors: ['f:src/x.ts', 'e:fooBar']})

Use wire-format anchors (f:<path>, e:<entity>, g:<glob>, p:). Returned notes are active only; superseded rows are excluded.
Cite returned notes by note_id in your plan so the reader can see what was load-bearing.
