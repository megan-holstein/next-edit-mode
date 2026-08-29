/**
 * The source half of inline copy editing — finding a sentence the browser is
 * showing inside the files that produced it, and writing a replacement back.
 *
 * DEVELOPMENT ONLY. Its one caller is the edit route the host project mounts,
 * which answers 404 unless NODE_ENV is `development` and loads this module only
 * after that check. See the README for the whole of the argument.
 *
 * WHY THE TYPESCRIPT COMPILER RATHER THAN A REGULAR EXPRESSION. A sentence on
 * the page arrives here decoded: the browser hands back `he said "no"` where
 * the file holds `"he said \"no\""`, and the JSX run that renders a paragraph
 * is wrapped across four lines with whatever indentation the file uses. A
 * textual search cannot reliably tell a string literal from a comment that
 * quotes it, and cannot re-escape a replacement without knowing which quote
 * character opened the literal. So .ts and .tsx are parsed, and every edit is
 * made against a real StringLiteral, NoSubstitutionTemplateLiteral or JsxText
 * node — its exact span replaced with a correctly re-encoded literal.
 *
 * The compiler is taken from the HOST PROJECT's own `node_modules`, which every
 * TypeScript project already has, so this tool declares no dependency of its
 * own. It is loaded at RUNTIME rather than imported, which is deliberate: a
 * plain `import` would put eight megabytes of compiler into the production
 * server bundle for a route that only ever returns 404 there.
 *
 * The load goes through `process.getBuiltinModule`, and that detail is load-
 * bearing. Turbopack replaces an imported `createRequire` with its own, which
 * refuses any specifier it cannot resolve at build time ("Cannot find module as
 * expression is too dynamic") — so the obvious spelling of this failed silently
 * on every .tsx file and the tool reported perfectly ordinary copy as
 * unfindable. `process` is a runtime global no bundler rewrites, so the
 * `createRequire` reached through it is Node's own.
 *
 * A SAVE IS A SPLICE INTO THE FILE AS IT STANDS AT THE MOMENT OF WRITING, AND
 * NEVER A REWRITE FROM AN EARLIER READ. This is the one invariant here worth
 * stating on its own, because breaking it destroys work rather than merely
 * failing. Finding the sentence means reading and parsing every candidate file
 * in the source directory, which takes long enough for somebody else — a person
 * in an editor, a coding agent in the same tree — to write one of those files
 * while the search is still running. Version 1.0.0 composed the write from the
 * buffer the SEARCH had read, so every byte outside the replaced span came from
 * a file that no longer existed, and any edit made in that window was silently
 * reverted by a save that reported success. So the chosen file is read again,
 * parsed again, and the sentence located again in THAT content; the write is a
 * slice of that read with one span replaced, and `editCopy` asserts as much
 * before the write rather than trusting itself. If the sentence is no longer
 * there, nothing is written and the answer says so.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type * as TS from "typescript";
import { sourceDirectoryLabel, sourcePrefix } from "./config";
import { insideSrc, projectRoot, srcRoot } from "./git";
import { entriesForPage, reachableFrom, routesMounting } from "./imports";

let cachedTs: typeof TS | null = null;
function compiler(): typeof TS {
  if (!cachedTs) {
    const { createRequire } = process.getBuiltinModule("module");
    // Resolved from the project root, so it finds the worktree's own copy
    // rather than anything that happens to sit beside a bundled chunk.
    const fromRoot = createRequire(path.join(projectRoot(), "package.json"));
    cachedTs = fromRoot("typescript") as typeof TS;
  }
  return cachedTs;
}

const EDITABLE_EXTENSIONS = new Set([".ts", ".tsx", ".mdx", ".md"]);
const SKIP_DIRECTORIES = new Set(["node_modules", ".next", ".git"]);

/**
 * The shortest run of text this tool will act on. Below it a match says almost
 * nothing about where it came from — "Save" occurs in a dozen files — and the
 * disambiguation list would be longer than the sentence.
 */
export const MIN_TEXT_LENGTH = 4;

export type MatchKind = "string" | "template" | "jsx" | "markdown";

