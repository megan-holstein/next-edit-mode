# edit-mode

Click a sentence on a page running under `next dev`, type over it, and the
source file that produced that sentence is rewritten on disk. A green **Save**
commits the accumulated edits and pushes them; a red **Cancel** throws away what
was typed on the page in front of you.

It exists so that a wording change costs a keystroke rather than a round trip —
no hunting for which of four hundred files holds the paragraph, no CMS, no
build step between noticing a typo and fixing it. It is a development tool and
nothing else: it is compiled out of a production build, and its endpoints
answer 404 anywhere but a development server.

```
  ┌──────────────────────────────────────────────┐
  │  Pricing that suits a working writer         │  ← click it, type over it
  └──────────────────────────────────────────────┘
        │
        ▼
  src/app/(marketing)/pricing/page.tsx:41 rewritten in place
        │
        ▼
  [ Save 3 · commit 2 files and push ]   [ Cancel 1 · revert this page ]
```

## Requirements

Next.js with the App Router, TypeScript, and `typescript` present in the
project's own `node_modules` — which it is, or the project would not build. The
package declares no runtime dependencies of its own and vendors nothing; the
compiler it parses with is the host project's.

Both project layouts are supported: `src/app/…` and a top-level `app/…`.

## Installing it in a project

```sh
git clone https://github.com/megan-holstein/next-edit-mode.git ~/tools/edit-mode
node ~/tools/edit-mode/install.mjs /path/to/your/project
```

That copies the tool's source into a gitignored `.edit-mode/` at the project
root, adds the ignore rule, and writes six small committed files — two
production stand-ins, the three route handlers, and the mount component. It then
prints the three edits it cannot make for you: two lines in `next.config.ts`,
two in `tsconfig.json`, and one line in the root layout. The whole job is about
five minutes and the printed snippets are copy-paste.

**It rewrites the stand-ins and the routes every run**, which is what makes
re-running it a real sync: a stand-in left at an older version is exactly how a
project ends up mounting a route the tool no longer exports. The mount component
is written once and never overwritten, because it is the one file here you have
a reason to edit. The wiring a project owns — `next.config.ts`, `tsconfig.json`,
the layout — is never touched.

Run the same command again whenever the tool changes; that is how a project
picks up a new version.

```
install [project-dir] [--src <dir>]
```

`--src` names the project's source directory when the automatic answer is wrong.
The automatic answer is `src` where that directory exists and the project root
otherwise, and it is the same rule the running tool uses, so the two cannot
disagree.

## Using it

A red pill sits in the bottom-right corner of every page in development. Click
it and the mode is on: hovering outlines any editable run of text, clicking one
turns it into a field.

| | |
|---|---|
| **Enter**, or clicking away | save that run to the file |
| **Esc**, while editing | put that run back, untouched |
| **Esc**, otherwise | leave edit mode |
| **Save** | commit every file edited since the last save, and push |
| **Cancel** | revert the files this page contributed, after a confirmation |

Save and Cancel are both on screen from the moment the mode is on — greyed and
saying what they are waiting for (**NOTHING TO SAVE**, **NOTHING TO REVERT**)
rather than absent. Once there is something to act on they carry counts:
**Save 3 · commit 2 files and push**.

The mode survives the hot reload that a save causes, which is why it is kept in
`localStorage` rather than in React state.

## The security model, stated plainly

**There is no authentication, and that is deliberate rather than an omission.**
The tool has no users to tell apart. The only machine it can be reached from is
one running the project's own development server, and whoever is running that
already has a shell, an editor and write access to every file this tool could
touch. A password would protect nothing that is not already open.

That argument holds exactly as long as the tool cannot be reached from a
deployed site, so the guarantee is made twice over and neither half is
load-bearing alone.

**Structurally.** The host mounts the overlay through an `import()` sitting in a
branch the bundler resolves as dead in a production build, because
`process.env.NODE_ENV` is substituted with a literal before that decision is
made. The component, its stylesheet and its strings are therefore not merely
unrendered in production but absent from the output — grep a built `.next` for
the component name, the CSS class names or the button labels and all three come
back empty.

