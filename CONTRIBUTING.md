# Contributing to the unerr docs

## Add a page

1. Create an `.mdx` file under `content/docs/` (or a section subfolder).
2. Give it frontmatter with a title and description:

   ```mdx
   ---
   title: Page title
   description: One line on what the page covers.
   ---

   Page content.
   ```

3. Add the file's slug (its name without `.mdx`) to the folder's `meta.json` `pages` array, in the order it should appear:

   ```json
   { "title": "Section title", "pages": ["index", "your-new-slug"] }
   ```

## Preview locally

```bash
pnpm dev
```

Then open http://localhost:3000/docs.

## Writing rule

Less text, more information.

- Plain language. Define a term the first time you use it; otherwise avoid jargon and acronyms.
- No sales or marketing words. State what something does, not how great it is.
- Structure over prose. Prefer tables and short lists to paragraphs. Lead with the answer.
- Be concrete. Name the actual file, command, number, or result.
- Say it straight. If something is missing, broken, or unsure, say so.

## Research rule

Use smart, query-based web searches when you need outside facts. Do not use deep research anywhere in this project.
