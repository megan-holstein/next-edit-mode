/**
 * Which files a page is actually made of — the first and best way to tell two
 * identical sentences apart.
 *
 * WHY THIS EXISTS. The same words often live in two files: a validation message
 * in the account area and the same hint under a signup field, a heading and the
 * page metadata that repeats it. Asked to rewrite one, the tool used to stop and
 * ask which — and being asked "that sentence appears in two places, which one?"
 * in the middle of typing reads as a fault rather than a question. It usually is
 * not even a hard question: the browser knows which page it is on, and only one
 * of the two files is reachable from that page. So the answer is to look.
 *
 * WHAT IT DOES. It maps a route to its entry files — the `page` and every
 * `layout` above it, because a sentence in the nav is in a layout rather than in
 * the page — then walks imports from there: relative specifiers, every path
 * alias the project's own `tsconfig.json` declares, and dynamic `import()`.
 * What comes back is every source file that page could possibly render.
 *
 * WHAT IT DELIBERATELY CANNOT SEE, and why that is safe. Content read at runtime
 * with `fs` — markdown under a `content/` directory, say — is reached by no
 * import, so it is invisible here. That would be a bug if this filter were
 * trusted absolutely; it is not. A filter that removes EVERY candidate is
 * discarded and the ladder moves on, so the worst an unseeable file can do is
 * fail to narrow the field.
 *
 * A HOST WITH NO ROUTES GETS EMPTY ANSWERS RATHER THAN AN ERROR. Everything
 * here is written in terms of a Next.js `app/` tree, and an Electron app has
 * none: `entriesForPage` returns no entries and `routesMounting` maps every
 * file to no routes, because the directory walk that would find the pages
 * cannot read a directory that is not there. That is the right answer rather
 * than a tolerated one — the ladder discards a filter that removes every
 * candidate, so a host with no routes simply starts at rung two, and the picker
 * shows its candidates without route labels.
 *
 * Parsed specifiers are cached against each file's mtime, so the second question
 * of a session costs almost nothing while a file you just edited is re-read.
 */
import fs from "node:fs";
import path from "node:path";
import type * as TS from "typescript";
import { projectRoot } from "./config";
import { srcRoot } from "./git";

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const INDEXES = ["/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

type Cached = { mtimeMs: number; specifiers: string[] };
const specifierCache = new Map<string, Cached>();

/** Every module specifier `file` imports, static and dynamic alike. */
function specifiersOf(compiler: typeof TS, file: string): string[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return [];
  }
  const cached = specifierCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.specifiers;

  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const found: string[] = [];
  try {
    const sourceFile = compiler.createSourceFile(
      file,
      source,
      compiler.ScriptTarget.Latest,
      false,
      file.endsWith(".tsx") || file.endsWith(".jsx")
        ? compiler.ScriptKind.TSX
        : compiler.ScriptKind.TS
    );
    const visit = (node: TS.Node): void => {
      if (
        (compiler.isImportDeclaration(node) || compiler.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        compiler.isStringLiteral(node.moduleSpecifier)
      ) {
        found.push(node.moduleSpecifier.text);
      } else if (
        compiler.isCallExpression(node) &&
        node.expression.kind === compiler.SyntaxKind.ImportKeyword &&
        node.arguments.length > 0 &&
        compiler.isStringLiteral(node.arguments[0])
      ) {
        found.push((node.arguments[0] as TS.StringLiteral).text);
      }
      compiler.forEachChild(node, visit);
    };
    visit(sourceFile);
  } catch {
    /* an unparseable file simply contributes no edges */
  }

  specifierCache.set(file, { mtimeMs: stat.mtimeMs, specifiers: found });
  return found;
}

/* ----------------------------------------------------------- path aliases */

type Alias = { prefix: string; targets: string[] };
let aliasCache: Alias[] | null = null;

/**
 * Strip `//` and block comments from a JSON document without touching the
 * inside of a string, so a `tsconfig.json` written the way TypeScript allows
 * can be parsed by `JSON.parse`.
 */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") { inBlock = false; i += 1; }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") { out += next ?? ""; i += 1; }
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && next === "/") { inLine = true; i += 1; continue; }
    if (c === "/" && next === "*") { inBlock = true; i += 1; continue; }
    out += c;
  }
  // Trailing commas, which TypeScript also allows and JSON does not.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * The project's own path aliases, read from `tsconfig.json` (or `jsconfig.json`)
 * so this tool follows `@/components/x`, `~/lib/y` or whatever the project
 * actually uses rather than only the one spelling Next.js scaffolds.
 *
 * `extends` is not followed: a base config a directory away is more machinery
 * than this earns, and an alias it misses only means the import graph narrows
 * less well — never a wrong answer, because the filter is discarded when it
 * empties the field. The default is appended last, so `@/` keeps working in a
 * project that declares no paths at all.
 */