**At the door.** Every route handler answers 404 unless `NODE_ENV` is
`development`, and the engine behind it is loaded only after that check. In a
production build the specifier does not even resolve to the engine: it resolves
to a committed stand-in whose handlers are 404 and nothing else, so the code
that could write a file is not in the build at all.

**Mounting it any other way is unsupported.** Exposing these endpoints on a
deployed site, on a shared staging server, behind a tunnel, or on any host whose
port other people can reach hands an anonymous stranger the ability to rewrite
your source files and push a commit. Do not do it, and do not ask this tool for
an authentication option that would make it seem safe to: the answer is a
development server on your own machine.

Three narrower properties are worth naming, since they are what keep the tool
honest inside its own boundary:

- **It reads and writes inside the source directory only.** Every candidate path
  is resolved and checked against that root before anything is opened. Your
  config, your scripts, your lockfile and your environment files are unreachable
  from here, whatever a request asks for.
- **It commits the files it wrote and nothing else** — see the ledger below.
- **It sends nothing anywhere.** The client talks to three endpoints on the same
  origin and to nothing else; the server makes no network call of its own. The
  one exception is `git push`, to whatever remote the repository already has.

## What it can and cannot edit

The unit is **one run of plain text**. A save has to find the sentence in the
source, and it can only do that where the sentence exists there as one piece of
writing.

`.ts` and `.tsx` are parsed with the TypeScript compiler and edited at the node
— a `StringLiteral`, a `NoSubstitutionTemplateLiteral`, or a run of `JsxText` —
so quote style, escaping and the paragraph's own indentation all survive a
rewrite. `.md` and `.mdx` are edited as flat text. Both sides of every comparison
are whitespace-collapsed, which is what lets a sentence typed in a browser find
the same sentence wrapped across four source lines.

Two refusals, each said out loud rather than guessed at:

- **Assembled text.** A price dropped into a template, two strings joined, a
  number counted at render time — there is nothing in any file that reads the
  way the page does, so there is nothing to rewrite.
- **Restructuring.** A paragraph carrying an `<em>` is several runs; each is
  editable on its own, and an edit crossing the boundary changes markup rather
  than words. The paragraph is put back and the reason is shown.

Angle brackets and braces in a replacement are refused for the same reason: in
JSX they mean markup. A run under four characters is refused as too ambiguous to
place.

## How it works

Two parts are worth reading the source for.

### The write-back

The browser hands back decoded text: `he said "no"` where the file holds
`"he said \"no\""`, and a JSX paragraph wrapped across four lines with whatever
indentation the file uses. A regular expression cannot reliably tell a string
literal from a comment quoting it, and cannot re-escape a replacement without
knowing which quote character opened the literal. So `.ts` and `.tsx` are parsed
into a real AST, every editable node becomes a *site* — a span plus an `encode`
function that turns plain text back into valid source for that particular node —
and the edit replaces the span with `encode(newValue)`. A single-quoted literal
comes back single-quoted, a template literal comes back a template literal with
`${` escaped, and a JSX run comes back re-wrapped at the indentation it already
used, with the whitespace that separated it from the `<em>` beside it preserved
exactly.

The compiler is loaded at runtime through `process.getBuiltinModule("module")`
rather than imported, for two reasons. A plain import would put eight megabytes
of compiler into the production server bundle for a route that only ever returns
404 there. And Turbopack replaces an imported `createRequire` with its own,
which refuses any specifier it cannot resolve at build time — `process` is a
runtime global no bundler rewrites, so the `createRequire` reached through it is
Node's own.

### Telling two identical sentences apart

The same words often live in two files: a validation message in the account area
and the same hint under a signup field, a heading and the metadata that repeats
it. Stopping to ask "that sentence appears in two places, which one?" in the
middle of typing reads as a fault, and it is usually not even a hard question.
So there is a ladder, and the picker is its last rung rather than its first
answer.

