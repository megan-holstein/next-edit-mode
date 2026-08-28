/**
 * The Save button's other half: turning the pile of in-place edits into one
 * commit, and pushing it.
 *
 * THE RULE THIS IS BUILT AROUND IS THAT IT COMMITS THE LEDGER'S FILES AND
 * NOTHING ELSE. Other people, and coding agents, work in the same tree at the
 * same time, so `git add -A` — or any commit that takes whatever the index
 * happens to hold — would sweep up somebody else's half-finished work and push
 * it. `git commit --only` is the
 * mechanism: it builds the commit from the working-tree contents of the named
 * paths and disregards everything staged for any other path, so a colleague's
 * staged changes are neither committed nor disturbed. The committed file list
 * is then read back off the commit and compared against what was asked for; a
 * mismatch is reported rather than pushed.
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
import { commitSubject, pushAfterCommit } from "./config";
import { firstLine, git } from "./git";
import { forgetFiles, pendingEdits } from "./ledger";

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

export async function commitEdits(): Promise<CommitResult> {
  const pending = await pendingEdits();
  if (pending.length === 0) {
    return {
      status: "nothing",
      message: "Nothing to save — those edits are already committed or were undone.",
      tone: "note",
    };
  }

  const files = pending.map((entry) => entry.file);
  const edits = pending.reduce((total, entry) => total + entry.edits, 0);

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

  const body = [
    `${edits} ${edits === 1 ? "edit" : "edits"} made in the browser, in:`,
    "",
    ...files.map((file) => `  ${file}`),
  ].join("\n");

  const committed = await git([
    "commit",
    "--only",
    "-m",
    commitSubject(),
    "-m",
    body,
    "--",
    ...files,
  ]);
  if (committed.code !== 0) {
    return {
      status: "error",
      message: `Nothing was committed. ${firstLine(committed.stderr || committed.stdout)}`,
      tone: "alarm",
    };
  }

  // Read the commit back rather than trusting the flag that produced it.
  const landed = await git(["show", "--name-only", "--format=", "HEAD"]);
  const landedFiles = landed.stdout.split("\n").map((l) => l.trim()).filter(Boolean).sort();
  const asked = [...files].sort();
  if (landedFiles.join("\n") !== asked.join("\n")) {
    return {
      status: "error",
      message:
        `The commit took files that were not asked for (${landedFiles.join(", ")}). ` +
        "It has NOT been pushed. Look at the commit before anything else happens in this tree.",
      tone: "alarm",
    };
  }

  const hashResult = await git(["rev-parse", "--short", "HEAD"]);
  const hash = hashResult.stdout.trim() || "HEAD";

  const wanted = pushAfterCommit();
  // Typed loosely on purpose: a discriminated union here would narrow only
  // under `strictNullChecks`, and this file is compiled by whatever settings the
  // host project happens to have.
  const push: { ok: boolean; reason?: string } = wanted
    ? await pushCurrent(branch)
    : { ok: true };
  // Only what actually landed is forgotten. Anything somebody else added to the
  // ledger while this was running is still theirs to save.
  await forgetFiles(files);

  return {
    status: "committed",
    hash,
    files,
    edits,
    pushed: wanted && push.ok,
    tone: push.ok ? "note" : "alarm",
    message: push.ok
      ? wanted
        ? `Saved as ${hash} and pushed.`
        : `Saved as ${hash}. Not pushed — EDIT_MODE_PUSH is set to never.`
      : `Saved as ${hash}, but the push failed: ${push.reason ?? "no reason given."} Your work is committed; push it yourself once you have sorted out why.`,
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