export type Candidate = {
  /** Path relative to the repository root, e.g. `src/content/home.ts`. */
  file: string;
  /** 1-based line of the match, for display. */
  line: number;
  kind: MatchKind;
  /** A short window of the surrounding source, so two hits are tellable apart. */
  preview: string;
  /** The routes that mount this file — the hint a person can actually use. */
  routes?: string[];
};

/** Which rung of the ladder answered. Shown in the confirmation, so a wrong
    guess is visible the moment it is made. */
export type ResolvedBy = "only-match" | "import-graph" | "context" | "picked";

export type EditRequest = {
  oldText: string;
  newText: string;
  /** The route the browser was on. The first rung of the ladder works from it. */
  pagePath?: string;
  /** Rendered text immediately before the edited run, for the second rung. */
  before?: string;
  /** Rendered text immediately after it. */
  after?: string;
  /** Set on the second pass, when the writer has picked from that list. */
  target?: { file: string; line: number };
};

/**
 * The three tiers a reply can be, and they are deliberately not one thing.
 * A QUESTION is the tool asking something; a NOTE is a thing it cannot do here
 * and never will; an ALARM is something that actually went wrong. Dressing all
 * three the same is how "which of these two did you mean?" came to read as a
 * fault: the first person to meet the picker reported it as "some kind of
 * error". Only an alarm gets alarm dress.
 */
export type Tone = "question" | "note" | "alarm";

export type EditResult =
  | { status: "saved"; file: string; line: number; resolvedBy: ResolvedBy }
  | { status: "none"; message: string; tone: Tone }
  | { status: "multiple"; candidates: Candidate[]; tone: Tone }
  | { status: "error"; message: string; tone: Tone };

/* ------------------------------------------------------------------ text */

/**
 * The browser collapses every run of whitespace in flowed text to one space,
 * so a paragraph wrapped across four source lines reaches the page as one
 * line. Both sides of every comparison here pass through this, which is what
 * lets a sentence typed in the browser find the sentence in the file.
 */
export function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

type NormalizedIndex = {
  norm: string;
  /** Original offset each normalized character begins at. */
  starts: number[];
  /** Original offset each normalized character ends at (exclusive). */
  ends: number[];
};

/**
 * Normalize a string while keeping the map back to the original offsets, so a
 * match found in the collapsed form can be cut out of the file verbatim.
 */
function normalizedIndex(source: string): NormalizedIndex {
  let norm = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) {
      const runStart = i;
      while (i < source.length && /\s/.test(source[i])) i += 1;
      // Leading whitespace is dropped; trailing whitespace never gets emitted
      // because the loop ends first.
      if (norm.length > 0 && i < source.length) {
        norm += " ";
        starts.push(runStart);
        ends.push(i);
      }
      continue;
    }
    norm += source[i];
    starts.push(i);
    ends.push(i + 1);
    i += 1;
  }
  return { norm, starts, ends };
}

/** Every original-offset range in `haystack` whose collapsed form is `needle`. */
function findNormalizedRanges(
  haystack: string,
  needle: string
): { start: number; end: number }[] {
  const target = normalize(needle);
  if (!target) return [];
  const { norm, starts, ends } = normalizedIndex(haystack);
  const out: { start: number; end: number }[] = [];
  let from = 0;
  for (;;) {
    const at = norm.indexOf(target, from);
    if (at === -1) break;
    out.push({ start: starts[at], end: ends[at + target.length - 1] });
    from = at + target.length;
  }
  return out;
}

/* ------------------------------------------------------------- traversal */

async function collectFiles(dir: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".well-known") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      await collectFiles(full, out);
    } else if (EDITABLE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
}

/* ----------------------------------------------------------------- nodes */

/**
 * One place in one file that could be the sentence on screen. `replace` is the
 * exact span to cut, and `encode` turns a new plain-text value into whatever
 * that span has to contain to remain valid source.
 */
type Site = {
  file: string;
  kind: MatchKind;
  /** The plain text this site contributes to the page. */
  value: string;
  /** Span of the whole site in the file, as it will be replaced. */
  span: { start: number; end: number };
  encode: (nextValue: string) => string;
};

