"use client";

/**
 * The browser half of inline copy editing — a pencil in the corner of a
 * development server that turns the page's own sentences into fields, and a
 * Save button that commits what has been typed.
 *
 * DEVELOPMENT ONLY. The host reaches this module through a dynamic import
 * inside a branch its bundler resolves as dead in a production build, so no
 * part of it ships. The endpoints it posts to answer 404 outside development,
 * so even if it did ship it would have nothing to talk to.
 *
 * IT TALKS TO A TRANSPORT RATHER THAN TO THREE URLS. A Next.js dev server hands
 * it `fetchTransport`, which posts to the three routes on the same origin — the
 * default, and what every project got before there was a choice. An Electron
 * app hands it a transport whose five methods cross to the main process over
 * IPC, because a locked-down renderer's content security policy forbids the
 * fetch. Neither host changes anything below this line: the ring, the picker,
 * the panel and the three tones are the same code either way.
 *
 * IT IS RED ON PURPOSE. Every surface this file draws is red and white and
 * looks like nothing the host site ships — its own type, its own colour, not
 * one value borrowed from the page underneath. A tool that rewrites your source
 * files should be impossible to mistake for the page it sits on, and a tasteful
 * overlay that matched the site would be exactly that mistake. The one
 * exception is the Save button, which is green, because it is the only control
 * here that does something rather than warns about something.
 *
 * WHAT IT EDITS, and why the limit is where it is. A save has to find the
 * sentence in the source, and it can only do that when the sentence exists
 * there as one piece of text. So the unit is a single TEXT NODE: click a
 * paragraph and the whole paragraph becomes editable, but the save carries only
 * the one run that changed. A paragraph carrying an `<em>` is three runs, each
 * editable on its own; rewriting across the emphasis is a restructuring edit and
 * is refused with that said out loud rather than saved wrongly.
 *
 * NOTHING IS COMMITTED UNTIL THE SAVE BUTTON IS PRESSED. Edits accumulate as
 * ordinary uncommitted changes in the working tree; the button commits exactly
 * the substitutions this tool made — rebuilt on top of the last commit, so
 * nothing anybody else has typed in those files rides along — and pushes them
 * unless `EDIT_MODE_PUSH` says not to. An editor that committed on every
 * keystroke would fill a history with typing.
 *
 * SAVE AND CANCEL ARE BOTH PRESENT THE MOMENT THE MODE IS ON, and that is a
 * correction rather than a preference. Save used to appear only once the first
 * edit had landed, which meant the answer to "what do I do now I have finished
 * typing" was a control that was not on screen when the question was asked. So
 * both are drawn as soon as the mode is on, inert and saying why while there is
 * nothing to act on, rather than absent. A control that is missing teaches
 * nothing; a control that is present and greyed teaches what it is waiting for.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

/* The engine's reply shapes, as types only. `import type` is erased before a
   bundler sees it — guaranteed here by `isolatedModules` — so the browser half
   names the same shapes the Node half produces without ever reaching for a
   module that imports `node:fs`. React is this file's only real import. */
import type {
  CommitReply,
  EditBody,
  EditReply,
  PendingReply,
  RevertPlanReply,
  RevertReply,
} from "./engine";

/**
 * The five things the overlay asks of the engine, and the only route between
 * them. Whatever carries the call — an HTTP request to a dev server, an IPC
 * message to an Electron main process — the values on either side are the same,
 * so this file never learns which host it is running in.
 */
export type EditModeTransport = {
  edit(body: EditBody): Promise<EditReply>;
  pending(): Promise<PendingReply>;
  commit(): Promise<CommitReply>;
  revertPlan(page: string): Promise<RevertPlanReply>;
  revert(page: string): Promise<RevertReply>;
};

/** A reply for a route that is not mounted, in the engine's own error shape. */
const missing = (message: string) =>
  ({ status: "error", message, tone: "alarm" }) as const;

/**
 * The default transport: three routes on the same origin, which is what a
 * Next.js dev server mounts.
 *
 * The missing-endpoint alarm lives here rather than in the overlay, because it
 * is a fact about HTTP and about nothing else — an IPC transport has no 404 to
 * report, and an overlay that checked for one would be reading a status code
 * that never arrives.
 */
