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
