/**
 * The Save button's other half: turning the pile of in-place edits into one
 * commit, and pushing it.
 *
 * THE GRANULARITY IS THE EDIT, NOT THE FILE, AND THE DIFFERENCE IS THE WHOLE
 * REASON THIS FILE IS SHAPED AS IT IS. Other people, and coding agents, work in
 * the same tree at the same time, so `git add -A` — or any commit that takes
 * whatever the index happens to hold — would sweep up somebody else's
 * half-finished work and push it. Until 2026-09-04 the answer to that was
 * `git commit --only -- <files>`, which builds the commit from the working-tree
 * contents of the named paths and disregards everything staged for any other
 * path. That is file-granular, and file-granular is not enough: the second
 * writer is usually in the same file, not merely in the same tree. On that day
 * a save from the browser committed a marketing page whole while a coding agent
 * had unfinished code further down it, on a branch that deploys, and the
 * production build failed on somebody else's half-written work under the
 * message "Copy: edited in place from the browser".
 *
 * SO THE COMMIT IS REBUILT RATHER THAN TAKEN. The ledger records every edit as
 * the substitution it performed — the run of text removed and what replaced it.
 * For each file this reads the content the last commit holds, replays that
 * file's substitutions on top of it in the order they were made, and commits
 * the result. Nothing in the working tree is read at all, so nothing anybody
 * else has typed can ride along: what lands is the last commit plus this tool's
 * own sentences, and that sentence is now true of the CONTENT and not merely of
 * the file list.
 *
 * WHAT CANNOT BE REBUILT IS REFUSED, PER FILE, AND SAID OUT LOUD. A removed run
 * that is no longer in the last commit's version means somebody else changed
 * that same sentence, or a formatter rewrote the file; a removed run that now
 * appears twice means which one was meant is not knowable; a file absent from
 * the last commit has no base to rebuild from at all; a file with staged
 * changes belongs to whoever staged it. Every one of those leaves the file
 * uncommitted, its edits in the working tree and its ledger entry intact, and
 * names the file and the reason in the panel. Refusing one file never stops the
 * others: what can be rebuilt is committed, the rest is reported, and a save
 * where nothing can be rebuilt is a refusal rather than an error.
 *
 * WHY A TEMPORARY INDEX AND NOT `git commit`. The content being committed
 * exists nowhere on disk — it is the last commit plus a few substitutions, and
 * the working tree holds that plus whatever else people are in the middle of.
 * Porcelain has no way to commit content it cannot see, so the commit is made
 * with plumbing: `read-tree` into a throwaway index named by `GIT_INDEX_FILE`,
 * a blob written per file, `write-tree`, `commit-tree`, and `update-ref` with
 * the old value supplied so a branch that moved underneath us fails the write
 * rather than losing a commit. The real index, the working tree, and anybody
 * else's staged work are never touched. Two consequences worth stating: no
 * commit hook runs (a hook that inspects the working tree could not judge a
 * commit rebuilt from the last one), and the commit is not GPG-signed even
 * where `commit.gpgsign` is set, since signing here could sit waiting on a
 * passphrase inside a dev server.
 *
 * THE PUSH IS PART OF SAVING BY DEFAULT, not an afterthought — an unpushed
 * commit is an unbacked-up commit. It is attempted plainly first, and only a
 * rejection brings in a rebase, so the common case never touches anybody else's
 * work. A rebase that cannot complete is aborted rather than left in progress,
 * because the person who clicked the button is not the person who should be
 * resolving a conflict in a detached rebase. Set `EDIT_MODE_PUSH=never` and the
 * button commits and stops.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is claim authorship. The words in the commit
 * were typed by whoever was looking at the page; the tool moved them from the
 * page into a file. So the message carries no trailer, no co-author, and no
 * identity of any kind — the commit is made with the git config already on the
 * machine and nothing is added to it.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { commitSubject, pushAfterCommit } from "./config";
import { firstLine, git } from "./git";
import { forgetFiles, pendingEdits, type LedgerEntry } from "./ledger";

export type CommitResult =
  | { status: "nothing"; message: string; tone: "note" }
  | {
      status: "committed";
      hash: string;
      files: string[];
      edits: number;
      pushed: boolean;
      message: string;
      tone: "note" | "alarm";
    }
  | { status: "error"; message: string; tone: "alarm" };

/** A file rebuilt from the last commit, ready to be written as a blob. */
type Rebuilt = {
  /** As the ledger holds it: relative to the project root. */
  file: string;
  /** As git names it: relative to the repository root. */
  repoPath: string;
  /** The mode the last commit gave it, so a save never changes one. */
  mode: string;
  content: string;
  edits: number;
  /** Filled in once the blob is written. */
  blob: string;
};

