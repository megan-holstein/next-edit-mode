/**
 * The regression suite for the defect that made 1.0.1: a save that rewrote the
 * file from the buffer the SEARCH had read, and so reverted anything written to
 * that file while the search was running.
 *
 * The collision is reproduced rather than approximated. `whenSearchReads` wraps
 * `fs.promises.readFile` — the same module object the engine calls through — and
 * writes the file the moment the search reads it, which places another writer's
 * edit exactly inside the window the bug lived in. Nothing here sleeps or races:
 * the interleaving is deterministic, so a failure is a failure rather than a
 * flake.
 *
 * Every test runs against a throwaway project in the system temp directory, with
 * the repository's own `typescript` symlinked in, because the engine loads the
 * compiler from the host project it is mounted in.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);
const require = createRequire(import.meta.url);

const { editCopy } = require(path.join(repo, ".test-build", "copy-source.js"));
const { commitEdits } = require(path.join(repo, ".test-build", "commit.js"));
const { pendingEdits, recordEdit } = require(path.join(repo, ".test-build", "ledger.js"));
/* The same object the compiled engine reaches for, so patching it is seen. */
const fsp = require("node:fs/promises");

let fixture;
let enteredFrom;

before(() => {
  enteredFrom = process.cwd();
  fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "edit-mode-")));
  fs.writeFileSync(
    path.join(fixture, "package.json"),
    '{ "name": "edit-mode-fixture", "private": true }\n'
  );
  fs.mkdirSync(path.join(fixture, "node_modules"), { recursive: true });
  fs.symlinkSync(
    path.join(repo, "node_modules", "typescript"),
    path.join(fixture, "node_modules", "typescript"),
    "dir"
  );
  /* The engine reads the project root from `process.cwd()`. */
  process.chdir(fixture);
});

after(() => {
  process.chdir(enteredFrom);
  fs.rmSync(fixture, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(fixture, "src"), { recursive: true, force: true });
  fs.mkdirSync(path.join(fixture, "src"), { recursive: true });
});

/** Write a file under the fixture's source directory; returns its absolute path. */
function write(relative, contents) {
  const file = path.join(fixture, "src", relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, "utf8");
  return file;
}

const read = (file) => fs.readFileSync(file, "utf8");
const flat = (value) => value.replace(/\s+/g, " ").trim();

/**
 * Somebody else writes `replacement` over `file` at the instant the engine's
 * search reads it — an agent editing the same file while the browser's save is
 * in flight. Returns the undo.
 */
function whenSearchReads(file, replacement) {
  const real = fsp.readFile;
  let armed = true;
  fsp.readFile = async (target, ...rest) => {
    const contents = await real.call(fsp, target, ...rest);
    if (armed && path.resolve(String(target)) === file) {
      armed = false;
      fs.writeFileSync(file, replacement, "utf8");
    }
    return contents;
  };
  return () => {
    fsp.readFile = real;
  };
}

/* ------------------------------------------------------------ the defect */

test("a TypeScript file written during the search keeps that writing", async () => {
  const before = `export const home = {
  hero: "Prose you can trust, from the first page to the last.",
  note: "A line nobody is editing in the browser.",
};
`;
  /* What the agent leaves on disk while the search is running: one line
     rewritten, and a whole export that did not exist before. */
  const meanwhile = `export const home = {
  hero: "Prose you can trust, from the first page to the last.",
  note: "A line the agent rewrote mid-save.",
  addedByTheAgent: "and a value that was not there at all",
};
`;
  const file = write("content/home.ts", before);
  const undo = whenSearchReads(file, meanwhile);

  let result;
  try {
    result = await editCopy({
      oldText: "Prose you can trust, from the first page to the last.",
      newText: "Prose that stays yours, from the first page to the last.",
    });
  } finally {
    undo();
  }

  assert.equal(result.status, "saved");
  assert.equal(
    read(file),
    meanwhile.replace(
      "Prose you can trust, from the first page to the last.",
      "Prose that stays yours, from the first page to the last."
    ),
    "the save must be a splice into what was on disk at write time"
  );
});

