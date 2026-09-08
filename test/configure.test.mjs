/**
 * The order settings are read in: what the host configured, then the
 * environment, then the default.
 *
 * THE TESTS RUN IN THE ORDER THEY ARE WRITTEN, and they have to. `configure()`
 * replaces the settings wholesale and offers no way back to none, which is
 * right for a host that calls it once at startup and wrong for a test file that
 * wants to see the unconfigured path. So the defaults are asserted first, the
 * environment second, and everything a host configures last. Node runs each
 * test file in its own process, so nothing here reaches the suite next door.
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

const config = require(path.join(repo, ".test-build", "config.js"));

const DEFAULT_SUBJECT = "Copy: edited in place from the browser";

let fixture;
let elsewhere;
let enteredFrom;

before(() => {
  enteredFrom = process.cwd();
  fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "edit-mode-config-")));
  elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "edit-mode-host-")));
  fs.mkdirSync(path.join(fixture, "src"), { recursive: true });
  fs.mkdirSync(path.join(elsewhere, "app"), { recursive: true });
  for (const name of [
    "EDIT_MODE_SRC",
    "EDIT_MODE_PUSH",
    "EDIT_MODE_COMMIT_SUBJECT",
    "EDIT_MODE_LEDGER",
  ]) {
    delete process.env[name];
  }
  process.chdir(fixture);
});

after(() => {
  process.chdir(enteredFrom);
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.rmSync(elsewhere, { recursive: true, force: true });
});

test("with nothing set, every value is the Next.js default", () => {
  assert.equal(config.projectRoot(), fixture);
  assert.equal(config.sourceDirectory(), path.join(fixture, "src"));
  assert.equal(config.sourceDirectoryLabel(), "src/");
  assert.equal(config.pushAfterCommit(), true);
  assert.equal(config.commitSubject(), DEFAULT_SUBJECT);
  assert.equal(
    config.ledgerPath(),
    path.join(fixture, ".next", "cache", "edit-mode-ledger.json")
  );
});

test("the environment outranks the defaults", () => {
  process.env.EDIT_MODE_SRC = "app";
  process.env.EDIT_MODE_PUSH = "never";
  process.env.EDIT_MODE_COMMIT_SUBJECT = "Copy: from the environment";
  process.env.EDIT_MODE_LEDGER = ".cache/env-ledger.json";

  assert.equal(config.sourceDirectory(), path.join(fixture, "app"));
  assert.equal(config.pushAfterCommit(), false);
  assert.equal(config.commitSubject(), "Copy: from the environment");
  assert.equal(config.ledgerPath(), path.join(fixture, ".cache", "env-ledger.json"));
});

test("a host that names only the root still reads the rest from the environment", () => {
  config.configure({ projectRoot: elsewhere });

  /* The root moved off `process.cwd()`, which is the whole reason `configure`
     exists: a launched application runs from wherever it was launched. */
  assert.equal(config.projectRoot(), elsewhere);
  assert.notEqual(process.cwd(), elsewhere);
  /* And the environment is still consulted underneath, resolved against the
     configured root rather than against the working directory. */
  assert.equal(config.sourceDirectory(), path.join(elsewhere, "app"));
  assert.equal(config.pushAfterCommit(), false);
  assert.equal(config.commitSubject(), "Copy: from the environment");
  assert.equal(config.ledgerPath(), path.join(elsewhere, ".cache", "env-ledger.json"));
});

test("what the host configures outranks the environment", () => {
  config.configure({
    projectRoot: elsewhere,
    sourceDirectory: "source",
    ledgerPath: ".edit-mode/ledger.json",
    push: true,
    commitSubject: "Copy: edited in the app",
  });

  assert.equal(config.projectRoot(), elsewhere);
  assert.equal(config.sourceDirectory(), path.join(elsewhere, "source"));
  assert.equal(config.sourceDirectoryLabel(), "source/");
  assert.equal(config.sourcePrefix(), "source/");
  assert.equal(config.pushAfterCommit(), true);
  assert.equal(config.commitSubject(), "Copy: edited in the app");
  assert.equal(config.ledgerPath(), path.join(elsewhere, ".edit-mode", "ledger.json"));
});

test("absolute paths are taken as they are given", () => {
  const ledger = path.join(fixture, "somewhere", "ledger.json");
  config.configure({
    projectRoot: elsewhere,
    sourceDirectory: path.join(fixture, "src"),
    ledgerPath: ledger,
    push: false,
  });

  assert.equal(config.sourceDirectory(), path.join(fixture, "src"));
  assert.equal(config.ledgerPath(), ledger);
  assert.equal(config.pushAfterCommit(), false);
  /* `push: false` and `commitSubject` unset are two different things: the first
     is a setting, the second falls through to the environment. */
  assert.equal(config.commitSubject(), "Copy: from the environment");
});

test("a second call replaces the first rather than merging with it", () => {
  config.configure({ projectRoot: elsewhere });

  assert.equal(config.sourceDirectory(), path.join(elsewhere, "app"));
  assert.equal(config.ledgerPath(), path.join(elsewhere, ".cache", "env-ledger.json"));
  assert.equal(config.pushAfterCommit(), false);
});
