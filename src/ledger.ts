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
 */
import fs from "node:fs/promises";
import path from "node:path";
import { ledgerPath } from "./config";
import { git, insideSrc, projectRoot } from "./git";

export type LedgerEntry = {
  file: string;
  edits: number;
  /** Every page an edit to this file was made from. Cancel reads it. */
  pages: string[];
};

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
        return [{ file, edits, pages: Array.isArray(pages) ? pages.filter((v) => typeof v === "string") : [] }];
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
 * from `page`. The page is what Cancel works from: it reverts what was typed on
 * the page in front of you, not the whole session.
 */
export async function recordEdit(file: string, page?: string): Promise<void> {
  const entries = await readRaw();
  const existing = entries.find((entry) => entry.file === file);
  if (existing) {
    existing.edits += 1;
    if (page && !existing.pages.includes(page)) existing.pages.push(page);
  } else {
    entries.push({ file, edits: 1, pages: page ? [page] : [] });
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
 */
export async function pendingEdits(): Promise<LedgerEntry[]> {
  const entries = await readRaw();
  if (entries.length === 0) return [];
  const changed = await git(["diff", "--name-only", "--", ...entries.map((e) => e.file)]);
  if (changed.code !== 0) return entries; // git unavailable: report what we know
  const live = new Set(changed.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
  const kept = entries.filter((entry) => live.has(entry.file));
  if (kept.length !== entries.length) await writeRaw(kept);
  return kept;
}

export async function clearLedger(): Promise<void> {
  await writeRaw([]);
}
