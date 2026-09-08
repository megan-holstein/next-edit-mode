/**
 * The seam that lets a second host mount this tool: the engine handlers, the
 * route narrowing that has no routes to narrow, and the overlay's freedom from
 * Next.js.
 *
 * Every claim here is one an Electron host depends on and a Next.js host never
 * exercises, which is exactly the kind that rots unwatched. They are cheap:
 * three of the four need no fixture at all, and the fourth is a directory with
 * one file in it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);
const require = createRequire(import.meta.url);

const engine = require(path.join(repo, ".test-build", "engine.js"));
const imports = require(path.join(repo, ".test-build", "imports.js"));
/* The same module objects the compiled engine reaches for, so replacing an
   export on one is seen by the handler that calls it. */
const ledger = require(path.join(repo, ".test-build", "ledger.js"));
const revert = require(path.join(repo, ".test-build", "revert.js"));
const ts = require(path.join(repo, "node_modules", "typescript"));

let fixture;
let enteredFrom;

before(() => {
  enteredFrom = process.cwd();
  fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "edit-mode-seam-")));
  fs.writeFileSync(
    path.join(fixture, "package.json"),
    '{ "name": "edit-mode-seam-fixture", "private": true }\n'
  );
  fs.mkdirSync(path.join(fixture, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(fixture, "src", "copy.ts"),
    'export const line = "Pricing that suits a working writer";\n',
    "utf8"
  );
  /* Nothing here calls `configure()`; the point of these tests is the path a
     host that never configures anything takes, so the engine reads the project
     root from `process.cwd()` as it always has. */
  process.chdir(fixture);
});

after(() => {
  process.chdir(enteredFrom);
  fs.rmSync(fixture, { recursive: true, force: true });
});

/* --------------------------------------- a host with no Next.js route tree */

test("a project with no app/ narrows nothing rather than failing", () => {
  assert.deepEqual(imports.entriesForPage("/"), []);
  assert.deepEqual(imports.entriesForPage("/pricing"), []);
  assert.deepEqual(imports.entriesForPage(""), []);

  const file = path.join(fixture, "src", "copy.ts");
  const mounted = imports.routesMounting(ts, [file]);
  assert.deepEqual(mounted.get(file), []);
});

test("a project with no source directory at all narrows nothing either", () => {
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "edit-mode-bare-")));
  fs.writeFileSync(path.join(bare, "package.json"), '{ "name": "bare", "private": true }\n');
  const home = process.cwd();
  try {
    process.chdir(bare);
    assert.deepEqual(imports.entriesForPage("/"), []);
    assert.deepEqual(imports.routesMounting(ts, []).size, 0);
  } finally {
    process.chdir(home);
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

/* -------------------------------------------------- the engine never throws */

test("the handlers answer with a value on an empty project", async () => {
  assert.deepEqual(await engine.handlePending(), { pending: [] });

  assert.deepEqual(await engine.handleRevertPlan("/pricing"), {
    plan: { files: [], edits: 0, alsoPages: [], staged: [] },
  });

  /* The page nobody named. It is not an error — there is simply nothing on it. */
  assert.deepEqual(await engine.handleRevert(""), {
    status: "nothing",
    message: "Nothing on this page to revert.",
    tone: "note",
    pending: [],
  });
});

test("a failure underneath becomes the error shape, not a rejection", async () => {
  const realPending = ledger.pendingEdits;
  ledger.pendingEdits = async () => {
    throw new Error("the ledger could not be opened");
  };
  try {
    assert.deepEqual(await engine.handlePending(), {
      status: "error",
      message: "the ledger could not be opened",
      tone: "alarm",
    });
  } finally {
    ledger.pendingEdits = realPending;
  }

  const realPlan = revert.planRevert;
  revert.planRevert = async () => {
    throw new Error("the ledger could not be opened");
  };
  try {
    assert.deepEqual(await engine.handleRevertPlan("/pricing"), {
      status: "error",
      message: "the ledger could not be opened",
      tone: "alarm",
    });
  } finally {
    revert.planRevert = realPlan;
  }

  const realRevert = revert.revertPage;
  revert.revertPage = async () => {
    throw new Error("git is not on the path");
  };
  try {
    assert.deepEqual(await engine.handleRevert("/pricing"), {
      status: "error",
      message: "git is not on the path",
      tone: "alarm",
    });
  } finally {
    revert.revertPage = realRevert;
  }
});

test("a caught failure carries no payload, which is what a host reads it by", async () => {
  const realPending = ledger.pendingEdits;
  ledger.pendingEdits = async () => {
    throw new Error("nope");
  };
  try {
    const reply = await engine.handlePending();
    assert.equal("pending" in reply, false);
    assert.equal("plan" in reply, false);
  } finally {
    ledger.pendingEdits = realPending;
  }
});

/* ------------------------------------------- the overlay belongs to nobody */

test("the overlay imports nothing from Next.js", () => {
  const source = fs.readFileSync(path.join(repo, "src", "overlay.tsx"), "utf8");
  assert.equal(
    /from\s+["']next\//.test(source),
    false,
    "overlay.tsx must not import from next/ — an Electron renderer has no Next.js"
  );
  assert.equal(/require\(\s*["']next\//.test(source), false);
  assert.equal(/import\(\s*["']next\//.test(source), false);
  /* And it does still reach the engine, through the seam that replaced it. */
  assert.equal(source.includes("export function fetchTransport"), true);
});