type Refusal = { file: string; reason: string };

/** How many times `needle` occurs in `haystack`, without overlaps. */
function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/**
 * The content this file should have after the save: what the last commit holds,
 * with each of this tool's own substitutions replayed on top of it in the order
 * they were made. `unchanged` is the case where they cancel out — an edit and
 * its reversal — which leaves nothing of this tool's to commit.
 */
async function rebuildFromHead(
  entry: LedgerEntry,
  repoPath: string
): Promise<
  | { kind: "rebuilt"; content: string; mode: string }
  | { kind: "unchanged" }
  | { kind: "refused"; reason: string }
> {
  if (entry.substitutions.length === 0) {
    return {
      kind: "refused",
      reason:
        "nothing was recorded about what its edits replaced, so there is no way to tell them from anything else in the file. It was edited by an older version of this tool; commit it by hand.",
    };
  }

  // A file somebody has staged is theirs. Refusing it here is also what makes
  // the index refresh at the end of the commit safe — see the note there.
  const staged = await git(["diff", "--cached", "--name-only", "--", entry.file]);
  if (staged.code !== 0) {
    return {
      kind: "refused",
      reason: `git could not say whether it has staged changes (${firstLine(staged.stderr)}).`,
    };
  }
  if (staged.stdout.trim()) {
    return {
      kind: "refused",
      reason:
        "somebody has staged changes to it, and staged work belongs to whoever staged it. Commit or unstage those and press Save again.",
    };
  }

  const listed = await git(["ls-tree", "HEAD", "--", entry.file]);
  const mode = listed.code === 0 ? listed.stdout.trim().split(/\s+/)[0] : "";
  if (!mode) {
    return {
      kind: "refused",
      reason:
        "it is not in the last commit, so there is no version of it to rebuild the edits on top of. A new file has to be committed by hand the first time.",
    };
  }
  if (mode !== "100644" && mode !== "100755") {
    return {
      kind: "refused",
      reason: `the last commit holds it as something other than an ordinary file (mode ${mode}).`,
    };
  }

  const head = await git(["show", `HEAD:${repoPath}`]);
  if (head.code !== 0) {
    return {
      kind: "refused",
      reason: `its content in the last commit could not be read (${firstLine(head.stderr)}).`,
    };
  }

  let content = head.stdout;
  for (const substitution of entry.substitutions) {
    const found = occurrences(content, substitution.removed);
    if (found === 0) {
      return {
        kind: "refused",
        reason:
          "the text one of its edits replaced is not in the last commit's version of the file — somebody else has changed that sentence, or the file has been reformatted. Commit it by hand.",
      };
    }
    if (found > 1) {
      return {
        kind: "refused",
        reason:
          "the text one of its edits replaced now appears more than once in the file, so which occurrence was meant cannot be known. Commit it by hand.",
      };
    }
    const at = content.indexOf(substitution.removed);
    content =
      content.slice(0, at) +
      substitution.replacement +
      content.slice(at + substitution.removed.length);
  }

  if (content === head.stdout) return { kind: "unchanged" };
  return { kind: "rebuilt", content, mode };
}

