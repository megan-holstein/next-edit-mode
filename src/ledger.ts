/**
 * The ledger: which files this tool has written since the last time they were
 * committed, and how many edits went into each.
 *
 * WHY IT EXISTS. Nothing here commits automatically; edits pile up in the
 * working tree and the Save button turns them into one commit. So the button
 * needs to know how many are waiting and which files they are in, and it cannot
 * ask git — git cannot tell an edit made through the pencil from an edit made
 * in an editor, or by a coding agent working in the same tree at the same time,
 * and committing the second kind would be theft.
 *
 * WHERE IT LIVES. `.next/cache/` by default, which is gitignored in every
 * Next.js project by the framework's own convention, survives a dev-server
 * restart, and is thrown away by the same `rm -rf .next` that throws away
 * everything else derived. It is never committed and never read by anything but
 * this tool. `EDIT_MODE_LEDGER` moves it.
 *
 * WHAT KEEPS IT HONEST. A file whose edits have since been undone by hand is
 * dropped on read — `pendingEdits` asks git whether each remembered file still
 * differs, so the count on the button is what git would actually commit rather
 * than what the tool once did.
 *
 * WHY IT RECORDS THE SUBSTITUTIONS THEMSELVES and not merely a count. A count
 * is enough to label a button and nothing like enough to make a commit. Saving
 * used to commit each remembered file whole, which took whatever else was in it
 * — and on 2026-09-04 that meant a coding agent's unfinished work in the same
 * file went to a branch that deploys, and the build failed. So each edit is
 * written down as the exact pair it was: the run of text it replaced, and what
 * replaced it. `commit.ts` rebuilds the file from the last commit by replaying
 * those pairs, which is how a commit can hold one sentence out of a file that
 * two people are editing at once.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { ledgerPath } from "./config";
import { git, insideSrc, projectRoot } from "./git";

/**
 * One edit, as the substitution it performed. `removed` is the run of text that
 * was in the file before, byte for byte as the file held it; `replacement` is
 * what the tool put in its place. Together they are enough to redo the edit
 * against a different copy of the same file, which is what the commit does.
 */
export type LedgerSubstitution = {
  removed: string;
  replacement: string;
};

export type LedgerEntry = {
  file: string;
  edits: number;
  /** Every page an edit to this file was made from. Cancel reads it. */
  pages: string[];
  /**
   * What each edit to this file replaced, oldest first. Replayed in this order
   * on top of the file as the last commit holds it; an entry with none of these
   * is refused at commit time rather than guessed at.
   */
  substitutions: LedgerSubstitution[];
};

function readSubstitutions(value: unknown): LedgerSubstitution[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (
      typeof item === "object" &&
      item !== null &&
      typeof (item as LedgerSubstitution).removed === "string" &&
      typeof (item as LedgerSubstitution).replacement === "string"
    ) {
      const { removed, replacement } = item as LedgerSubstitution;
      return [{ removed, replacement }];
    }
    return [];
  });
}

async function readRaw(): Promise<LedgerEntry[]> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(ledgerPath(), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as LedgerEntry).file === "string" &&
        typeof (entry as LedgerEntry).edits === "number"
      ) {
        const { file, edits, pages } = entry as LedgerEntry;
        // A remembered path that is not inside the source directory is not one
        // this tool wrote, whatever the file says.
        if (!insideSrc(path.join(projectRoot(), file))) return [];
        return [
          {
            file,
            edits,
            pages: Array.isArray(pages) ? pages.filter((v) => typeof v === "string") : [],
            // Absent in a ledger written by a version that did not record them.
            // Kept as an empty list rather than invented, so the commit can
            // refuse the file and say why.
            substitutions: readSubstitutions((entry as LedgerEntry).substitutions),
          },
        ];
      }
      return [];
    });
  } catch {
    return []; // absent or unreadable is simply an empty ledger
  }
}

async function writeRaw(entries: LedgerEntry[]): Promise<void> {
  const file = ledgerPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(entries, null, 2), "utf8");
}

/**
 * Remember one more edit to `file` (a path relative to the project root), made
 * from `page`, which replaced `substitution.removed` with
 * `substitution.replacement`. The page is what Cancel works from: it reverts
 * what was typed on the page in front of you, not the whole session. The
 * substitution is what Save works from: it is the only record of which part of
 * the file this tool is entitled to commit.
 */
export async function recordEdit(
  file: string,
  page?: string,
  substitution?: LedgerSubstitution
): Promise<void> {
  const entries = await readRaw();
  const existing = entries.find((entry) => entry.file === file);
  if (existing) {
    existing.edits += 1;
    if (page && !existing.pages.includes(page)) existing.pages.push(page);
    if (substitution) existing.substitutions.push(substitution);
  } else {
    entries.push({
      file,
      edits: 1,
      pages: page ? [page] : [],
      substitutions: substitution ? [substitution] : [],
    });
  }
  await writeRaw(entries);
}

/** Forget the named files, whatever they hold. Used after a commit or a revert. */
export async function forgetFiles(files: string[]): Promise<void> {
  const drop = new Set(files);
  await writeRaw((await readRaw()).filter((entry) => !drop.has(entry.file)));
}

/**
 * The ledger, narrowed to files that still differ from HEAD. Anything reverted
 * by hand since it was written is dropped, here and in the stored ledger, so a
 * `git restore` is a complete undo with no residue on the button.
 *
 * AGAINST HEAD RATHER THAN AGAINST THE INDEX, which is not a distinction
 * without a difference. A bare `git diff` compares the working tree with the
 * index, so a file somebody else STAGED read as unchanged and vanished off the
 * button — the edit still in the file, counted nowhere, reported to nobody. It
 * is kept here instead, and the commit refuses it by name and says whose it is.
 */
export async function pendingEdits(): Promise<LedgerEntry[]> {
  const entries = await readRaw();
  if (entries.length === 0) return [];
  const changed = await git(["diff", "--name-only", "HEAD", "--", ...entries.map((e) => e.file)]);
  if (changed.code !== 0) return entries; // git unavailable: report what we know
  const live = new Set(changed.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
  const kept = entries.filter((entry) => live.has(entry.file));
  if (kept.length !== entries.length) await writeRaw(kept);
  return kept;
}

export async function clearLedger(): Promise<void> {
  await writeRaw([]);
}
