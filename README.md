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

The package and the repository were called `next-edit-mode` until 2.0.0,
after the dev server that was then its only host; a second host made the
prefix a misdescription, so the name is now the one the folder, the
environment variables and the import alias had always used. GitHub redirects
the old repository URL.

## Requirements

There are two hosts, and the engine behind them is one piece of code.

**A Next.js dev server**, on the App Router, with TypeScript and `typescript`
present in the project's own `node_modules` — which it is, or the project would
not build. Both project layouts are supported: `src/app/…` and a top-level
`app/…`. Nothing about this path has changed.

**An Electron application** that runs from its own checkout, which mounts the
engine in the main process and the overlay in the renderer. See [Hosting it in
an Electron app](#hosting-it-in-an-electron-app) for the three pieces it wires.
Such a host needs no `app/` directory and no Next.js at all; `next` is an
optional peer dependency.

The package declares no runtime dependencies of its own and vendors nothing; the
compiler it parses with is the host project's.

## Installing it in a project

**In a Next.js project, the installer does it**, exactly as it always has:

```sh
git clone https://github.com/megan-holstein/edit-mode.git ~/tools/edit-mode
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

**In an Electron application, there is no installer**, because everything it
writes is Next.js scaffolding. Take the package as a dependency and wire the
three pieces described under [Hosting it in an Electron
app](#hosting-it-in-an-electron-app):

```sh
npm install github:megan-holstein/edit-mode#v2.0.0
```

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
- **It commits the edits it made and nothing else** — not the files it made
  them in. The commit is rebuilt from the last one out of the substitutions the
  ledger recorded, so a colleague's or an agent's unfinished work in the same
  file is neither committed nor disturbed. See the ledger below.
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

### A save is a splice into the file as it stands

Finding the sentence means reading and parsing every candidate file in the
source directory, and that takes long enough for somebody else to write one of
those files while the search is still running — a person in an editor, a coding
agent working in the same tree. So the search's buffers are treated as an index
and nothing else. When the tool has settled on one occurrence it reads that file
again, parses it again, and locates the sentence in *that* content; the write is
that fresh read with a single span replaced, and the engine asserts that every
byte outside the span survived before it writes anything.

Three outcomes, because there are three things the file can have become. Still
one occurrence: it is saved. None: the sentence changed under you between the
page loading and the button being pressed, so nothing is written and the panel
says to reload and retry. More than one: the file gained a copy, and the picker
is the right answer to that.

Version 1.0.0 composed the write from the buffer the *search* had read, so every
byte outside the replaced span came from a file that no longer existed. An edit
made in that window was reverted by a save that reported success.

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

## Hosting it in an Electron app

The tool has a second host, and it is the same tool. An Electron application
that runs from a checkout — a desktop app whose own source holds the copy it
renders — mounts this engine and this overlay unchanged. What differs is the
wire between them. The engine runs in the main process, which is Node and has
been all along; the overlay runs in the renderer, which reaches the main process
over IPC rather than over HTTP.

**The engine runs in the main process, and it is configured in code.** A dev
server has no channel but `process.env` and no project root but
`process.cwd()`; an Electron main process knows both at startup, because it is
the application that was launched from the checkout, so it says so:

```ts
import { app, ipcMain } from "electron";
import {
  configure,
  handleCommit,
  handleEdit,
  handlePending,
  handleRevert,
  handleRevertPlan,
} from "edit-mode/engine";

configure({
  projectRoot: app.getAppPath(),
  sourceDirectory: "src",
  ledgerPath: ".edit-mode/ledger.json",
  push: false,
});

// Arm the handlers in an unpackaged build only. `app.isPackaged` is the
// plainest form of that decision; a development switch of your own serves
// as well, and the choice belongs to the host rather than to this tool.
if (!app.isPackaged) {
  ipcMain.handle("edit-mode:edit", (_event, body) => handleEdit(body));
  ipcMain.handle("edit-mode:pending", () => handlePending());
  ipcMain.handle("edit-mode:commit", () => handleCommit());
  ipcMain.handle("edit-mode:revert-plan", (_event, page) => handleRevertPlan(page));
  ipcMain.handle("edit-mode:revert", (_event, page) => handleRevert(page));
}
```

Every handler answers with a value and none of them throws, so an IPC channel
carries a reply the overlay can render rather than a rejection the renderer has
to interpret. `configure()` is optional in the sense that the defaults suit a
Next.js project; in an Electron host it is not, since `process.cwd()` there is
wherever the application was launched from and the ledger has no `.next` to live
in.

**The overlay mounts in the renderer with a transport.** The five methods are
the whole contract:

```ts
type EditModeTransport = {
  edit(body: EditBody): Promise<EditReply>;
  pending(): Promise<PendingReply>;
  commit(): Promise<CommitReply>;
  revertPlan(page: string): Promise<RevertPlanReply>;
  revert(page: string): Promise<RevertReply>;
};
```

They cross the process boundary through the preload's `contextBridge`, because
a renderer locked down the way an Electron renderer should be — context
isolation on, node integration off, a content security policy that names its
own origin — refuses a `fetch` to a side channel, and answering that by
loosening the policy would trade the application's security for a development
convenience. IPC is the route Electron already provides.

```ts
// preload.ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("editMode", {
  edit: (body: unknown) => ipcRenderer.invoke("edit-mode:edit", body),
  pending: () => ipcRenderer.invoke("edit-mode:pending"),
  commit: () => ipcRenderer.invoke("edit-mode:commit"),
  revertPlan: (page: string) => ipcRenderer.invoke("edit-mode:revert-plan", page),
  revert: (page: string) => ipcRenderer.invoke("edit-mode:revert", page),
});
```

```tsx
// wherever the app draws its development furniture
import { EditModeOverlay } from "edit-mode/overlay";