function aliases(): Alias[] {
  if (aliasCache) return aliasCache;
  const found: Alias[] = [];
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    let parsed: { compilerOptions?: { baseUrl?: string; paths?: Record<string, unknown> } };
    try {
      parsed = JSON.parse(
        stripJsonComments(fs.readFileSync(path.join(projectRoot(), name), "utf8"))
      );
    } catch {
      continue;
    }
    const base = path.resolve(projectRoot(), parsed.compilerOptions?.baseUrl ?? ".");
    for (const [pattern, targets] of Object.entries(parsed.compilerOptions?.paths ?? {})) {
      if (!Array.isArray(targets)) continue;
      const resolved = targets
        .filter((t): t is string => typeof t === "string")
        .map((t) => path.resolve(base, t.replace(/\*$/, "")));
      if (resolved.length) found.push({ prefix: pattern.replace(/\*$/, ""), targets: resolved });
    }
    break; // the first config present is the project's
  }
  found.push({ prefix: "@/", targets: [srcRoot()] });
  // Longest prefix first, so `@/components/` beats `@/` when both are declared.
  found.sort((a, b) => b.prefix.length - a.prefix.length);
  aliasCache = found;
  return found;
}

function firstExisting(base: string): string | null {
  for (const suffix of ["", ...EXTENSIONS, ...INDEXES]) {
    const candidate = base + suffix;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* not this one */
    }
  }
  return null;
}

/**
 * Resolve one specifier to a file, or null for anything that is not one of the
 * project's own — a package, or an alias no config declares.
 */
function resolveSpecifier(specifier: string, importer: string): string | null {
  if (specifier.startsWith(".")) {
    return firstExisting(path.resolve(path.dirname(importer), specifier));
  }
  for (const alias of aliases()) {
    if (!specifier.startsWith(alias.prefix)) continue;
    const rest = specifier.slice(alias.prefix.length);
    for (const target of alias.targets) {
      const hit = firstExisting(path.join(target, rest));
      if (hit) return hit;
    }
  }
  return null;
}

/** Every file reachable from `entries` by import. */
export function reachableFrom(compiler: typeof TS, entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of specifiersOf(compiler, file)) {
      const resolved = resolveSpecifier(specifier, file);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

/* ------------------------------------------------------------------ routes */

/** `src/app/(marketing)/blog/[slug]/page.tsx` → `/blog/[slug]`. */
function routeOf(pageFile: string): string {
  const relative = path.relative(path.join(srcRoot(), "app"), path.dirname(pageFile));
  const segments = relative
    .split(path.sep)
    .filter(Boolean)
    // Route groups are organisational and contribute no URL segment.
    .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")));
  return "/" + segments.join("/");
}

function listPages(): string[] {
  const appRoot = path.join(srcRoot(), "app");
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^page\.(tsx|ts|jsx|js)$/.test(entry.name)) out.push(full);
    }
  };
  walk(appRoot);
  return out;
}

/** Does a route pattern, possibly carrying `[slug]`, describe this path? */
function routeMatches(pattern: string, pagePath: string): boolean {
  const a = pattern.split("/").filter(Boolean);
  const b = pagePath.split("/").filter(Boolean);
  if (a.length !== b.length) return false;
  return a.every((segment, index) => segment.startsWith("[") || segment === b[index]);
}

/**
 * The page file for a route, plus every layout above it — a sentence in the nav
 * belongs to a layout, and a filter that forgot them would throw the right
 * answer away.
 */
export function entriesForPage(pagePath: string): string[] {
  const pages = listPages();
  const exact = pages.find((file) => routeOf(file) === pagePath);
  const page = exact ?? pages.find((file) => routeMatches(routeOf(file), pagePath));
  if (!page) return [];

  const entries = [page];
  let dir = path.dirname(page);
  const appRoot = path.join(srcRoot(), "app");
  for (;;) {
    for (const name of ["layout.tsx", "layout.ts", "layout.jsx", "layout.js"]) {
      const layout = path.join(dir, name);
      try {
        if (fs.statSync(layout).isFile()) entries.push(layout);
      } catch {
        /* no layout at this level */
      }
    }
    if (path.resolve(dir) === path.resolve(appRoot)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return entries;
}

/**
 * Which routes mount a given file. Only used to write a human hint on the
 * picker, which is the rare case, so the whole-site sweep it needs is fine —
 * and it is cached the same way everything else here is.
 */
export function routesMounting(compiler: typeof TS, files: string[]): Map<string, string[]> {
  const answer = new Map<string, string[]>(files.map((file) => [file, []]));
  for (const page of listPages()) {
    const route = routeOf(page);
    const reachable = reachableFrom(compiler, entriesForPage(route));
    for (const file of files) {
      if (reachable.has(file)) answer.get(file)!.push(route);
    }
  }
  for (const [, routes] of answer) routes.sort();
  return answer;
}