export async function commitEdits(): Promise<CommitResult> {
  const pending = await pendingEdits();
  if (pending.length === 0) {
    return {
      status: "nothing",
      message: "Nothing to save — those edits are already committed or were undone.",
      tone: "note",
    };
  }

  const branchResult = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branchResult.code !== 0) {
    return {
      status: "error",
      message: `Not a git repository: ${firstLine(branchResult.stderr)}`,
      tone: "alarm",
    };
  }
  const branch = branchResult.stdout.trim();
  if (branch === "HEAD") {
    return {
      status: "error",
      message: "This checkout is on a detached HEAD, so there is no branch to commit to. Check out a branch first — the edits are still in the working tree.",
      tone: "alarm",
    };
  }

  const headResult = await git(["rev-parse", "HEAD"]);
  if (headResult.code !== 0) {
    return {
      status: "error",
      message: `There is no commit to build on: ${firstLine(headResult.stderr)}`,
      tone: "alarm",
    };
  }
  const headCommit = headResult.stdout.trim();

  // The project need not be the repository root — a site in a subdirectory of a
  // monorepo is ordinary. Every plumbing path below is named from the
  // repository root, which is what `--cacheinfo` and `HEAD:<path>` both take.
  const prefixResult = await git(["rev-parse", "--show-prefix"]);
  if (prefixResult.code !== 0) {
    return {
      status: "error",
      message: `git could not locate this project inside the repository: ${firstLine(prefixResult.stderr)}`,
      tone: "alarm",
    };
  }
  const prefix = prefixResult.stdout.trim();
  /** A ledger path as git names it: from the repository root, slash-separated. */
  const asGitNamesIt = (file: string) => `${prefix}${file.split(path.sep).join("/")}`;

  const rebuilt: Rebuilt[] = [];
  const refused: Refusal[] = [];
  /** Files whose edits cancel out: nothing to commit, nothing left pending. */
  const spent: string[] = [];

  for (const entry of pending) {
    const outcome = await rebuildFromHead(entry, asGitNamesIt(entry.file));
    if (outcome.kind === "refused") {
      refused.push({ file: entry.file, reason: outcome.reason });
    } else if (outcome.kind === "unchanged") {
      spent.push(entry.file);
    } else {
      rebuilt.push({
        file: entry.file,
        repoPath: asGitNamesIt(entry.file),
        mode: outcome.mode,
        content: outcome.content,
        edits: entry.edits,
        blob: "",
      });
    }
  }

  const refusals = refused.map((one) => `${one.file} was not committed: ${one.reason}`).join(" ");

  if (rebuilt.length === 0) {
    if (spent.length) await forgetFiles(spent);
    return {
      status: "nothing",
      tone: "note",
      message: refused.length
        ? `Nothing was committed. ${refusals}`
        : "Nothing to save — those edits cancel out against the last commit.",
    };
  }

  const files = rebuilt.map((one) => one.file);
  const edits = rebuilt.reduce((total, one) => total + one.edits, 0);
  const body = [
    `${edits} ${edits === 1 ? "edit" : "edits"} made in the browser, in:`,
    "",
    ...files.map((file) => `  ${file}`),
  ].join("\n");

  // A throwaway index, so the real one is neither read nor written. It is named
  // for this process and removed whatever happens below.
  const indexFile = path.join(
    os.tmpdir(),
    `edit-mode-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  const scratch = { GIT_INDEX_FILE: indexFile };

  let commitHash: string;
  try {
    const seeded = await git(["read-tree", headCommit], { env: scratch });
    if (seeded.code !== 0) {
      return {
        status: "error",
        message: `Nothing was committed. The last commit could not be read (${firstLine(seeded.stderr)}).`,
        tone: "alarm",
      };
    }

    for (const one of rebuilt) {
      // `--path` rather than a file argument: the content exists nowhere on
      // disk, and git still needs the path to know which filters apply to it.
      const hashed = await git(["hash-object", "-w", "--path", one.repoPath, "--stdin"], {
        stdin: one.content,
      });
      if (hashed.code !== 0 || !hashed.stdout.trim()) {
        return {
          status: "error",
          message: `Nothing was committed. ${one.file} could not be written to the object store (${firstLine(hashed.stderr)}).`,
          tone: "alarm",
        };
      }
      one.blob = hashed.stdout.trim();

      const placed = await git(
        ["update-index", "--add", "--cacheinfo", `${one.mode},${one.blob},${one.repoPath}`],
        { env: scratch }
      );
      if (placed.code !== 0) {
        return {
          status: "error",
          message: `Nothing was committed. ${one.file} could not be placed in the commit (${firstLine(placed.stderr)}).`,
          tone: "alarm",
        };
      }
    }

    const tree = await git(["write-tree"], { env: scratch });
    if (tree.code !== 0 || !tree.stdout.trim()) {
      return {
        status: "error",
        message: `Nothing was committed. The tree could not be written (${firstLine(tree.stderr)}).`,
        tone: "alarm",
      };
    }

    const made = await git(
      ["commit-tree", tree.stdout.trim(), "-p", headCommit, "-m", commitSubject(), "-m", body],
      { env: scratch }
    );
    if (made.code !== 0 || !made.stdout.trim()) {
      return {
        status: "error",
        message: `Nothing was committed. ${firstLine(made.stderr || made.stdout)}`,
        tone: "alarm",
      };
    }
    commitHash = made.stdout.trim();
  } finally {
    await fs.rm(indexFile, { force: true }).catch(() => {});
  }

  // The old value is supplied, so a branch that moved while this was being
  // assembled fails the write instead of losing whatever moved it.
  const moved = await git(["update-ref", `refs/heads/${branch}`, commitHash, headCommit]);
  if (moved.code !== 0) {
    return {
      status: "error",
      message: `Nothing was committed — ${branch} moved while the commit was being assembled (${firstLine(moved.stderr)}). Press Save again.`,
      tone: "alarm",
    };
  }

  // Read the commit back rather than trusting the flag that produced it.
  const landed = await git(["diff-tree", "--no-commit-id", "--name-only", "-r", commitHash]);
  const landedFiles = landed.stdout.split("\n").map((l) => l.trim()).filter(Boolean).sort();
  const asked = rebuilt.map((one) => one.repoPath).sort();
  if (landedFiles.join("\n") !== asked.join("\n")) {
    return {
      status: "error",
      message:
        `The commit took files that were not asked for (${landedFiles.join(", ")}). ` +
        "It has NOT been pushed. Look at the commit before anything else happens in this tree.",
      tone: "alarm",
    };
  }

  // The real index still holds the OLD blob for these paths, so left alone
  // `git status` would show a staged reversal of what was just committed.
  // Setting each entry to the blob that landed is safe ONLY because a file with
  // staged changes was refused above: for every path here the index entry is
  // the one HEAD had, so nothing of anybody's is being overwritten. A later
  // change that relaxes that refusal breaks this, silently.
  const unrefreshed: string[] = [];
  for (const one of rebuilt) {
    const refreshed = await git([
      "update-index",
      "--add",
      "--cacheinfo",
      `${one.mode},${one.blob},${one.repoPath}`,
    ]);
    if (refreshed.code !== 0) unrefreshed.push(one.file);
  }

  const shortResult = await git(["rev-parse", "--short", commitHash]);
  const hash = shortResult.stdout.trim() || commitHash.slice(0, 7);

  const wanted = pushAfterCommit();
  // Typed loosely on purpose: a discriminated union here would narrow only
  // under `strictNullChecks`, and this file is compiled by whatever settings the
  // host project happens to have.
  const push: { ok: boolean; reason?: string } = wanted
    ? await pushCurrent(branch)
    : { ok: true };
  // Only what actually landed is forgotten, and a file that was refused keeps
  // its entry so the button still counts it. Anything somebody else added to
  // the ledger while this was running is still theirs to save.
  await forgetFiles([...files, ...spent]);

  const refusedNote = refused.length ? ` ${refusals}` : "";
  const indexNote = unrefreshed.length
    ? ` The commit is sound, but git's index was not refreshed for ${unrefreshed.join(", ")}, so those files may read as staged in reverse until you run \`git reset\` on them.`
    : "";
  const landedNote = push.ok
    ? wanted
      ? `Saved as ${hash} and pushed.`
      : `Saved as ${hash}. Not pushed — EDIT_MODE_PUSH is set to never.`
    : `Saved as ${hash}, but the push failed: ${push.reason ?? "no reason given."} Your work is committed; push it yourself once you have sorted out why.`;

  return {
    status: "committed",
    hash,
    files,
    edits,
    pushed: wanted && push.ok,
    tone: push.ok && refused.length === 0 && unrefreshed.length === 0 ? "note" : "alarm",
    message: `${landedNote}${refusedNote}${indexNote}`,
  };
}

/**
 * Push, and if the branch has moved underneath us, rebase onto it once and try
 * again. `--autostash` is what makes that safe in a shared tree: anything else
 * uncommitted is set aside for the rebase and put back after it.
 */
async function pushCurrent(branch: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const first = await git(["push", "origin", branch]);
  if (first.code === 0) return { ok: true };

  const fetched = await git(["fetch", "origin", branch]);
  if (fetched.code !== 0) {
    return { ok: false, reason: firstLine(fetched.stderr) };
  }

  const rebased = await git(["rebase", "--autostash", `origin/${branch}`]);
  if (rebased.code !== 0) {
    // Never leave a rebase in progress for somebody to walk into.
    await git(["rebase", "--abort"]);
    return {
      ok: false,
      reason: `the branch has moved and the rebase conflicted (${firstLine(rebased.stderr || rebased.stdout)}).`,
    };
  }

  const second = await git(["push", "origin", branch]);
  if (second.code === 0) return { ok: true };
  return { ok: false, reason: firstLine(second.stderr) };
}
