---
name: unerr-using-unerr
description: "unerr's MCP tools for code in this repo: search_code finds code by name or task phrase (recon bundle with callers and conventions), file_read reads files/line-ranges/entities/outlines, file_edit changes files, get_references lists every use of an identifier for renames and signature changes, fetch_url fetches web pages (bulk urls supported). Reach for these before shell or built-in file tools when navigating or editing code."
---

## unerr tools

`search_code({query})` finds code by name or task phrase — a phrase returns a recon bundle (callers, conventions). `file_read({file_path})` reads a file, a range, an entity, or an outline. `file_edit` changes a file. `get_references({key})` lists every caller/callee of an identifier — add `include_text_occurrences:true` for a rename. `fetch_url({url})` fetches a page (bulk: `{urls:[...]}`).

`unerr-worker` / `unerr-junior` sub-agents exist for delegable slices — their descriptions say when.