export function fetchTransport(endpoints: {
  editEndpoint: string;
  commitEndpoint: string;
  revertEndpoint: string;
}): EditModeTransport {
  const { editEndpoint, commitEndpoint, revertEndpoint } = endpoints;
  return {
    async edit(body) {
      const response = await fetch(editEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.status === 404) {
        return missing("The editing endpoint is not there. This only works on the dev server.");
      }
      return (await response.json()) as EditReply;
    },
    async pending() {
      const response = await fetch(commitEndpoint);
      if (!response.ok) {
        return missing("The commit endpoint is not there. This only works on the dev server.");
      }
      return (await response.json()) as PendingReply;
    },
    async commit() {
      const response = await fetch(commitEndpoint, { method: "POST" });
      if (response.status === 404) {
        return missing("The commit endpoint is not there. This only works on the dev server.");
      }
      return (await response.json()) as CommitReply;
    },
    async revertPlan(page) {
      const response = await fetch(`${revertEndpoint}?page=${encodeURIComponent(page)}`);
      if (!response.ok) {
        return missing("The revert endpoint is not there. This only works on the dev server.");
      }
      return (await response.json()) as RevertPlanReply;
    },
    async revert(page) {
      const response = await fetch(revertEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pagePath: page }),
      });
      return (await response.json()) as RevertReply;
    },
  };
}

export type EditModeProps = {
  /**
   * How to reach the engine. Left out, the overlay talks to the three endpoints
   * below over `fetch`, which is what a Next.js project wants and what every
   * project had before there was a choice.
   */
  transport?: EditModeTransport;
  /**
   * What to call the page an edit was made from, which is the scope Cancel
   * works in. A Next.js host passes `usePathname()`, so the counts follow a
   * client navigation; an Electron host passes a screen name. Left out, the
   * overlay reads `window.location.pathname` at the moment of each call, which
   * is right on a full page load and goes stale on a navigation that does not
   * reload — the reason to pass it.
   */
  page?: string;
  /** Where the host mounted the write route. Used by the default transport. */
  editEndpoint?: string;
  /** Where the host mounted the ledger + commit route. Likewise. */
  commitEndpoint?: string;
  /** Where the host mounted the revert route. Likewise. */
  revertEndpoint?: string;
};

type Candidate = {
  file: string;
  line: number;
  kind: string;
  preview: string;
  routes?: string[];
};

/**
 * Three tiers, dressed differently on purpose. A QUESTION is the tool asking
 * something and wears calm paper; a NOTE is a thing it cannot do here and wears
 * the same paper with a quieter label; an ALARM is something that actually went
 * wrong and is the only one that gets the solid red. Dressing all three alike is
 * how "which of these two did you mean?" came to read as a fault.
 */
type Tone = "question" | "note" | "alarm";

type LedgerEntry = { file: string; edits: number; pages: string[] };

type RevertPlan = {
  files: string[];
  edits: number;
  alsoPages: string[];
  staged: string[];
};

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; where: string; auto: boolean }
  | { kind: "committing" }
  | { kind: "committed"; message: string; tone: Tone }
  | { kind: "confirm-revert"; plan: RevertPlan }
  | { kind: "reverting" }
  | { kind: "reverted"; message: string }
  | { kind: "error"; message: string; tone: Tone }
  | { kind: "choose"; candidates: Candidate[] };

const STORAGE_KEY = "edit-mode:on";
const HOVER_ATTRIBUTE = "data-em-hover";
const EDITING_ATTRIBUTE = "data-em-active";

/** Tags that are never text to edit, whatever they contain. */
const OPAQUE = new Set([
  "HTML", "BODY", "HEAD", "SCRIPT", "STYLE", "SVG", "PATH", "CIRCLE", "RECT",
  "IMG", "VIDEO", "AUDIO", "CANVAS", "INPUT", "TEXTAREA", "SELECT", "OPTION",
  "IFRAME",
]);

function isOwnUi(node: Node | null): boolean {
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  return Boolean(element?.closest("[data-em-ui]"));
}

/** Every text node under `el`, in document order, after merging split runs. */
function textNodesOf(el: Element): Text[] {
  el.normalize();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const out: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    out.push(node as Text);
    node = walker.nextNode();
  }
  return out;
}

/**
 * Can this element be edited whole? It must own at least one run of real text,
 * and it must not contain anything laid out as a block — a `<div>` of
 * paragraphs is a container, and making it editable would let one keystroke
 * dissolve the structure underneath it.
 */
function isEditable(el: Element): boolean {
  if (OPAQUE.has(el.tagName)) return false;
  if (isOwnUi(el)) return false;
  if ((el as HTMLElement).isContentEditable) return false;

  let ownsText = false;
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE && child.nodeValue?.trim()) {
      ownsText = true;
      break;
    }
  }
  if (!ownsText) return false;

  for (const descendant of el.querySelectorAll("*")) {
    if (OPAQUE.has(descendant.tagName)) return false;
    const display = getComputedStyle(descendant).display;
    if (!display.startsWith("inline") && display !== "contents") return false;
  }
  return true;
}