/** Escape a plain string for a `'`- or `"`-quoted literal. */
function encodeQuoted(value: string, quote: '"' | "'"): string {
  const body = value
    .replace(/\\/g, "\\\\")
    .replace(new RegExp(quote, "g"), `\\${quote}`)
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `${quote}${body}${quote}`;
}

/** Escape a plain string for a template literal with no substitutions. */
function encodeTemplate(value: string): string {
  const body = value
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
  return `\`${body}\``;
}

/**
 * Re-wrap a run of JSX text at the indentation it already used. JSX collapses
 * whitespace, so this changes nothing about the rendered page; it is only so a
 * replaced paragraph does not land in the file as one 300-character line.
 */
function wrapJsxText(value: string, indent: string, width = 76): string {
  const words = value.split(/\s+/).filter(Boolean);
  if (!words.length) return value;
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (indent.length + candidate.length > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.join(`\n${indent}`);
}

/** The whitespace opening the line that `offset` sits on. */
function indentAt(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const match = /^[ \t]*/.exec(source.slice(lineStart, offset));
  return match ? match[0] : "";
}

/**
 * Characters JSX reads as markup rather than as text. A replacement carrying
 * one of them would have to become an expression container or an entity, which
 * is a restructuring edit and therefore outside what this tool does.
 */
const JSX_UNSAFE = /[<>{}]/;

function sitesInTypeScript(file: string, source: string): Site[] {
  const ts = compiler();
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    kind
  );
  const sites: Site[] = [];

  const visit = (node: TS.Node): void => {
    if (ts.isStringLiteral(node)) {
      const start = node.getStart(sourceFile);
      const quote = source[start] === "'" ? "'" : '"';
      sites.push({
        file,
        kind: "string",
        value: node.text,
        span: { start, end: node.getEnd() },
        encode: (next) => encodeQuoted(next, quote),
      });
    } else if (ts.isNoSubstitutionTemplateLiteral(node)) {
      sites.push({
        file,
        kind: "template",
        value: node.text,
        span: { start: node.getStart(sourceFile), end: node.getEnd() },
        encode: encodeTemplate,
      });
    } else if (ts.isJsxText(node)) {
      const raw = node.getText(sourceFile);
      if (normalize(raw)) {
        const start = node.getStart(sourceFile);
        // Whatever whitespace opened and closed the run is kept exactly: it is
        // what separates this run from the `<em>` beside it, and JSX renders
        // that separation as a space the reader can see.
        const lead = /^\s*/.exec(raw)![0];
        const trail = /\s*$/.exec(raw)![0];
        const indent = lead.includes("\n")
          ? /[ \t]*$/.exec(lead)![0]
          : indentAt(source, start);
        sites.push({
          file,
          kind: "jsx",
          // The run WITHOUT its surrounding whitespace, since `encode` puts
          // that back; carrying it in the value would double it.
          value: raw.slice(lead.length, raw.length - trail.length),
          span: { start, end: node.getEnd() },
          encode: (next) => {
            if (JSX_UNSAFE.test(next)) throw new Error("jsx-unsafe");
            return `${lead}${wrapJsxText(next, indent)}${trail}`;
          },
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return sites;
}

/** Markdown is edited as flat text; the whole file is one site. */
function sitesInMarkdown(file: string, source: string): Site[] {
  return [
    {
      file,
      kind: "markdown",
      value: source,
      span: { start: 0, end: source.length },
      encode: (next) => next,
    },
  ];
}

/** Every place in one file that could be the sentence, by the file's own rules. */
function sitesIn(file: string, source: string): Site[] {
  const extension = path.extname(file);
  return extension === ".ts" || extension === ".tsx"
    ? sitesInTypeScript(file, source)
    : sitesInMarkdown(file, source);
}

/* --------------------------------------------------------------- finding */

type Hit = {
  site: Site;
  /** Offsets WITHIN `site.value` that the old text occupies. */
  inner: { start: number; end: number };
  /** Whole-site match rather than a fragment of one. */
  exact: boolean;
};

function hitsInSite(site: Site, oldText: string): Hit[] {
  const target = normalize(oldText);
  if (normalize(site.value) === target) {
    // Whitespace at either end of the literal is left alone. A trailing space
    // in `"Read the guide "` is doing spacing work beside a link, and a
    // replacement that trimmed it would close the gap on the page.
    const lead = /^\s*/.exec(site.value)![0].length;
    const trail = /\s*$/.exec(site.value)![0].length;
    return [
      { site, inner: { start: lead, end: site.value.length - trail }, exact: true },
    ];
  }
  return findNormalizedRanges(site.value, target).map((inner) => ({
    site,
    inner,
    exact: false,
  }));
}

/**
 * Every hit in one file, with the same preference the sweep applies across all
 * of them: an exact whole-literal match outranks a sentence that merely occurs
 * inside a longer one. Consistent by construction — the sweep only ever settles
 * on a fragment when no file held an exact match, so a file reached with a
 * fragment in hand has no exact match to shadow it.
 */
function hitsIn(sites: Site[], oldText: string): Hit[] {
  const exact: Hit[] = [];
  const fragment: Hit[] = [];
  for (const site of sites) {
    for (const hit of hitsInSite(site, oldText)) (hit.exact ? exact : fragment).push(hit);
  }
  return exact.length ? exact : fragment;
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}

function previewAround(source: string, offset: number): string {
  const start = Math.max(0, offset - 40);
  const text = normalize(source.slice(start, offset + 90));
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

function toCandidate(hit: Hit, source: string, root: string): Candidate {
  const offset = hit.site.span.start + (hit.site.kind === "markdown" ? hit.inner.start : 0);
  return {
    file: path.relative(root, hit.site.file),
    line: lineOf(source, offset),
    kind: hit.site.kind,
    preview: previewAround(source, offset),
  };
}


/* ---------------------------------------------------------------- ladder */

/** The absolute offset in the file where a hit's text begins. */
function offsetOf(hit: Hit): number {
  return hit.site.span.start + (hit.site.kind === "markdown" ? hit.inner.start : 0);
}

/**
 * RUNG ONE — keep only candidates the current page could actually render,
 * by walking the import graph from that route's page and layouts.
 *
 * Two guards keep it from ever making things worse. It is skipped when the
 * route cannot be resolved, and DISCARDED when it would remove every candidate
 * — which is what happens for markdown read at runtime with `fs`, since no
 * import reaches it. A filter that empties the field has learned nothing and
 * must not be trusted over the field it emptied.
 */
function narrowByPage(hits: Hit[], pagePath?: string): Hit[] {
  if (!pagePath) return hits;
  let reachable: Set<string>;
  try {
    const entries = entriesForPage(pagePath);
    if (entries.length === 0) return hits;
    reachable = reachableFrom(compiler(), entries);
  } catch {
    return hits;
  }
  const kept = hits.filter((hit) => reachable.has(hit.site.file));
  return kept.length === 0 ? hits : kept;
}

/**
 * RUNG TWO — score each remaining candidate on whether the words the browser
 * saw AROUND the edited run also sit around this occurrence in the file.
 *
 * The client sends the rendered text on either side. Two copies of one sentence
 * in different components almost never share their neighbours, so this settles
 * nearly everything rung one could not. A tie, or nothing matching at all,
 * returns null and the question goes to the person — which is the correct
 * outcome for the case this cannot decide: the same sentence twice inside one
 * band, where the context genuinely is identical.
 */
function narrowByContext(
  hits: Hit[],
  sources: Map<string, string>,
  root: string,
  request: EditRequest
): Hit | null {
  const before = normalize(request.before ?? "");
  const after = normalize(request.after ?? "");
  if (!before && !after) return null;

  const scores = hits.map((hit) => {
    const source = sources.get(hit.site.file);
    if (!source) return 0;
    const at = offsetOf(hit);
    const lead = normalize(source.slice(Math.max(0, at - 1200), at));
    const trail = normalize(source.slice(at, at + 1200));
    return neighbourScore(lead, before, "end") + neighbourScore(trail, after, "start");
  });

  let best = -1;
  let bestIndex = -1;
  let tied = false;
  scores.forEach((score, index) => {
    if (score > best) {
      best = score;
      bestIndex = index;
      tied = false;
    } else if (score === best) {
      tied = true;
    }
  });

  if (best <= 0 || tied || bestIndex < 0) return null;
  void root;
  return hits[bestIndex];
}

/**
 * How much of a neighbour survives in the window: the longest of a few
 * decreasing slices that is actually there. Longest-wins rather than
 * present/absent, so a candidate sharing eighty characters of context beats one
 * sharing twelve.
 */
function neighbourScore(window: string, neighbour: string, take: "start" | "end"): number {
  if (!window || !neighbour) return 0;
  for (const length of [80, 50, 30, 16]) {
    if (neighbour.length < length) continue;
    const slice =
      take === "end" ? neighbour.slice(-length) : neighbour.slice(0, length);
    if (window.includes(slice)) return length;
  }
  // A neighbour shorter than the smallest slice is still worth something.
  return neighbour.length >= 8 && window.includes(neighbour) ? neighbour.length : 0;
}

/* ----------------------------------------------------------------- entry */


/**
 * Rank a disambiguation list so the file most likely to be the one on screen
 * comes first: the route's own directory, then anything under a `content`
 * directory, then everything else alphabetically. A ranking is a courtesy —
 * every candidate is shown either way — so a project whose layout this does not
 * describe loses nothing but the ordering.
 */
function rankCandidates(candidates: Candidate[], pagePath?: string): Candidate[] {
  const prefix = sourcePrefix();
  const segments = (pagePath ?? "/")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  const score = (candidate: Candidate): number => {
    let value = 0;
    for (const segment of segments) {
      if (candidate.file.includes(`/${segment}/`) || candidate.file.includes(`/${segment}.`)) {
        value -= 10;
      }
    }
    if (candidate.file.startsWith(`${prefix}content/`)) value -= 3;
    if (candidate.file.startsWith(`${prefix}app/`)) value -= 2;
    return value;
  };
  return [...candidates].sort(
    (a, b) => score(a) - score(b) || a.file.localeCompare(b.file) || a.line - b.line
  );
}

/* --------------------------------------------------------------- writing */

/**
 * The exact range of a file a save is allowed to touch, and what goes in it.
 *
 * A markdown site is the whole file, so ITS span would authorize rewriting
 * every byte — and an assertion that the write left the rest of the file alone
 * would be vacuously true. The inner offsets are file offsets for markdown, so
 * the splice is taken from those instead, which makes a markdown save as narrow
 * as a TypeScript one and gives the assertion something real to check.
 */
type Splice = { start: number; end: number; replacement: string };

/** Throws `jsx-unsafe` by way of `site.encode`; the caller has words for it. */
function spliceFor(hit: Hit, newText: string): Splice {
  const { site, inner } = hit;
  if (site.kind === "markdown") {
    return { start: inner.start, end: inner.end, replacement: newText };
  }
  const nextValue =
    site.value.slice(0, inner.start) + newText + site.value.slice(inner.end);
  return {
    start: site.span.start,
    end: site.span.end,
    replacement: site.encode(nextValue),
  };
}

type WriteTarget = { hit: Hit; source: string } | { result: EditResult };

/**
 * Read the chosen file AGAIN, parse it again, and find the sentence in what is
 * there now. Everything a save writes comes from this read; nothing comes from
 * the sweep's.
 *
 * The three outcomes are the three things the file can have become. Still one
 * occurrence: write it. None: somebody changed that sentence between the page
 * loading and the button being pressed, so refuse and say so, because a save
 * here would be a guess at where the words went. More than one: the file gained
 * a copy, and the ordinary picker is the right answer to that — except in the
 * case where the count is unchanged, which is every ordinary save of a sentence
 * that legitimately appears twice, and where the occurrence the ladder settled
 * on is still the same one by position.
 */
async function resolveAtWriteTime(
  chosen: Hit,
  oldText: string,
  request: EditRequest,
  root: string,
  place: { ordinal: number; count: number }
): Promise<WriteTarget> {
  const file = chosen.site.file;
  const source = await fs.readFile(file, "utf8");

  let sites: Site[];
  try {
    sites = sitesIn(file, source);
  } catch (error) {
    return {
      result: {
        status: "error",
        message: `${path.relative(root, file)} does not parse as it now stands, so nothing was written. ${
          error instanceof Error ? error.message : String(error)
        }`,
        tone: "alarm",
      },
    };
  }

  const hits = hitsIn(sites, oldText);

  if (hits.length === 0) {
    return {
      result: {
        status: "none",
        message:
          "That sentence changed on disk since the page loaded — reload and retry. Nothing was written.",
        tone: "note",
      },
    };
  }
  if (hits.length === 1) return { hit: hits[0], source };

  if (place.ordinal >= 0 && hits.length === place.count) {
    return { hit: hits[place.ordinal], source };
  }

  const winner = narrowByContext(hits, new Map([[file, source]]), root, request);
  if (winner) return { hit: winner, source };

  return {
    result: {
      status: "multiple",
      candidates: rankCandidates(
        hits.map((one) => toCandidate(one, source, root)),
        request.pagePath
      ),
      tone: "question",
    },
  };
}

export async function editCopy(request: EditRequest): Promise<EditResult> {
  const oldText = normalize(request.oldText ?? "");
  const newText = normalize(request.newText ?? "");

  if (oldText.length < MIN_TEXT_LENGTH) {
    return {
      status: "error",
      message: `Too short to place. Inline editing needs at least ${MIN_TEXT_LENGTH} characters of the original text to find it in the source.`,
      tone: "note",
    };
  }
  if (!newText) {
    return {
      status: "error",
      message: "The replacement is empty. Deleting a whole run is a structural edit, and has to be made in the file.",
      tone: "note",
    };
  }
  if (oldText === newText) {
    return { status: "error", message: "Nothing changed.", tone: "note" };
  }

  // Loaded once, up front, so a compiler that will not load is a stated
  // failure rather than every .tsx file quietly skipping itself.
  try {
    compiler();
  } catch (error) {
    return {
      status: "error",
      message: `The TypeScript compiler could not be loaded, so no .ts or .tsx file can be searched. ${
        error instanceof Error ? error.message : String(error)
      }`,
      tone: "alarm",
    };
  }

  const root = projectRoot();
  const files: string[] = [];
  await collectFiles(srcRoot(), files);

  const sources = new Map<string, string>();
  const exactHits: Hit[] = [];
  const fragmentHits: Hit[] = [];

  // A cheap gate before parsing every file: the longest purely alphanumeric
  // word in the sentence. Such a word is never escaped and never wrapped, so a
  // file that lacks it verbatim cannot hold the sentence, whatever its shape.
  const probe = [...oldText.matchAll(/[A-Za-z0-9]{4,}/g)]
    .map((m) => m[0])
    .sort((a, b) => b.length - a.length)[0];

  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    if (probe && !source.includes(probe)) continue;
    sources.set(file, source);
    let sites: Site[];
    try {
      sites = sitesIn(file, source);
    } catch (error) {
      // A file that will not parse is skipped rather than guessed at — but say
      // so in the dev server's log, because a silent skip is how a tool starts
      // reporting "not found" for text that is plainly there.
      console.warn(`[edit-copy] skipped ${file}:`, error);
      continue;
    }
    for (const site of sites) {
      for (const hit of hitsInSite(site, oldText)) {
        (hit.exact ? exactHits : fragmentHits).push(hit);
      }
    }
  }

  // An exact whole-literal match is what almost every edit is, and it outranks
  // a sentence that merely occurs inside a longer literal somewhere else.
  let hits = exactHits.length ? exactHits : fragmentHits;
  // The unnarrowed set, kept because the write needs to know WHICH occurrence
  // in the file the ladder settled on, and every narrowing below replaces the
  // array rather than mutating it.
  const pool = hits;

  if (request.target) {
    if (!insideSrc(path.join(root, request.target.file))) {
      return {
        status: "error",
        message: `That file is outside ${sourceDirectoryLabel()}.`,
        tone: "alarm",
      };
    }
    hits = hits.filter((hit) => {
      const source = sources.get(hit.site.file)!;
      const candidate = toCandidate(hit, source, root);
      return (
        candidate.file === request.target!.file && candidate.line === request.target!.line
      );
    });
  }

  if (hits.length === 0) {
    return {
      status: "none",
      message:
        "That text isn't a single piece of copy in the source — it is assembled at render time, or split across markup. It has to be changed in the file.",
      tone: "note",
    };
  }

  let resolvedBy: ResolvedBy = request.target ? "picked" : "only-match";

  // THE LADDER. Two identical sentences are usually not a hard question, and
  // stopping to ask one mid-sentence reads as a fault. So the tool looks before
  // it asks, and only asks when looking genuinely cannot separate them.
  if (hits.length > 1 && !request.target) {
    const narrowed = narrowByPage(hits, request.pagePath);
    if (narrowed.length === 1) {
      hits = narrowed;
      resolvedBy = "import-graph";
    } else {
      const pool = narrowed.length > 1 ? narrowed : hits;
      const winner = narrowByContext(pool, sources, root, request);
      if (winner) {
        hits = [winner];
        resolvedBy = "context";
      } else {
        hits = pool;
      }
    }
  }

  if (hits.length > 1) {
    const candidates = rankCandidates(
      hits.map((hit) => toCandidate(hit, sources.get(hit.site.file)!, root)),
      request.pagePath
    );
    // The routes that mount each file: the hint a person can act on, where a
    // path and a line number are only the tool restating its own problem. It
    // costs a sweep of the app directory, which is fine — this is the rung the
    // ladder reaches least often.
    try {
      const mounts = routesMounting(
        compiler(),
        candidates.map((candidate) => path.join(root, candidate.file))
      );
      for (const candidate of candidates) {
        candidate.routes = mounts.get(path.join(root, candidate.file)) ?? [];
      }
    } catch {
      /* a hint is a courtesy; its absence must never stop the question */
    }
    return { status: "multiple", candidates, tone: "question" };
  }

  const hit = hits[0];
  if (!insideSrc(hit.site.file)) {
    return {
      status: "error",
      message: `Refusing to write outside ${sourceDirectoryLabel()}.`,
      tone: "alarm",
    };
  }

  // EVERYTHING BELOW THIS LINE WORKS FROM A FRESH READ. The sweep's buffers are
  // a search index and nothing more; see the note at the top of the file.
  const siblings = pool.filter((other) => other.site.file === hit.site.file);
  const settled = await resolveAtWriteTime(hit, oldText, request, root, {
    ordinal: siblings.indexOf(hit),
    count: siblings.length,
  });
  if ("result" in settled) return settled.result;

  const { hit: target, source: current } = settled;
  const candidate = toCandidate(target, current, root);

  let splice: Splice;
  try {
    splice = spliceFor(target, newText);
  } catch (error) {
    if (error instanceof Error && error.message === "jsx-unsafe") {
      return {
        status: "error",
        message: "Angle brackets and braces mean markup in JSX. That edit has to be made in the file.",
        tone: "note",
      };
    }
    throw error;
  }

  const updated =
    current.slice(0, splice.start) + splice.replacement + current.slice(splice.end);

  if (updated === current) {
    return { status: "error", message: "The file already reads that way.", tone: "note" };
  }

  // The write is a splice, and this is the proof rather than the intention.
  // Every byte outside the replaced span has to be the byte the fresh read
  // found there. It cannot fail as the code stands, since `updated` is cut from
  // `current` — it is here so that it WOULD fail if some later version printed a
  // whole node back or reached for an older buffer, which is precisely the
  // defect this path exists to make impossible.
  if (
    updated.slice(0, splice.start) !== current.slice(0, splice.start) ||
    updated.slice(splice.start + splice.replacement.length) !== current.slice(splice.end)
  ) {
    return {
      status: "error",
      message:
        "The save would have rewritten more of the file than the sentence it was asked to change, so nothing was written. That is a fault in this tool rather than anything you did.",
      tone: "alarm",
    };
  }

  await fs.writeFile(target.site.file, updated, "utf8");
  return { status: "saved", file: candidate.file, line: candidate.line, resolvedBy };
}
