---
name: using-unerr-work
description: >
  Five tools cover work mode: `fetch_url({url})` fetches a page (bulk: `{urls:[...]}`) — the only web path. `file_read({file_path})` reads a file, a range, or an outline. `file_edit({old_string, new_string})` or `{content}` changes or creates a file. `run_command({command})` runs a shell command — the only shell path. `find_files({pattern})` locates files by name or glob.
---

## unerr work tools

Five tools cover work mode: `fetch_url({url})` fetches a page (bulk: `{urls:[...]}`) — the only web path. `file_read({file_path})` reads a file, a range, or an outline. `file_edit({old_string, new_string})` or `{content}` changes or creates a file. `run_command({command})` runs a shell command — the only shell path. `find_files({pattern})` locates files by name or glob.

Route every web fetch through `fetch_url`. Never call a raw web-fetch tool.
Route every shell run through `run_command`. Never call raw bash.
Read a file with `file_read` before editing it with `file_edit`.
Edit with the smallest exact `old_string`/`new_string` pair that produces the change, or pass `content` to write the whole file.
Locate a file with `find_files` before assuming it does not exist.
