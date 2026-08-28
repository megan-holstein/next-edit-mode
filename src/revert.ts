/**
 * Cancel: throwing away the edits typed on the page in front of you.
 *
 * WHY IT IS SCOPED TO A PAGE rather than to the whole session. Cancel sits
 * beside Save on a particular page, and the thing a person means by it is
 * "undo what I just did here" — not "undo the afternoon". So the ledger records
 * which page each edit was made from, and this reverts only the files that page
 * contributed.
 *
 * THE GRANULARITY IS THE FILE, AND THAT IS SAID OUT LOUD RATHER THAN HIDDEN.
 * `git restore` works on files; the tool cannot un-type one sentence out of a
 * file and leave another. Two consequences, and the plan reports both BEFORE
 * anything is destroyed:
 *
 *  - A file edited from two pages — a footer mounted on the home page and on
 *    /pricing — reverts whole. The other page's edits go with it, and the plan
 *    names those pages so the choice is an informed one.
 *  - A file somebody else has staged is restored from HEAD, not from the index,
 *    so this tool's edit goes even when it has been staged around. The plan
 *    names any such file, because that is a case where a person should look
 *    before clicking.
 *
 * Nothing here is reachable outside development; see `routes.ts`.
 */
import { firstLine, git } from "./git";
import { forgetFiles, pendingEdits, type LedgerEntry } from "./ledger";

export type RevertPlan = {
  /** Files that would be restored. */
  files: string[];
  /** Edits that would be thrown away, including the shared ones below. */
  edits: number;
  /** Pages OTHER than this one whose edits ride along, because a file is shared. */
  alsoPages: string[];
  /** Of `files`, any that somebody has staged. Restoring takes the staged work too. */
  staged: string[];
};

export type RevertResult =
  | { status: "nothing"; message: string; tone: "note" }
  | { status: "reverted"; files: string[]; edits: number; message: string; tone: "note" }
  | { status: "error"; message: string; tone: "alarm" };

function entriesForPage(pending: LedgerEntry[], page: string): LedgerEntry[] {
  return pending.filter((entry) => entry.pages.includes(page));
}

/** What Cancel would do, computed without doing any of it. */
export async function planRevert(page: string): Promise<RevertPlan> {
  const mine = entriesForPage(await pendingEdits(), page);
  const files = mine.map((entry) => entry.file);
  const alsoPages = [
    ...new Set(mine.flatMap((entry) => entry.pages.filter((p) => p !== page))),
  ].sort();

  let staged: string[] = [];
  if (files.length) {
    const cached = await git(["diff", "--cached", "--name-only", "--", ...files]);
    if (cached.code === 0) {
      staged = cached.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    }
  }

  return {
    files,
    edits: mine.reduce((total, entry) => total + entry.edits, 0),
    alsoPages,
    staged,
  };
}

export async function revertPage(page: string): Promise<RevertResult> {
  const plan = await planRevert(page);
  if (plan.files.length === 0) {
    return { status: "nothing", message: "Nothing on this page to revert.", tone: "note" };
  }

  // `--source=HEAD --worktree` rather than a bare restore: a bare one takes the
  // index as its source, so an edit somebody had staged would survive the
  // revert and quietly outlive the Cancel that was meant to remove it.
  const restored = await git(["restore", "--source=HEAD", "--worktree", "--", ...plan.files]);
  if (restored.code !== 0) {
    return {
      status: "error",
      message: `Nothing was reverted. ${firstLine(restored.stderr)}`,
      tone: "alarm",
    };
  }

  await forgetFiles(plan.files);

  const noun = plan.edits === 1 ? "edit" : "edits";
  const alsoNote = plan.alsoPages.length
    ? ` That included edits made on ${plan.alsoPages.join(", ")}, which shared a file.`
    : "";
  return {
    status: "reverted",
    tone: "note",
    files: plan.files,
    edits: plan.edits,
    message: `Reverted ${plan.edits} ${noun} in ${plan.files.length} ${
      plan.files.length === 1 ? "file" : "files"
    }.${alsoNote}`,
  };
}