1. **Which files is this page made of?** The browser sends the route. The tool
   resolves that route's `page` and every `layout` above it, then walks imports
   — relative specifiers, every path alias the project's own `tsconfig.json`
   declares, and dynamic `import()`. Candidates the page cannot possibly render
   are dropped. One survivor is written immediately, and that alone settles the
   case above: only one of those two forms is reachable from `/signup`.
2. **What was around it on screen?** The browser also sends roughly two hundred
   characters of rendered text from either side of the run. Each remaining
   candidate is scored on how much of that text also sits around its occurrence
   in the file, longest match wins, and a clear winner is written. Two copies of
   one sentence in different components almost never share their neighbours.
3. **Ask.** Only when the candidates are genuinely indistinguishable — the same
   sentence with the same neighbours, which does happen — and then as a question
   rather than a fault, each candidate labelled with the routes that mount it as
   well as its path and line.

**The safety argument for guessing is the confirmation.** Every automatic
resolution names the file and line it wrote and says the choice was made for you
— *"Written to src/components/signup-form.tsx:195, picked from the page you are
on."* A wrong guess is therefore visible the second it happens, on screen,
before anything is committed, and Cancel puts it back. Guessing silently would
be indefensible; guessing out loud, with the receipt in view and an undo beside
it, is better than interrupting.

Rung one is skipped when the route cannot be resolved, and **discarded when it
would remove every candidate** — which is what happens for markdown read at
runtime with `fs`, since no import reaches it. A filter that empties the field
has learned nothing and is not trusted over the field it emptied.

## Saving: the ledger, and what the button commits

**Nothing is committed automatically.** Edits pile up as ordinary uncommitted
changes in the working tree, and each successful one is recorded in a ledger at
`.next/cache/edit-mode-ledger.json` — gitignored by the framework's own
convention, surviving a dev-server restart, thrown away with everything else
derived. Each entry carries the file, a count, and every page an edit to it was
made from.

The ledger exists because git cannot tell an edit made through the pencil from
an edit made in an editor, or by a coding agent working in the same tree at the
same time. Committing the second kind would be theft.

Pressing Save:

1. **Drops anything undone by hand.** The ledger is narrowed to files that still
   differ from `HEAD`, so a `git restore` is a complete undo with no residue.
2. **Commits exactly those files**, with `git commit --only`, which builds the
   commit from the working-tree contents of the named paths and disregards
   everything staged for any other path. That is the whole safety property: a
   colleague's or an agent's half-finished work is neither committed nor
   disturbed.
3. **Reads the commit back** and compares its file list against what was asked
   for. A mismatch is reported and not pushed.
4. **Pushes.** Plainly first; only a rejection brings in a fetch and a rebase
   with `--autostash`, so the common case never disturbs anyone. A rebase that
   cannot complete is aborted rather than left in progress, and the reason is
   shown. Set `EDIT_MODE_PUSH=never` and this step is skipped.

A push that fails leaves the commit standing and says so — the work is safe, and
it names what went wrong instead of pretending.

**The commit carries no trailer, no co-author, and no identity of any kind.** It
is made with the git configuration already on the machine, and nothing is added
to it. The words are yours; the tool moved them from the page into a file.

### Cancel is scoped to the page, and asks first

Cancel sits beside Save on a particular page, and what a person means by it is
"undo what I just did here" — not "undo the afternoon". So the ledger records
which page each edit came from, and Cancel reverts only the files that page
contributed. It never touches a commit; it is `git restore` on uncommitted work.

It always shows a confirmation naming the files first, because it destroys typed
work and nothing in this tool can bring it back.

**The granularity is the file, and the confirmation says so rather than hiding
it.** `git restore` works on files; there is no un-typing one sentence out of a
file and leaving another. Two consequences, both reported before anything is
destroyed:

- **A file edited from two pages reverts whole** — a footer mounted on the home
  page and on `/pricing` is one file, and reverting from either takes both
  pages' edits. The confirmation names the other page.
- **A file somebody has staged is restored from `HEAD`**, not from the index, so
  this tool's edit goes even when it has been staged around — and the staged
  work goes from the working tree with it. The confirmation names any such file.
  (A bare `git restore` would take the index as its source, which would leave
  the edit alive and outliving the Cancel meant to remove it. That is why the
  flag is there.)