/** The innermost editable element at or above `node`. */
function resolveEditable(node: EventTarget | null): HTMLElement | null {
  let el: Element | null =
    node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
  while (el && el !== document.body) {
    if (isEditable(el)) return el as HTMLElement;
    el = el.parentElement;
  }
  return null;
}

/** True when `el` is the only thing `parent` renders. */
function fillsParent(el: Element, parent: Element): boolean {
  for (const child of parent.childNodes) {
    if (child === el) continue;
    if (child.nodeType === Node.ELEMENT_NODE) return false;
    if (child.nodeType === Node.TEXT_NODE && child.nodeValue?.trim()) return false;
  }
  return true;
}

/**
 * The element the ring is drawn on, which is not always the element being
 * edited.
 *
 * A browser draws an outline on inline text one box per line, so a run that
 * wraps is ringed line by line rather than as the paragraph it is — and
 * `<p><span>the whole answer</span></p>` is the shape most content renderers
 * produce, which made the commonest case on a page look like eight separate
 * runs of text instead of one. Where the inline run is the only thing in its
 * block, the block's box is the same box, so outlining that draws the single
 * rectangle the text actually occupies. A run that shares its line with other
 * words keeps the per-line boxes, which is what it genuinely is.
 */
function highlightTarget(el: HTMLElement): HTMLElement {
  let current: HTMLElement = el;
  while (getComputedStyle(current).display.startsWith("inline")) {
    const parent = current.parentElement;
    if (!parent || parent === document.body) break;
    if (OPAQUE.has(parent.tagName) || isOwnUi(parent)) break;
    if (!fillsParent(current, parent)) break;
    current = parent;
  }
  return current;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * The rendered words on either side of the run being edited — what the server
 * uses to tell two copies of one sentence apart without asking.
 *
 * It walks the document's own text nodes in order rather than looking at
 * siblings, because the useful neighbour is often in another element entirely:
 * the heading above a paragraph, the label after a field. Roughly 200
 * characters each way is enough to separate two components and short enough
 * that it stays inside the same region of the same file.
 */
function neighboursOf(node: Text, span = 200): { before: string; after: string } {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const all: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    if (!isOwnUi(current)) all.push(current as Text);
    current = walker.nextNode();
  }
  const index = all.indexOf(node);
  if (index === -1) return { before: "", after: "" };

  let before = "";
  for (let i = index - 1; i >= 0 && before.length < span; i -= 1) {
    before = `${all[i].nodeValue ?? ""} ${before}`;
  }
  let after = "";
  for (let i = index + 1; i < all.length && after.length < span; i += 1) {
    after = `${after} ${all[i].nodeValue ?? ""}`;
  }
  return {
    before: collapse(before).slice(-span),
    after: collapse(after).slice(0, span),
  };
}

/**
 * Whether the mode is on is kept in localStorage rather than in state, and read
 * through `useSyncExternalStore`, so that it SURVIVES THE HOT RELOAD A SAVE
 * CAUSES — otherwise every edit would switch the tool off underneath you. The
 * server snapshot is always `false`, which is what makes the first paint match
 * on both sides; React re-renders with the real value the moment it hydrates.
 */
const modeListeners = new Set<() => void>();
let modeCache: boolean | null = null;

function readMode(): boolean {
  if (modeCache === null) {
    try {
      modeCache = window.localStorage.getItem(STORAGE_KEY) === "on";
    } catch {
      modeCache = false; // private browsing, or storage refused
    }
  }
  return modeCache;
}

function writeMode(next: boolean): void {
  modeCache = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
  } catch {
    /* see above — the mode still works, it just will not survive a reload */
  }
  for (const listener of modeListeners) listener();
}

function subscribeMode(listener: () => void): () => void {
  modeListeners.add(listener);
  return () => {
    modeListeners.delete(listener);
  };
}

const modeOffOnServer = () => false;

/**
 * Which of the three dresses a state wears. The rule is what the state IS, not
 * how inconvenient it is: only something that actually went wrong gets the
 * alarm. A question is a question even when it interrupts, and a thing the tool
 * cannot do here is a fact rather than a failure.
 */
function panelTone(status: Status): Tone | "progress" | "done" {
  switch (status.kind) {
    case "saving":
    case "committing":
    case "reverting":
      return "progress";
    case "saved":
    case "reverted":
      return "done";
    case "committed":
      return status.tone === "alarm" ? "alarm" : "done";
    case "choose":
      return "question";
    case "confirm-revert":
      return "alarm"; // it destroys typed work; that earns the loud dress
    case "error":
      return status.tone;
    default:
      return "note";
  }
}

