/**
 * The tool's behaviour, with no transport around it — one module a host imports
 * whichever way it reaches the browser.
 *
 * WHY THIS EXISTS. There are two hosts now. A Next.js dev server reaches the
 * engine over HTTP, through the route factories in `routes.ts`; an Electron app
 * reaches it over IPC, from a main process that already runs Node. Both do the
 * same five things, and the moment each host arranged those five things for
 * itself the two would begin to differ — a fix made against one, a message
 * reworded in one place. So the five live here, in terms of plain values, and
 * each host does nothing but carry the values in and the reply out. `routes.ts`
 * is left with its HTTP concerns and nothing else: the dev-only gate, the shape
 * of a malformed request, and which status code a reply deserves.
 *
 * NOTHING HERE THROWS. Every handler answers with a value, because a host that
 * has to catch is a host that will one day forget: an IPC handler that rejects
 * surfaces in the renderer as an unhelpful string, and the same failure over
 * HTTP would be a stack trace where a sentence belongs. A caught failure comes
 * back as `{ status: "error", message, tone: "alarm" }` — the same messages the
 * routes have always sent — and it is told apart from an engine reply that
 * merely reports a refusal by carrying no payload beside it.
 *
 * THE HEAVY MODULES STAY BEHIND DYNAMIC `import()`. The compiler, the git
 * plumbing and the file walker are loaded when a handler is actually called, so
 * a host that mounts the routes and answers 404 to everything — which is every
 * production build — never pulls any of it into a bundle. That was true of
 * `routes.ts` before this file existed and it has to stay true here, since this
 * is now the module both hosts import.
 */
import type { Candidate, EditResult, ResolvedBy, Tone } from "./copy-source";
import type { CommitResult } from "./commit";
import type { LedgerEntry, LedgerSubstitution } from "./ledger";
import type { RevertPlan, RevertResult } from "./revert";

export { configure } from "./config";
export type { EngineOptions } from "./config";
export type {
  Candidate,
  CommitResult,
  EditResult,
  LedgerEntry,
  LedgerSubstitution,
  ResolvedBy,
  RevertPlan,
  RevertResult,
  Tone,
};

/** What the browser sends to save one run of text. */
export type EditBody = {
  oldText: string;
  newText: string;
  /** The page the edit was made from. Cancel is scoped to it. */
  pagePath?: string;
  /** Rendered text immediately before the edited run. */
  before?: string;
  /** Rendered text immediately after it. */
  after?: string;
  /** Set on the second pass, when the writer has picked from the list. */
  target?: { file: string; line: number };
};

/**
 * A failure the engine caught rather than a refusal it decided on. It carries
 * no `pending` and no `plan`, which is how a host tells the two apart without
 * being told: `routes.ts` answers 500 for this and 200 for everything else.
 */
export type ErrorReply = { status: "error"; message: string; tone: "alarm" };

export type EditReply = (EditResult & { pending: LedgerEntry[] }) | ErrorReply;
export type PendingReply = { pending: LedgerEntry[] } | ErrorReply;
export type CommitReply = (CommitResult & { pending: LedgerEntry[] }) | ErrorReply;
export type RevertPlanReply = { plan: RevertPlan } | ErrorReply;
export type RevertReply = (RevertResult & { pending: LedgerEntry[] }) | ErrorReply;

/** The five things a host can ask for, as one shape a transport can implement. */
export type EditModeEngine = {
  edit(body: EditBody): Promise<EditReply>;
  pending(): Promise<PendingReply>;
  commit(): Promise<CommitReply>;
  revertPlan(page: string): Promise<RevertPlanReply>;
  revert(page: string): Promise<RevertReply>;
};

function failed(error: unknown, fallback: string): ErrorReply {
  return {
    status: "error",
    message: error instanceof Error ? error.message : fallback,
    tone: "alarm",
  };
}

/**
 * Find the run of text in the source, rewrite it, and remember the exact
 * substitution — the ledger records it with the file, because the commit is
 * rebuilt from these rather than from the working tree.
 */
export async function handleEdit(body: EditBody): Promise<EditReply> {
  try {
    const { editCopy } = await import("./copy-source");
    const { pendingEdits, recordEdit } = await import("./ledger");
    const result = await editCopy({
      oldText: body.oldText,
      newText: body.newText,
      pagePath: body.pagePath,
      before: body.before,
      after: body.after,
      target: body.target,
    });
    if (result.status === "saved") {
      await recordEdit(result.file, body.pagePath, {
        removed: result.removed,
        replacement: result.replacement,
      });
    }
    return { ...result, pending: await pendingEdits() };
  } catch (error) {
    return failed(error, "The save failed.");
  }
}

/** What is waiting to be saved, which is what puts the counts on the buttons. */
export async function handlePending(): Promise<PendingReply> {
  try {
    const { pendingEdits } = await import("./ledger");
    return { pending: await pendingEdits() };
  } catch (error) {
    return failed(error, "Could not read the ledger.");
  }
}

/** Commit exactly the recorded substitutions, and push unless told not to. */
export async function handleCommit(): Promise<CommitReply> {
  try {
    const { commitEdits } = await import("./commit");
    const { pendingEdits } = await import("./ledger");
    const result = await commitEdits();
    return { ...result, pending: await pendingEdits() };
  } catch (error) {
    return failed(error, "The commit failed.");
  }
}

/**
 * What Cancel would throw away on a page — including the two things a person
 * should see before destroying typed work: other pages whose edits ride along
 * in a shared file, and any file somebody has staged.
 */
export async function handleRevertPlan(page: string): Promise<RevertPlanReply> {
  try {
    const { planRevert } = await import("./revert");
    return { plan: await planRevert(page) };
  } catch (error) {
    return failed(error, "Could not read the ledger.");
  }
}

/** Throw it away. */
export async function handleRevert(page: string): Promise<RevertReply> {
  try {
    const { revertPage } = await import("./revert");
    const { pendingEdits } = await import("./ledger");
    const result = await revertPage(page);
    return { ...result, pending: await pendingEdits() };
  } catch (error) {
    return failed(error, "The revert failed.");
  }
}