test("a TSX page written during the search keeps that writing", async () => {
  const before = `export default function Page() {
  return (
    <main>
      <p>
        A quiet novel about a telephone exchange, and the winter it went silent.
      </p>
    </main>
  );
}
`;
  const meanwhile = `export default function Page() {
  return (
    <main>
      <p>
        A quiet novel about a telephone exchange, and the winter it went silent.
      </p>
      <p>A paragraph the agent added while the browser was thinking.</p>
    </main>
  );
}
`;
  const file = write("app/fiction/page.tsx", before);
  const undo = whenSearchReads(file, meanwhile);

  let result;
  try {
    result = await editCopy({
      oldText: "A quiet novel about a telephone exchange, and the winter it went silent.",
      newText: "A quiet novel about a telephone exchange, and the winter it fell silent.",
    });
  } finally {
    undo();
  }

  assert.equal(result.status, "saved");
  /* Flattened, because a replaced JSX run is re-wrapped at the indentation the
     file already used — the words are what this test is about, not the folding. */
  const after = flat(read(file));
  assert.ok(after.includes("and the winter it fell silent."));
  assert.ok(!after.includes("and the winter it went silent."));
  assert.ok(
    after.includes("A paragraph the agent added while the browser was thinking."),
    "the agent's paragraph must survive the save"
  );
});

test("a markdown file written during the search keeps that writing", async () => {
  const before = `---
title: A guide
---

The first paragraph, which is about to be edited in the browser.

The second paragraph, which nobody is touching.
`;
  const meanwhile = `${before}
A third paragraph, added by the agent mid-save.
`;
  const file = write("content/guides/a-guide.mdx", before);
  const undo = whenSearchReads(file, meanwhile);

  let result;
  try {
    result = await editCopy({
      oldText: "The first paragraph, which is about to be edited in the browser.",
      newText: "The first paragraph, as the owner has just rewritten it.",
    });
  } finally {
    undo();
  }

  assert.equal(result.status, "saved");
  assert.equal(
    read(file),
    meanwhile.replace(
      "The first paragraph, which is about to be edited in the browser.",
      "The first paragraph, as the owner has just rewritten it."
    ),
    "a markdown save is a splice too, not a rewrite of the whole file"
  );
});

/* ------------------------------------------------------ changed under her */

test("a sentence that changed on disk is refused, and nothing is written", async () => {
  const before = `export const copy = {
  line: "A sentence that is about to be rewritten by somebody else.",
};
`;
  const meanwhile = `export const copy = {
  line: "A sentence somebody else has already rewritten.",
};
`;
  const file = write("content/copy.ts", before);
  const undo = whenSearchReads(file, meanwhile);

  let result;
  try {
    result = await editCopy({
      oldText: "A sentence that is about to be rewritten by somebody else.",
      newText: "A sentence the owner meant to change in the browser.",
    });
  } finally {
    undo();
  }

  assert.equal(result.status, "none");
  assert.equal(result.tone, "note");
  assert.match(result.message, /changed on disk/);
  assert.equal(read(file), meanwhile, "the file must be exactly as the other writer left it");
});

/* -------------------------------------------------- the undisturbed case */

test("an ordinary save touches nothing but the sentence", async () => {
  const before = `/* A comment holding the word novel, so the file has more than the literal. */
export const page = {
  lede: "The winter the exchange went quiet.",
  tail: "Everything after the edit, byte for byte.",
};
`;
  const file = write("content/page.ts", before);

  const result = await editCopy({
    oldText: "The winter the exchange went quiet.",
    newText: "The winter the exchange fell quiet.",
  });

  assert.equal(result.status, "saved");
  assert.equal(
    read(file),
    before.replace(
      "The winter the exchange went quiet.",
      "The winter the exchange fell quiet."
    )
  );
});