## Configuration

Everything is optional and every default suits an ordinary Next.js project. Set
these in the project's `.env.local`, which the framework already gitignores, so
one person's preference never lands in a shared repository.

| Variable | Default | What it does |
|---|---|---|
| `EDIT_MODE_SRC` | `src` if it exists, else the project root | The one directory read from and written to. Must match the installer's `--src`. |
| `EDIT_MODE_PUSH` | `auto` | `never` commits without pushing. |
| `EDIT_MODE_COMMIT_SUBJECT` | `Copy: edited in place from the browser` | The subject line of the commit Save makes. |
| `EDIT_MODE_LEDGER` | `.next/cache/edit-mode-ledger.json` | Where the record of uncommitted edits is kept. |

The overlay takes three props, for a project that mounts the routes somewhere
other than `/api/dev`: `editEndpoint`, `commitEndpoint`, `revertEndpoint`. They
go in the mount component the installer wrote, which is the one file it never
overwrites.

## Three tiers, dressed differently

A question, a thing the tool cannot do here, and something that actually went
wrong are three different events, and dressing them alike is what made the
picker read as a failure.

| Tier | What it is | How it looks |
|---|---|---|
| **Question** | the picker, and nothing else | white paper in the red frame, calm |
| **Note** | assembled text, a crossed `<em>`, nothing to save | the same white paper |
| **Alarm** | a write that failed, a rejected push, a missing endpoint | solid red, white type |

The revert confirmation wears the alarm dress too, deliberately: it destroys
typed work, and that earns the loud one.

## Why it is red

Every surface the tool draws — the pill, the hover and editing outlines, the
panel, the picker — is red and white, in its own type, with no value borrowed
from the site underneath. A tool that rewrites source files should be impossible
to mistake for the page it sits on, and a tasteful overlay matching the site's
own design would be exactly that mistake. The Save button is green, because it
is the only control here that does something rather than warns about something.

The overlay carries its own stylesheet inline rather than adding rules to the
host's, so a production stylesheet has nothing of this in it even by accident.

## Known limits

- **Next.js App Router only.** The Pages Router is not modelled, and neither is
  any other framework.
- **Turbopack is the assumed bundler** for the alias described in the installer
  output. A Webpack project needs the equivalent `resolve.alias` entry instead;
  nothing else changes.
- **`extends` in `tsconfig.json` is not followed** when reading path aliases. An
  alias declared only in a base config is not resolved, which costs some
  narrowing precision and never produces a wrong write — the import-graph filter
  is discarded whenever it empties the candidate list.
- **Text assembled at render time cannot be edited**, and neither can an edit
  that crosses markup. Both are refused with the reason shown.
- **HTML entities in the source are not decoded.** A JSX run written as
  `He said &quot;no&quot;` reaches the browser as `He said "no"`, which matches
  no text in any file, so the tool reports it as unfindable rather than guessing
  at an encoding. Write the character rather than the entity and it is editable.
- **Two identical sentences with identical surroundings** still require a
  choice. That is the picker, and it is rare.

## The files

| File | What it is |
|---|---|
| `src/overlay.tsx` | The pencil, the outlines, the panel, the picker, the Save button. Carries its own stylesheet so nothing reaches the host's. |
| `src/copy-source.ts` | Finding a sentence in the source and rewriting it. The TypeScript AST work. |
| `src/imports.ts` | Which files a page is made of — rung one of the ladder. |
| `src/ledger.ts` | What has been written and not yet committed. |
| `src/commit.ts` | The Save button's other half: commit exactly those files, push. |
| `src/revert.ts` | The Cancel button's other half: what a revert would take, and taking it. |
| `src/routes.ts` | The three route handlers, as factories the host mounts. |
| `src/git.ts` | The small amount of git, and the containment rule. |
| `src/config.ts` | Everything a project might set, read from the environment. |
| `install.mjs` | Mounting it in a project. |

## License

MIT. See [LICENSE](LICENSE).
