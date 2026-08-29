# Changelog

## 1.0.1

Fixes a defect that destroyed work rather than merely failing.

- **A save no longer reverts what somebody else wrote while it was running.**
  Finding a sentence means reading and parsing every candidate file, and 1.0.0
  composed the write from the buffers that search had read — so every byte
  outside the replaced span came from a file that no longer existed, and an edit
  made to that file in the meantime was silently reverted by a save that
  reported success. The chosen file is now read and parsed again at write time,
  the write is a splice into that content, and the engine asserts that every
  byte outside the replaced span survived before it writes anything.
- **A sentence that changed on disk since the page loaded is refused**, with a
  note saying to reload and retry, and nothing is written. Where the file has
  gained a second copy of the sentence instead, the ordinary picker asks.
- A markdown save is a splice too. Its site is the whole file, so 1.0.0 rewrote
  every byte of it on every edit.
- `npm test` — a regression suite that reproduces the collision deterministically
  by wrapping `fs.promises.readFile`, run in CI beside the type check.

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