test("the same sentence in two files still goes to the picker", async () => {
  write(
    "content/one.ts",
    'export const one = { line: "A sentence that lives in two files at once." };\n'
  );
  write(
    "content/two.ts",
    'export const two = { line: "A sentence that lives in two files at once." };\n'
  );

  const result = await editCopy({
    oldText: "A sentence that lives in two files at once.",
    newText: "A sentence that lives in two files, still.",
  });

  assert.equal(result.status, "multiple");
  assert.equal(result.candidates.length, 2);
});

test("a sentence duplicated in one file is saved at the occurrence that was found", async () => {
  const before = `export const twice = {
  a: "A sentence that appears twice in one file.",
  b: "A sentence that appears twice in one file.",
};
`;
  const file = write("content/twice.ts", before);

  const result = await editCopy({
    oldText: "A sentence that appears twice in one file.",
    newText: "A sentence that appears twice, or did.",
    /* The neighbours settle it, as they would from the page. */
    before: "a:",
    after: 'b: "A sentence that appears twice in one file."',
  });

  /* Either the ladder settles it or it asks; what it must never do is write
     both occurrences, or write the wrong file. */
  if (result.status === "saved") {
    const after = read(file);
    assert.equal(
      (after.match(/A sentence that appears twice in one file\./g) ?? []).length,
      1
    );
  } else {
    assert.equal(result.status, "multiple");
    assert.equal(read(file), before);
  }
});

/* ------------------------------------------- what the commit is built from */

/**
 * The second hazard, and the one that made 1.0.2: a Save that committed each
 * edited file WHOLE. File granularity is not enough, because the other writer
 * is usually in the same file rather than merely in the same tree — on
 * 2026-09-04 a save from the browser carried a coding agent's unfinished code
 * to a branch that deploys, and the production build failed on it.
 *
 * These run against real, throwaway git repositories rather than a mocked git,
 * because every claim being made here is a claim about what git ends up
 * holding: the commit's content, the index, and the working tree afterwards.
 */

const gitRepos = [];
const gitLedgers = [];