<EditModeOverlay transport={window.editMode} page={currentScreenName} />;
```

**Pass a `page`.** It is the scope Cancel works in: the ledger records which
page each edit was made from, and Cancel reverts the files that page
contributed rather than the afternoon's work. A browser supplies the answer for
free in its address bar, and an application has no address bar, so name the
screen — `"settings"`, `"onboarding/welcome"`, whatever the application already
calls it. Left out, the overlay falls back to `window.location.pathname`, which
in a single-document application is one value forever, which makes Cancel
session-wide.

**The security model's argument transfers intact.** It never rested on a
password: the only machine that can reach the engine is one running the
checkout, and whoever runs that already has a shell, an editor and write access
to every file the tool could touch. In an Electron host the argument is if
anything narrower, since the channel is IPC inside one application rather than a
port on the loopback interface. The containment rule is unchanged and is still
enforced in the engine rather than promised by the host: every candidate path is
resolved and checked against the source directory before anything is opened, so
your config, your scripts and your lockfile stay unreachable whatever a message
asks for. What the host owes in return is the one thing only the host knows —
that the handlers are armed in a development build and in no other.

**The installer plays no part in this.** `install.mjs` writes Next.js route
files, Next.js stand-ins and a Next.js mount component, none of which an
Electron application has any use for. Such a host takes the package as an
ordinary dependency and wires the three pieces above itself.

## Saving: the ledger, and what the button commits

**Nothing is committed automatically.** Edits pile up as ordinary uncommitted
changes in the working tree, and each successful one is recorded in a ledger at
`.next/cache/edit-mode-ledger.json` — gitignored by the framework's own
convention, surviving a dev-server restart, thrown away with everything else
derived. Each entry carries the file, a count, every page an edit to it was made
from, and — the part the commit is built out of — the exact substitution each
edit performed: the run of text it replaced, and what replaced it.

The ledger exists because git cannot tell an edit made through the pencil from
an edit made in an editor, or by a coding agent working in the same tree at the
same time. Committing the second kind would be theft.

Pressing Save:

1. **Drops anything undone by hand.** The ledger is narrowed to files that still
   differ from `HEAD`, so a `git restore` is a complete undo with no residue.
2. **Rebuilds each file from the last commit.** It reads the content `HEAD`
   holds for that path — never the working tree — and replays that file's
   recorded substitutions on top of it, in the order they were made. What lands
   is therefore the last commit plus this tool's own sentences, and nothing
   else, whoever else is in that file at the time.
3. **Refuses, per file, rather than guessing.** A file is left uncommitted, with
   its edits in the working tree and its ledger entry intact, when the text one
   of its edits replaced is no longer in the last commit's version (somebody
   else changed that sentence, or the file was reformatted), when that text now
   appears more than once so which occurrence was meant cannot be known, when
   the file is not in the last commit at all, when somebody has staged changes
   to it, or when the ledger holds no record of what its edits replaced. The
   panel names the file and the reason. Refusing one file never stops the
   others: what can be rebuilt is committed and the rest is reported.
4. **Commits through a temporary index.** The content being committed exists
   nowhere on disk, so the commit is made with plumbing — `read-tree` into a
   throwaway index named by `GIT_INDEX_FILE`, a blob per file, `write-tree`,
   `commit-tree`, and an `update-ref` that supplies the old value, so a branch
   that moved underneath the save fails the write rather than losing a commit.
   The real index, the working tree, and anybody else's staged work are never
   touched. Afterwards the real index entry for each committed path is set to
   the blob that landed, which is what keeps `git status` from showing the save
   staged in reverse.
5. **Reads the commit back** and compares its file list against what was asked
   for. A mismatch is reported and not pushed.
6. **Pushes.** Plainly first; only a rejection brings in a fetch and a rebase
   with `--autostash`, so the common case never disturbs anyone. A rebase that
   cannot complete is aborted rather than left in progress, and the reason is
   shown. Set `EDIT_MODE_PUSH=never` and this step is skipped.

Until version 1.0.2 step 2 was `git commit --only -- <files>`, which commits the
working-tree content of the named paths. That is file-granular, and the second
writer is usually in the same file rather than merely in the same tree: a save
made while a coding agent had unfinished code further down the page committed
that code too, on a branch that deploys, and the production build failed on it.

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

An embedding host sets the same five values in code instead, with
`configure({ projectRoot, sourceDirectory, ledgerPath, push, commitSubject })`
from `edit-mode/engine`. What a host configures outranks the environment,
and the environment outranks the defaults above; a host that never calls
`configure()` reads exactly what it read before the function existed.

The overlay takes five props, all optional. `transport` replaces the three
`fetch` calls, which is how an Electron renderer reaches the engine over IPC.
`page` names the page an edit was made from, which is the scope Cancel works
in; a Next.js mount passes `usePathname()` and an application passes a screen
name. `editEndpoint`, `commitEndpoint` and `revertEndpoint` are for a project
that mounts the routes somewhere other than `/api/dev`, and the default
transport is the only thing that reads them. They go in the mount component the
installer wrote, which is the one file it never overwrites — so a project
installed before 1.1.0 keeps working untouched, through the fallback that reads
`window.location.pathname`, and picks up navigation-aware counts by adding the
one prop:

```tsx
"use client";
import { usePathname } from "next/navigation";
// ...
return <Overlay page={usePathname() ?? "/"} />;
```

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

- **Route narrowing is App Router only.** Rung one of the ladder — the route a
  page's files hang off — reads a Next.js `app/` tree and nothing else. The
  Pages Router is not modelled, and neither is any other framework. A host with
  no such tree, an Electron application above all, loses that rung and keeps the
  other two: the narrowing simply finds nothing, which is the same answer it
  gives for markdown a project reads at runtime.
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
- **No commit hook runs, and the commit is not signed.** The commit is assembled
  with plumbing out of content that is not in the working tree, so a hook that
  inspects the working tree could not judge it, and `commit.gpgsign` is not
  honoured — signing inside a dev server could sit waiting on a passphrase.
  `git push` still runs whatever pre-push hook the repository has.
- **Cancel is still file-granular**, though Save is no longer: `git restore`
  works on files, so reverting takes back the whole file. The confirmation says
  so and names what rides along, which is why it asks.

## The files

| File | What it is |
|---|---|
| `src/overlay.tsx` | The pencil, the outlines, the panel, the picker, the Save button. Carries its own stylesheet so nothing reaches the host's. |
| `src/copy-source.ts` | Finding a sentence in the source and rewriting it. The TypeScript AST work. |
| `src/imports.ts` | Which files a page is made of — rung one of the ladder. |
| `src/ledger.ts` | What has been written and not yet committed. |
| `src/commit.ts` | The Save button's other half: rebuild those files from the last commit out of the recorded substitutions, commit, push. |
| `src/revert.ts` | The Cancel button's other half: what a revert would take, and taking it. |
| `src/engine.ts` | The five things the tool does, in plain values, with no transport around them. Both hosts import this. |
| `src/routes.ts` | The three route handlers, as factories the Next.js host mounts. HTTP and nothing else. |
| `src/git.ts` | The small amount of git, and the containment rule. |
| `src/config.ts` | Everything a project might set, read from the environment. |
| `install.mjs` | Mounting it in a project. |
| `test/` | `npm test`. The engine is compiled to CommonJS and driven against a throwaway project, with `fs.promises.readFile` wrapped so another writer's edit lands inside the search window deterministically. The commit is driven against real throwaway git repositories, because every claim it makes is a claim about what git ends up holding. |

## License

MIT. See [LICENSE](LICENSE).
