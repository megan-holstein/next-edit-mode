# Changelog

## 1.0.2

Fixes a defect that committed other people's work.

- **Save commits the edits, not the files they were made in.** 1.0.1 used
  `git commit --only -- <files>`, which takes the whole working-tree content of
  each named path. That is file-granular, and the second writer is usually in
  the same file rather than merely in the same tree: on 2026-09-04 a save made
  while a coding agent had unfinished code further down the page committed that
  code too, to a branch that deploys, and the production build failed on it
  under the message "Copy: edited in place from the browser". The ledger now
  records the exact substitution each edit performed, and the commit is rebuilt
  from the content the last commit holds by replaying those substitutions. The
  working tree is not read at all.
- **The commit is assembled through a temporary index**, named by
  `GIT_INDEX_FILE`, so the real index, the working tree and anybody else's
  staged work are untouched. `update-ref` supplies the old value, so a branch
  that moved while the commit was being built fails the write rather than losing
  whatever moved it. Two consequences: no commit hook runs, and the commit is
  not GPG-signed even where `commit.gpgsign` is set.
- **A file that cannot be rebuilt is refused by name**, with its edits left in
  the working tree and its ledger entry intact — the text an edit replaced is
  gone from the last commit, or now appears twice, or the file is not in the
  last commit, or somebody has staged it, or the ledger predates this version.
  Refusing one file does not stop the others, and a save where nothing can be
  rebuilt is a refusal rather than an error.
- **A file somebody else staged is no longer dropped off the Save button in
  silence.** The pending list compared the working tree with the index rather
  than with `HEAD`, as its own description said it did, so a staged file read as
  unchanged: the edit sat in the file, counted nowhere and reported to nobody.
  It is kept, and refused by name.

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