export function EditModeOverlay({
  transport,
  page,
  editEndpoint = "/api/dev/edit-copy",
  commitEndpoint = "/api/dev/commit-copy",
  revertEndpoint = "/api/dev/revert-copy",
}: EditModeProps = {}) {
  const active = useSyncExternalStore(subscribeMode, readMode, modeOffOnServer);
  /* Memoised, because an unmemoised default would be a new object on every
     render and the effect below would re-read the ledger on every one of them. */
  const wire = useMemo(
    () => transport ?? fetchTransport({ editEndpoint, commitEndpoint, revertEndpoint }),
    [transport, editEndpoint, commitEndpoint, revertEndpoint]
  );
  /* The page a host named, or the address bar. The server render has neither,
     and answers "/" as it always did. */
  const here =
    page ?? (typeof window === "undefined" ? "/" : window.location.pathname);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [pending, setPending] = useState<LedgerEntry[]>([]);

  const editing = useRef<{ el: HTMLElement; mark: HTMLElement; html: string; runs: string[] } | null>(null);
  const held = useRef<{
    oldText: string;
    newText: string;
    context?: { before: string; after: string };
  } | null>(null);
  const hovered = useRef<HTMLElement | null>(null);

  const setMode = useCallback((next: boolean) => writeMode(next), []);

  /* What is waiting to be committed, re-read on every page so the two counts
     are right after a dev-server restart, a reload, or a click through the nav
     (which does not reload, so `location` alone would go stale). */
  useEffect(() => {
    let cancelled = false;
    wire
      .pending()
      .then((reply) => {
        if (!cancelled && "pending" in reply) setPending(reply.pending);
      })
      .catch(() => {
        /* the route is not mounted, or the server is restarting */
      });
    return () => {
      cancelled = true;
    };
  }, [wire, here]);

  const stopEditing = useCallback(() => {
    const current = editing.current;
    if (!current) return;
    current.el.removeAttribute("contenteditable");
    current.mark.removeAttribute(EDITING_ATTRIBUTE);
    editing.current = null;
  }, []);

  const send = useCallback(
    async (
      oldText: string,
      newText: string,
      target?: Candidate,
      context?: { before: string; after: string }
    ) => {
      setStatus({ kind: "saving" });
      try {
        const result = await wire.edit({
          oldText,
          newText,
          pagePath: page ?? window.location.pathname,
          before: context?.before,
          after: context?.after,
          target: target ? { file: target.file, line: target.line } : undefined,
        });
        if ("pending" in result) setPending(result.pending);
        if (result.status === "saved") {
          held.current = null;
          setStatus({
            kind: "saved",
            where: `${result.file}:${result.line}`,
            // Named in the confirmation whenever the tool chose for you, which
            // is the whole safety argument for choosing at all: a wrong guess
            // is visible the instant it is made, and Cancel undoes it.
            auto: result.resolvedBy === "import-graph" || result.resolvedBy === "context",
          });
        } else if (result.status === "multiple") {
          held.current = { oldText, newText, context };
          setStatus({ kind: "choose", candidates: result.candidates });
        } else {
          held.current = null;
          setStatus({
            kind: "error",
            tone: (result.tone as Tone) ?? "note",
            message: result.message ?? "The save failed.",
          });
        }
      } catch (error) {
        setStatus({
          kind: "error",
          tone: "alarm",
          message: error instanceof Error ? error.message : "The save failed.",
        });
      }
    },
    [wire, page]
  );

  /** Read what changed inside the element, then hand it to the server. */
  const commit = useCallback(() => {
    const current = editing.current;
    if (!current) return;
    const { el, runs } = current;
    stopEditing();

    const nodes = textNodesOf(el);
    const now = nodes.map((node) => node.nodeValue ?? "");
    if (now.length !== runs.length) {
      el.innerHTML = current.html;
      setStatus({
        kind: "error",
        tone: "note",
        message:
          "That edit changed the shape of the paragraph, not just its words. Inline editing handles one run of text at a time; the rest has to be made in the file.",
      });
      return;
    }

    const changed = now
      .map((value, index) => (value === runs[index] ? -1 : index))
      .filter((index) => index >= 0);

    if (changed.length === 0) {
      setStatus({ kind: "idle" });
      return;
    }
    if (changed.length > 1) {
      el.innerHTML = current.html;
      setStatus({
        kind: "error",
        tone: "note",
        message:
          "That edit crossed the markup inside the paragraph. Edit one run at a time — the plain text before an italic, or the italic itself.",
      });
      return;
    }

    const index = changed[0];
    const oldText = collapse(runs[index]);
    const newText = collapse(now[index]);
    if (oldText.length < 4) {
      el.innerHTML = current.html;
      setStatus({
        kind: "error",
        tone: "note",
        message: "That run is too short to find in the source. Edit a longer piece of it.",
      });
      return;
    }
    void send(oldText, newText, undefined, neighboursOf(nodes[index]));
  }, [send, stopEditing]);

  const revert = useCallback(() => {
    const current = editing.current;
    if (!current) return;
    current.el.innerHTML = current.html;
    stopEditing();
    setStatus({ kind: "idle" });
  }, [stopEditing]);

  const beginEditing = useCallback((el: HTMLElement, at?: { x: number; y: number }) => {
    if (editing.current?.el === el) return;
    editing.current = {
      el,
      mark: highlightTarget(el),
      html: el.innerHTML,
      runs: textNodesOf(el).map((node) => node.nodeValue ?? ""),
    };
    el.setAttribute("contenteditable", "plaintext-only");
    editing.current.mark.setAttribute(EDITING_ATTRIBUTE, "");
    el.spellcheck = true;
    el.focus({ preventScroll: true });

    // Put the caret where the click landed rather than at the start of the run.
    if (at) {
      const doc = document as Document & {
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      };
      const range =
        doc.caretRangeFromPoint?.(at.x, at.y) ??
        (() => {
          const position = doc.caretPositionFromPoint?.(at.x, at.y);
          if (!position) return null;
          const r = document.createRange();
          r.setStart(position.offsetNode, position.offset);
          r.collapse(true);
          return r;
        })();
      if (range) {
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
    setStatus({ kind: "idle" });
  }, []);

  /* ---- the listeners, live only while the mode is on ---- */
  useEffect(() => {
    if (!active) {
      document.documentElement.removeAttribute("data-em-mode");
      hovered.current?.removeAttribute(HOVER_ATTRIBUTE);
      hovered.current = null;
      stopEditing();
      return;
    }
    document.documentElement.setAttribute("data-em-mode", "");

    const onMove = (event: MouseEvent) => {
      if (editing.current) return;
      const el = isOwnUi(event.target as Node) ? null : resolveEditable(event.target);
      const mark = el ? highlightTarget(el) : null;
      if (mark === hovered.current) return;
      hovered.current?.removeAttribute(HOVER_ATTRIBUTE);
      hovered.current = mark;
      mark?.setAttribute(HOVER_ATTRIBUTE, "");
    };

    const onClick = (event: MouseEvent) => {
      if (isOwnUi(event.target as Node)) return;
      if (editing.current) {
        if (editing.current.el.contains(event.target as Node)) return;
        commit();
        return;
      }
      const el = resolveEditable(event.target);
      if (!el) return;
      // A link or a button under the pointer would navigate out from under the
      // edit, so nothing on the page gets the click while the mode is on.
      event.preventDefault();
      event.stopPropagation();
      hovered.current?.removeAttribute(HOVER_ATTRIBUTE);
      hovered.current = null;
      beginEditing(el, { x: event.clientX, y: event.clientY });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!editing.current) {
        if (event.key === "Escape") setMode(false);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        revert();
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        commit();
      }
    };

    /* Tabbing or clicking away is a save, the same as pressing Enter. */
    const onFocusOut = (event: FocusEvent) => {
      const current = editing.current;
      if (!current) return;
      const next = event.relatedTarget as Node | null;
      if (next && current.el.contains(next)) return;
      commit();
    };

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusout", onFocusOut, true);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.documentElement.removeAttribute("data-em-mode");
      hovered.current?.removeAttribute(HOVER_ATTRIBUTE);
      hovered.current = null;
    };
  }, [active, beginEditing, commit, revert, setMode, stopEditing]);

  /* A saved confirmation clears itself; everything else waits to be read. */
  useEffect(() => {
    if (status.kind !== "saved") return;
    const timer = window.setTimeout(() => setStatus({ kind: "idle" }), 4000);
    return () => window.clearTimeout(timer);
  }, [status]);

  const chooseCandidate = useCallback(
    (candidate: Candidate) => {
      const carried = held.current;
      if (!carried) return;
      void send(carried.oldText, carried.newText, candidate, carried.context);
    },
    [send]
  );

  const saveAll = useCallback(async () => {
    setStatus({ kind: "committing" });
    try {
      const result = await wire.commit();
      /* A reply with no pending list is one the engine caught a failure for,
         and a failed commit has not changed what is waiting. Zeroing the counts
         there would tell the writer their edits had gone. */
      if ("pending" in result) setPending(result.pending);
      if (result.status === "committed") {
        setStatus({
          kind: "committed",
          message: result.message,
          tone: (result.tone as Tone) ?? "note",
        });
      } else if (result.status === "nothing") {
        setStatus({ kind: "error", tone: "note", message: result.message });
      } else {
        setStatus({
          kind: "error",
          tone: (result.tone as Tone) ?? "alarm",
          message: result.message ?? "The commit failed.",
        });
      }
    } catch (error) {
      setStatus({
        kind: "error",
        tone: "alarm",
        message: error instanceof Error ? error.message : "The commit failed.",
      });
    }
  }, [wire]);

  /** What Cancel would take, asked of the server before anything is destroyed. */
  const askRevert = useCallback(async () => {
    try {
      const reply = await wire.revertPlan(page ?? window.location.pathname);
      if (!("plan" in reply)) {
        setStatus({ kind: "error", tone: reply.tone, message: reply.message });
        return;
      }
      const plan: RevertPlan | undefined = reply.plan;
      if (!plan || plan.files.length === 0) {
        setStatus({ kind: "error", tone: "note", message: "Nothing on this page to revert." });
        return;
      }
      setStatus({ kind: "confirm-revert", plan });
    } catch (error) {
      setStatus({
        kind: "error",
        tone: "alarm",
        message: error instanceof Error ? error.message : "Could not read what to revert.",
      });
    }
  }, [wire, page]);

  const doRevert = useCallback(async () => {
    setStatus({ kind: "reverting" });
    try {
      const result = await wire.revert(page ?? window.location.pathname);
      if ("pending" in result) setPending(result.pending);
      if (result.status === "reverted") {
        setStatus({ kind: "reverted", message: result.message });
        // The files on disk have moved back; the page in the browser has not.
        window.setTimeout(() => window.location.reload(), 900);
      } else {
        setStatus({
          kind: "error",
          tone: (result.tone as Tone) ?? "alarm",
          message: result.message ?? "The revert failed.",
        });
      }
    } catch (error) {
      setStatus({
        kind: "error",
        tone: "alarm",
        message: error instanceof Error ? error.message : "The revert failed.",
      });
    }
  }, [wire, page]);

  const waiting = pending.reduce((total, entry) => total + entry.edits, 0);
  const onThisPage = pending.filter((entry) => entry.pages.includes(here));
  const revertable = onThisPage.reduce((total, entry) => total + entry.edits, 0);

  return (
    <div data-em-ui="">
      <style>{OVERLAY_CSS}</style>

      {status.kind !== "idle" && (
        <div className="em-panel" data-tone={panelTone(status)} role="status" aria-live="polite">
          {status.kind === "saving" && <p className="em-line">Saving…</p>}
          {status.kind === "committing" && <p className="em-line">Committing and pushing…</p>}
          {status.kind === "reverting" && <p className="em-line">Reverting…</p>}
          {status.kind === "reverted" && <p className="em-line">{status.message}</p>}
          {status.kind === "confirm-revert" && (
            <div>
              <p className="em-line">
                Revert {status.plan.edits}{" "}
                {status.plan.edits === 1 ? "edit" : "edits"} on this page? The typed
                words are thrown away — this cannot be undone from here.
              </p>
              {status.plan.alsoPages.length > 0 && (
                <p className="em-line">
                  A file here was also edited on{" "}
                  {status.plan.alsoPages.map((page) => (
                    <code key={page}>{page}</code>
                  ))}
                  . Reverting takes those edits with it, because git restores whole
                  files.
                </p>
              )}
              {status.plan.staged.length > 0 && (
                <p className="em-line">
                  Somebody has staged{" "}
                  {status.plan.staged.map((file) => (
                    <code key={file}>{file}</code>
                  ))}
                  . Reverting restores it from the last commit, so their staged work
                  goes from the working tree too. Ask before clicking.
                </p>
              )}
              <ul className="em-list">
                {status.plan.files.map((file) => (
                  <li key={file}>
                    <span className="em-plain">{file}</span>
                  </li>
                ))}
              </ul>
              <div className="em-row">
                <button type="button" className="em-confirm" onClick={() => void doRevert()}>
                  Revert them
                </button>
                <button
                  type="button"
                  className="em-keep"
                  onClick={() => setStatus({ kind: "idle" })}
                >
                  Keep them
                </button>
              </div>
            </div>
          )}
          {status.kind === "saved" && (
            <p className="em-line">
              Written to <code>{status.where}</code>
              {status.auto ? ", picked from the page you are on." : "."} The page
              reloads itself.
            </p>
          )}
          {status.kind === "committed" && <p className="em-line">{status.message}</p>}
          {status.kind === "error" && <p className="em-line">{status.message}</p>}
          {status.kind === "choose" && (
            <div>
              <p className="em-line">
                This sentence is in {status.candidates.length === 2 ? "two" : status.candidates.length}{" "}
                places and reads the same in both — which one did you mean?
              </p>
              <ul className="em-list">
                {status.candidates.map((candidate) => (
                  <li key={`${candidate.file}:${candidate.line}`}>
                    <button type="button" onClick={() => chooseCandidate(candidate)}>
                      {candidate.routes && candidate.routes.length > 0 && (
                        <strong>
                          {candidate.routes.length === 1
                            ? `Shown on ${candidate.routes[0]}`
                            : `Shown on ${candidate.routes.join(", ")}`}
                        </strong>
                      )}
                      <code>
                        {candidate.file}:{candidate.line}
                      </code>
                      <span>{candidate.preview}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {status.kind !== "saving" &&
            status.kind !== "committing" &&
            status.kind !== "reverting" &&
            status.kind !== "confirm-revert" && (
            <button
              type="button"
              className="em-dismiss"
              onClick={() => {
                held.current = null;
                setStatus({ kind: "idle" });
              }}
            >
              Dismiss
            </button>
          )}
        </div>
      )}

      {active && (
        <div className="em-row">
          <button
            type="button"
            className="em-cancel"
            onClick={() => void askRevert()}
            disabled={revertable === 0 || status.kind === "reverting"}
            title={
              revertable === 0
                ? "Nothing typed on this page yet"
                : onThisPage.map((entry) => entry.file).join("\n")
            }
          >
            {revertable > 0 ? `Cancel ${revertable}` : "Cancel"}
            <span className="em-note">
              {revertable > 0 ? "revert this page" : "nothing to revert"}
            </span>
          </button>

          <button
            type="button"
            className="em-save"
            onClick={() => void saveAll()}
            disabled={waiting === 0 || status.kind === "committing"}
            title={
              waiting === 0
                ? "Nothing typed yet"
                : pending.map((entry) => entry.file).join("\n")
            }
          >
            {status.kind === "committing"
              ? "Saving…"
              : waiting > 0
                ? `Save ${waiting}`
                : "Save"}
            <span className="em-note">
              {waiting > 0
                ? `commit ${pending.length} ${pending.length === 1 ? "file" : "files"} and push`
                : "nothing to save"}
            </span>
          </button>
        </div>
      )}

      <button
        type="button"
        className="em-toggle"
        data-on={active ? "" : undefined}
        onClick={() => {
          if (active) revert();
          setMode(!active);
          setStatus({ kind: "idle" });
        }}
        aria-pressed={active}
        title={
          active
            ? "Copy editing is on — click any sentence. Enter saves, Esc reverts."
            : "Edit copy in place (development only)"
        }
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            d="M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M14 8l2 2" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </svg>
        {active ? "End Editing" : "Edit copy"}
      </button>
    </div>
  );
}

/**
 * The overlay carries its own stylesheet rather than adding rules to the host's,
 * so a production stylesheet has nothing of this in it even by accident — and so
 * that not one value here is borrowed from the site underneath. That is the
 * point of the red: this is a test surface, and it is meant to be impossible to
 * mistake for the page it sits on.
 */
const RED = "#c8102e";
const RED_DEEP = "#8f0b20";
const GREEN = "#137a3a";
const GREEN_DEEP = "#0d5a2a";

const OVERLAY_CSS = `
[data-em-ui] {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 2147483000;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 12px;
}
[data-em-ui] * { box-sizing: border-box; }

.em-toggle {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  padding: 13px 20px 13px 16px;
  border: 3px solid #ffffff;
  border-radius: 999px;
  background: ${RED};
  color: #ffffff;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 0 0 2px ${RED_DEEP}, 0 8px 26px rgba(0, 0, 0, 0.34);
}
.em-toggle:hover { background: ${RED_DEEP}; }
.em-toggle:focus-visible { outline: 3px solid #ffffff; outline-offset: 3px; }
.em-toggle[data-on] {
  background: #ffffff;
  color: ${RED};
  border-color: ${RED};
  box-shadow: 0 0 0 3px ${RED}, 0 8px 26px rgba(0, 0, 0, 0.34);
}

/* Save and Cancel sit side by side and are BOTH present the whole time the mode
   is on — greyed and saying why when there is nothing to act on, never absent.
   See the note at the top of this file for why that is not a preference. */
.em-row { display: flex; gap: 10px; align-items: stretch; }

.em-save,
.em-cancel {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 13px 22px;
  border: 3px solid #ffffff;
  border-radius: 12px;
  font-size: 18px;
  font-weight: 800;
  letter-spacing: 0.02em;
  line-height: 1.1;
  cursor: pointer;
}
.em-save { background: ${GREEN}; color: #ffffff; box-shadow: 0 0 0 2px ${GREEN_DEEP}, 0 10px 30px rgba(0, 0, 0, 0.34); }
.em-cancel { background: #ffffff; color: ${RED}; box-shadow: 0 0 0 2px ${RED}, 0 10px 30px rgba(0, 0, 0, 0.34); }
.em-save:hover:not(:disabled) { background: ${GREEN_DEEP}; }
.em-cancel:hover:not(:disabled) { background: #ffe9ec; }
.em-save:focus-visible, .em-cancel:focus-visible { outline: 3px solid #241f18; outline-offset: 3px; }
.em-save:disabled, .em-cancel:disabled { opacity: 0.55; cursor: default; }
.em-note {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  opacity: 0.92;
  white-space: nowrap;
}

.em-confirm, .em-keep {
  padding: 10px 18px;
  border-radius: 9px;
  border: 2px solid #ffffff;
  font: inherit;
  font-size: 14px;
  font-weight: 800;
  cursor: pointer;
}
.em-confirm { background: #ffffff; color: ${RED_DEEP}; }
.em-confirm:hover { background: #ffe9ec; }
.em-keep { background: transparent; color: #ffffff; }
.em-keep:hover { background: rgba(0, 0, 0, 0.16); }
.em-plain {
  display: block;
  padding: 5px 9px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.2);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* THREE DRESSES, AND ONLY ONE OF THEM IS ALARMING. A question and a
   can't-do-that-here sit on white paper inside the red frame — still plainly
   part of this tool, still plainly a test surface, but calm. The solid red is
   kept for something that actually went wrong, and for the revert confirm,
   which destroys typed work. Everything wore the solid red before, which is why
   being asked which of two files to write read as a fault. */
.em-panel {
  max-width: 500px;
  padding: 16px 18px;
  border: 3px solid ${RED};
  border-radius: 12px;
  background: #ffffff;
  color: #241f18;
  font-size: 14.5px;
  line-height: 1.5;
  box-shadow: 0 0 0 2px #ffffff, 0 12px 36px rgba(0, 0, 0, 0.3);
  text-align: left;
}
.em-panel[data-tone="alarm"] {
  border-color: #ffffff;
  background: ${RED};
  color: #ffffff;
  box-shadow: 0 0 0 2px ${RED_DEEP}, 0 12px 36px rgba(0, 0, 0, 0.38);
}
.em-panel[data-tone="done"] { border-color: ${GREEN}; }
.em-panel[data-tone="done"] .em-line { color: ${GREEN_DEEP}; }
.em-panel[data-tone="progress"] { border-color: ${RED}; opacity: 0.95; }

.em-line { margin: 0 0 10px; font-weight: 600; }
.em-panel code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
  background: rgba(0, 0, 0, 0.08);
  padding: 1px 5px;
  border-radius: 4px;
}
.em-panel[data-tone="alarm"] code { background: rgba(0, 0, 0, 0.22); }
.em-list { list-style: none; margin: 0 0 10px; padding: 0; max-height: 270px; overflow-y: auto; }
.em-list li + li { margin-top: 6px; }
.em-list button {
  display: block;
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  border: 2px solid #e6d9c6;
  border-radius: 8px;
  background: #fbf7ee;
  cursor: pointer;
  color: #241f18;
  font: inherit;
  font-weight: 600;
}
.em-list button:hover { border-color: ${RED}; background: #ffffff; }
.em-list button strong {
  display: block;
  margin-bottom: 4px;
  font-size: 14px;
  font-weight: 800;
  color: ${RED_DEEP};
}
.em-list button code {
  display: inline-block;
  background: rgba(0, 0, 0, 0.07);
  color: #4a4034;
  font-size: 11.5px;
}
.em-list button span {
  display: block;
  margin-top: 4px;
  color: #6e6656;
  font-size: 12px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.em-dismiss {
  border: 0;
  background: none;
  padding: 0;
  color: ${RED_DEEP};
  font: inherit;
  font-size: 12.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}
.em-panel[data-tone="alarm"] .em-dismiss { color: #ffffff; }
.em-panel[data-tone="done"] .em-dismiss { color: ${GREEN_DEEP}; }

html[data-em-mode] [${HOVER_ATTRIBUTE}] {
  outline: 2px dashed ${RED};
  outline-offset: 3px;
  cursor: text;
  border-radius: 2px;
}
html[data-em-mode] [${EDITING_ATTRIBUTE}] {
  outline: 3px solid ${RED};
  outline-offset: 3px;
  background: rgba(200, 16, 46, 0.1);
  border-radius: 2px;
}
`;
