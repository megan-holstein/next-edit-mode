# Changelog

## 1.0.0

First public release.

- Click any run of text on a page under `next dev`, type over it, and the source
  file that produced it is rewritten: TypeScript and TSX through the compiler's
  own AST, Markdown and MDX as flat text.
- Repeated sentences are resolved without asking wherever possible — first by
  the import graph of the route the browser is on, then by the rendered text
  either side of the run. The picker is the last rung, not the first answer.
- A Save button commits exactly the files the tool wrote, with `git commit
  --only`, and pushes. A Cancel button reverts the current page's edits and says
  what else rides along before it destroys anything.
- Dev-only twice over: compiled out of a production build by a dead-branch
  import, and 404 at the endpoints outside `NODE_ENV=development`.
- `src/`-and-root layouts, project path aliases from `tsconfig.json`, the commit
  subject, the push, and the ledger location are all configurable.