/** `git`, run in `where`, failing the test loudly rather than silently. */
function inGit(where, args, allowFailure = false) {
  const done = spawnSync("git", args, { cwd: where, encoding: "utf8" });
  if (!allowFailure && done.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${done.stderr || done.stdout}`);
  }
  return { status: done.status, stdout: done.stdout ?? "", stderr: done.stderr ?? "" };
}

/** A repository with a source directory, a compiler, and no commits yet. */
function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "edit-mode-git-")));
  gitRepos.push(dir);
  inGit(dir, ["init", "-q", "."]);
  inGit(dir, ["config", "user.email", "nobody@example.invalid"]);
  inGit(dir, ["config", "user.name", "Edit Mode Test"]);
  inGit(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    '{ "name": "edit-mode-git-fixture", "private": true }\n'
  );
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules\n");
  fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  fs.symlinkSync(
    path.join(repo, "node_modules", "typescript"),
    path.join(dir, "node_modules", "typescript"),
    "dir"
  );
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  return dir;
}

/** Write a file under a repository's source directory. */
function put(dir, relative, contents) {
  const file = path.join(dir, "src", relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, "utf8");
  return file;
}

/** Commit everything in `dir`, as somebody who is not this tool. */
function commitAll(dir, message) {
  inGit(dir, ["add", "-A"]);
  inGit(dir, ["commit", "-q", "-m", message]);
}

/** The content the last commit holds for a path, as a string. */
const atHead = (dir, relative) => inGit(dir, ["show", `HEAD:${relative}`]).stdout;

/**
 * Run `body` with the engine pointed at `dir`: its own working directory, its
 * own ledger (outside the repository, so nothing under test is an untracked
 * file), and no push, since a throwaway repository has no remote.
 */
async function inRepo(dir, body) {
  const from = process.cwd();
  /* Outside the repository, so nothing under test is an untracked file, and
     kept between calls, so a test can read the ledger back after a save. */
  const ledger = path.join(dir, "..", `${path.basename(dir)}-ledger.json`);
  if (!gitLedgers.includes(ledger)) gitLedgers.push(ledger);
  const push = process.env.EDIT_MODE_PUSH;
  process.chdir(dir);
  process.env.EDIT_MODE_LEDGER = ledger;
  process.env.EDIT_MODE_PUSH = "never";
  try {
    return await body();
  } finally {
    process.chdir(from);
    delete process.env.EDIT_MODE_LEDGER;
    if (push === undefined) delete process.env.EDIT_MODE_PUSH;
    else process.env.EDIT_MODE_PUSH = push;
  }
}

/** What `routes.ts` does on a successful edit: write it, then record it. */
async function save(request) {
  const result = await editCopy(request);
  if (result.status === "saved") {
    await recordEdit(result.file, request.pagePath, {
      removed: result.removed,
      replacement: result.replacement,
    });
  }
  return result;
}

after(() => {
  for (const dir of gitRepos) fs.rmSync(dir, { recursive: true, force: true });
  for (const ledger of gitLedgers) fs.rmSync(ledger, { force: true });
});

const PAGE = `export default function Page() {
  return (
    <main>
      <h1>The Midnight Exchange</h1>
      <p>A quiet novel about a telephone exchange, and the winter it went silent.</p>
    </main>
  );
}
`;

test("an agent's unfinished work in the same file is not committed, and survives", async () => {
  const dir = makeRepo();
  put(dir, "app/page.tsx", PAGE);
  commitAll(dir, "the page as it stands");

  /* The coding agent, working further down the same file while the browser is
     open on it. Half-written on purpose: this is the shape that broke a
     production build when a save committed the file whole. */
  const withAgentsWork = PAGE.replace(
    "    </main>",
    "      <Panel unfinished={\n    </main>"
  );
  const file = path.join(dir, "src/app/page.tsx");
  fs.writeFileSync(file, withAgentsWork, "utf8");

  const committed = await inRepo(dir, async () => {
    const edit = await save({
      oldText: "A quiet novel about a telephone exchange, and the winter it went silent.",
      newText: "A quiet novel about a telephone exchange, and the winter it fell silent.",
    });
    assert.equal(edit.status, "saved");
    return commitEdits();
  });

  assert.equal(committed.status, "committed", committed.message);
  assert.deepEqual(committed.files, ["src/app/page.tsx"]);

  /* THE CLAIM. What landed is the last commit plus the one sentence — not the
     working tree, which held the agent's half-written component. Flattened,
     because a replaced JSX run is re-wrapped at the indentation the file
     already used; the exact-bytes claim is the next test's, on a file with no
     folding in it. */
  assert.equal(
    flat(atHead(dir, "src/app/page.tsx")),
    flat(PAGE.replace("the winter it went silent.", "the winter it fell silent."))
  );
  assert.ok(
    !atHead(dir, "src/app/page.tsx").includes("Panel unfinished"),
    "the agent's unfinished work must not be in the commit"
  );

  /* And it is still where the agent left it. */
  const working = read(file);
  assert.ok(working.includes("<Panel unfinished={"), "the agent's work must still be on disk");
  assert.ok(flat(working).includes("the winter it fell silent."), "so must the edit");
});

test("the commit holds exactly the substitution, and the index shows no reversal", async () => {
  const dir = makeRepo();
  put(dir, "content/home.ts", `export const home = {
  hero: "Prose you can trust, from the first page to the last.",
  note: "A line nobody is editing in the browser.",
};
`);
  commitAll(dir, "the copy as it stands");

  const committed = await inRepo(dir, async () => {
    await save({
      oldText: "Prose you can trust, from the first page to the last.",
      newText: "Prose that stays yours, from the first page to the last.",
    });
    return commitEdits();
  });

  assert.equal(committed.status, "committed", committed.message);

  /* One file, one hunk, one line: the diff of the commit against its parent. */
  const diff = inGit(dir, ["diff", "HEAD~1", "HEAD", "--unified=0"]).stdout;
  const added = diff.split("\n").filter((line) => /^\+[^+]/.test(line));
  const removed = diff.split("\n").filter((line) => /^-[^-]/.test(line));
  assert.deepEqual(removed, ['-  hero: "Prose you can trust, from the first page to the last.",']);
  assert.deepEqual(added, ['+  hero: "Prose that stays yours, from the first page to the last.",']);

  /* THE INDEX NOTE. The real index still held HEAD's old blob for that path
     until the save refreshed it; unrefreshed, `git status` would show the edit
     staged in reverse. Nothing here has any other writer, so the whole tree is
     clean. */
  assert.equal(inGit(dir, ["diff", "--cached", "--name-only"]).stdout.trim(), "");
  assert.equal(inGit(dir, ["status", "--porcelain"]).stdout.trim(), "");
});

test("a file whose sentence was committed over is refused, and the rest still lands", async () => {
  const dir = makeRepo();
  const contested = `export const banner = {
  line: "A sentence two people are about to edit at once.",
};
`;
  put(dir, "content/banner.ts", contested);
  put(dir, "content/footer.ts", `export const footer = {
  line: "A sentence nobody else is anywhere near.",
};
`);
  commitAll(dir, "the copy as it stands");

  const banner = path.join(dir, "src/content/banner.ts");
  const footer = path.join(dir, "src/content/footer.ts");

  const committed = await inRepo(dir, async () => {
    const one = await save({
      oldText: "A sentence two people are about to edit at once.",
      newText: "A sentence as the owner has just rewritten it.",
    });
    assert.equal(one.status, "saved");
    const two = await save({
      oldText: "A sentence nobody else is anywhere near.",
      newText: "A sentence the owner rewrote as well.",
    });
    assert.equal(two.status, "saved");

    /* Somebody else lands their own rewrite of the SAME sentence while the
       browser's edits are still uncommitted. The version the edit replaced is
       no longer in the last commit, so it cannot be rebuilt from it. */
    const mine = read(banner);
    fs.writeFileSync(
      banner,
      contested.replace(
        "A sentence two people are about to edit at once.",
        "A sentence somebody else has rewritten and committed."
      ),
      "utf8"
    );
    inGit(dir, ["add", "src/content/banner.ts"]);
    inGit(dir, ["commit", "-q", "-m", "somebody else's rewrite"]);
    fs.writeFileSync(banner, mine, "utf8");

    return commitEdits();
  });

  assert.equal(committed.status, "committed", committed.message);
  assert.deepEqual(committed.files, ["src/content/footer.ts"], "only the uncontested file lands");
  assert.match(committed.message, /src\/content\/banner\.ts was not committed/);
  assert.match(committed.message, /somebody else has changed that sentence/);
  assert.equal(committed.tone, "alarm");

  /* The refused file keeps both halves: the other writer's commit, and the
     owner's edit still sitting in the working tree. */
  assert.ok(atHead(dir, "src/content/banner.ts").includes("somebody else has rewritten and committed."));
  assert.ok(read(banner).includes("as the owner has just rewritten it."));
  assert.ok(
    atHead(dir, "src/content/footer.ts").includes("A sentence the owner rewrote as well."),
    "the uncontested edit must be in the commit"
  );

  /* And it is still pending, so the button still counts it. */
  const stillPending = await inRepo(dir, () => pendingEdits());
  assert.deepEqual(stillPending.map((entry) => entry.file), ["src/content/banner.ts"]);
  assert.ok(read(footer).includes("A sentence the owner rewrote as well."));
});

test("somebody else's staged work in another file is neither committed nor disturbed", async () => {
  const dir = makeRepo();
  put(dir, "content/copy.ts", `export const copy = {
  line: "A sentence the owner is editing in the browser.",
};
`);
  const theirs = `export const theirs = {
  line: "A line somebody else has staged.",
};
`;
  put(dir, "content/theirs.ts", theirs);
  commitAll(dir, "the copy as it stands");

  /* The agent stages a change of its own, in a file the browser never touched. */
  const staged = theirs.replace(
    "A line somebody else has staged.",
    "A line somebody else has staged, and is not finished with."
  );
  fs.writeFileSync(path.join(dir, "src/content/theirs.ts"), staged, "utf8");
  inGit(dir, ["add", "src/content/theirs.ts"]);
  const stagedBlob = inGit(dir, ["rev-parse", ":src/content/theirs.ts"]).stdout.trim();

  const committed = await inRepo(dir, async () => {
    await save({
      oldText: "A sentence the owner is editing in the browser.",
      newText: "A sentence the owner has just rewritten.",
    });
    return commitEdits();
  });

  assert.equal(committed.status, "committed", committed.message);
  assert.deepEqual(committed.files, ["src/content/copy.ts"]);

  /* Not committed. */
  assert.deepEqual(
    inGit(dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).stdout.trim().split("\n"),
    ["src/content/copy.ts"]
  );
  assert.ok(!atHead(dir, "src/content/theirs.ts").includes("is not finished with"));

  /* Not disturbed: the same blob is still staged, and the file still reads as
     they left it. */
  assert.equal(inGit(dir, ["rev-parse", ":src/content/theirs.ts"]).stdout.trim(), stagedBlob);
  assert.equal(read(path.join(dir, "src/content/theirs.ts")), staged);
  assert.deepEqual(
    inGit(dir, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n"),
    ["src/content/theirs.ts"],
    "their staged file must be the only thing staged afterwards"
  );
});

test("a file somebody has staged is refused rather than rebuilt", async () => {
  const dir = makeRepo();
  const shared = `export const shared = {
  line: "A sentence in a file somebody is about to stage.",
};
`;
  put(dir, "content/shared.ts", shared);
  commitAll(dir, "the copy as it stands");

  const file = path.join(dir, "src/content/shared.ts");

  const result = await inRepo(dir, async () => {
    await save({
      oldText: "A sentence in a file somebody is about to stage.",
      newText: "A sentence the owner has just rewritten.",
    });
    /* The agent stages its own work in the same file, on a different line. */
    fs.writeFileSync(file, `${read(file)}\nexport const alsoTheirs = 1;\n`, "utf8");
    inGit(dir, ["add", "src/content/shared.ts"]);
    return commitEdits();
  });

  assert.equal(result.status, "nothing", result.message);
  assert.match(result.message, /somebody has staged changes to it/);
  assert.equal(inGit(dir, ["rev-parse", "HEAD"]).stdout.trim().length, 40);
  assert.equal(
    inGit(dir, ["log", "--format=%s"]).stdout.trim(),
    "the copy as it stands",
    "nothing was committed"
  );
});

test("an entry with nothing recorded about its edits is refused by name", async () => {
  const dir = makeRepo();
  put(dir, "content/old.ts", 'export const old = { line: "A sentence saved by an older version." };\n');
  commitAll(dir, "the copy as it stands");

  const file = path.join(dir, "src/content/old.ts");
  fs.writeFileSync(file, 'export const old = { line: "A sentence rewritten in the browser." };\n', "utf8");

  const result = await inRepo(dir, async () => {
    /* A ledger as 1.0.1 wrote them: a count, and no record of what changed. */
    fs.writeFileSync(
      process.env.EDIT_MODE_LEDGER,
      JSON.stringify([{ file: "src/content/old.ts", edits: 1, pages: ["/"] }], null, 2)
    );
    return commitEdits();
  });

  assert.equal(result.status, "nothing", result.message);
  assert.match(result.message, /src\/content\/old\.ts was not committed/);
  assert.match(result.message, /older version of this tool/);
});
