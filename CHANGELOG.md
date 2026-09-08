# Changelog

## 2.0.0

Renames the package and the repository. The tool is `edit-mode`.

- **The `next-` prefix stopped describing it.** The tool was written for a
  Next.js dev server and named for it; since 1.1.0 it runs inside an Electron
  application as well, and one of its two hosts has nothing to do with Next.js.
  `edit-mode` is what the folder, the `EDIT_MODE_*` variables, the
  `#edit-mode/…` import alias and the `.edit-mode/` directory have called it all
  along, so the package and the repository now say the same thing.
- **The major is cut for the import specifiers.** Every one of them changes —
  `next-edit-mode/engine` becomes `edit-mode/engine`, `next-edit-mode/overlay`
  becomes `edit-mode/overlay` — and so does a git-tag dependency, which a host
  updates to `github:megan-holstein/edit-mode#v2.0.0`. A rename a host has to
  act on is a breaking change whatever else moved.
- **Nothing in the tool's behaviour changed between 1.1.0 and 2.0.0.** The
  engine, the routes, the overlay, the installer's output, the commit, the
  ledger and the security model are byte for byte what they were.
- **GitHub redirects the old repository URL**, so an existing
  `github:megan-holstein/next-edit-mode#v1.1.0` dependency goes on resolving
  until somebody updates it. Nothing breaks the day this lands.

## 1.1.0

Adds a second host. The tool can now be mounted by an Electron application as
well as by a Next.js dev server, and the two share one engine rather than one
each.

- **`src/engine.ts` holds what the tool does, in plain values.** Five async
  functions — edit, pending, commit, revert-plan, revert — take and return
  ordinary objects, so a host carries the values in over whatever channel it
  has and carries the reply out. None of them throws: a failure underneath
  comes back as `{ status: "error", message, tone: "alarm" }`, which a host can
  render rather than interpret, and which is told apart from a refusal the
  engine reasoned its way to by carrying no `pending` list or `plan` beside it.
- **`routes.ts` is now HTTP and nothing else** — the 404 outside development,
  the 400 on a malformed request, and which status code a reply deserves. Every
  route answers exactly what it answered before, for every input.
- **`configure()` sets in code what the environment used to set alone.** An
  embedding host owns its process and knows where the checkout is; a dev server
  has neither, which is why the environment was the only channel. What a host
  configures outranks the environment, and the environment outranks the
  defaults. A host that never calls it reads what it always read.
- **The overlay talks to a transport rather than to three URLs, and imports
  nothing from Next.js.** `fetchTransport` is the default and posts to the same
  three endpoints, so a browser sees no difference; an Electron renderer passes
  a transport whose five methods cross to the main process over IPC, because a
  renderer locked down properly refuses a `fetch` to a side channel. The page an
  edit was made from arrives as a `page` prop instead of from `usePathname`,
  which is how Cancel keeps a scope in an application that has no address bar.
  The ring, the picker, the panel, the three tones and the stylesheet are
  untouched.
- **No behaviour of the Next.js host changed.** The routes, the installer's
  output, the endpoints, the messages and the security model are as they were.
  The one thing a Next.js project may now do is pass `page={usePathname()}` to
  the overlay, which makes the counts on Save and Cancel follow a click through
  the nav; the installer writes that into a new mount component, and a project
  installed before 1.1.0 keeps working untouched through the fallback that reads
  `window.location.pathname`.
- `npm test` — the engine's error shape, the route narrowing degrading to
  nothing in a project with no `app/` directory, the order settings are read in,
  and a tripwire that fails if `overlay.tsx` ever imports from `next/` again.

## 1.0.3

Fixes the ring drawn around a run of text that wraps.

- **A wrapped run is ringed once, as the block it fills.** A browser draws an
  outline on inline text one box per line, so `<p><span>the whole
  paragraph</span></p>` — the shape most content renderers produce, and the
  commonest editable run on a marketing page — came up ringed line by line,
  which reads as eight separate runs of text where there is one. The hover and
  editing rings now hang on the nearest block ancestor whenever the inline run
  is the only thing that block renders, so the outline is the single rectangle
  the text occupies. A run that shares its line with other words keeps the
  per-line boxes, which is what it genuinely is.
- **What is edited has not moved.** `contenteditable`, the caret, the text read
  back and the source lookup all still address the run itself; only the ring
  and its tint changed element.

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
