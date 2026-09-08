#!/usr/bin/env node
/**
 * Mount edit-mode in a Next.js project.
 *
 *   node path/to/edit-mode/install.mjs [project-dir] [--src <dir>]
 *
 * Run it again any time the tool changes; it is idempotent, and re-running it
 * is how a project picks up a new version.
 *
 * WHY IT COPIES RATHER THAN LINKS, since that is the first question. Turbopack
 * refuses to bundle anything outside the project root — a symlinked directory
 * is rejected outright ("points out of the filesystem root") and an absolute
 * `resolveAlias` target is read as a server-relative path and never found. Both
 * were tried. So the tool's source has to sit physically inside the project it
 * serves, and the copy lands in a gitignored `.edit-mode/` at the project root:
 * inside the root so the bundler will take it, outside the source directory so
 * the engine never searches its own source for the sentence it is looking for,
 * and gitignored so it is never committed to a project it is not part of.
 *
 * WHAT STAYS COMMITTED in the host is the pair of production stand-ins and the
 * three route files. That is the whole trick that keeps a deployment working:
 * the alias points at the real tool in development and at the stand-ins
 * otherwise, so a build on a machine that has never heard of this tool resolves
 * everything it needs from the repository it cloned.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------- arguments */
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`edit-mode installer

  install [project-dir] [--src <dir>]

  project-dir   the Next.js project to mount it in (default: the current directory)
  --src <dir>   the project's source directory, relative to the project root.
                Detected automatically: "src" where that directory exists,
                otherwise the project root. Whatever is chosen here must match
                EDIT_MODE_SRC if the project sets it.
`);
  process.exit(0);
}

const positional = argv.filter((a) => !a.startsWith("-"));
const srcFlagIndex = argv.indexOf("--src");
const project = path.resolve(positional[0] ?? process.cwd());

if (!fs.existsSync(path.join(project, "package.json"))) {
  console.error(`No package.json in ${project} — is that the project directory?`);
  process.exit(1);
}

/* The source directory, by the same rule the tool itself uses at runtime, so
   the installer and the engine can never disagree about where the code is. */
const isDirectory = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const srcRelative =
  srcFlagIndex !== -1 && argv[srcFlagIndex + 1]
    ? argv[srcFlagIndex + 1].replace(/^\.\//, "").replace(/\/$/, "")
    : isDirectory(path.join(project, "src"))
      ? "src"
      : ".";
const inSrc = (...parts) => path.join(project, srcRelative, ...parts);
const relative = (...parts) => path.posix.join(srcRelative === "." ? "" : srcRelative, ...parts);

if (!isDirectory(path.join(project, srcRelative))) {
  console.error(`No ${srcRelative}/ in ${project} — pass --src <dir> to say where the source is.`);
  process.exit(1);
}
if (!isDirectory(inSrc("app"))) {
  console.error(
    `No ${relative("app")}/ in ${project} — edit-mode needs the Next.js App Router.\n` +
      `If the source lives somewhere else, pass --src <dir>.`
  );
  process.exit(1);
}

console.log(`project ${project}`);
console.log(`source  ${srcRelative === "." ? "(project root)" : `${srcRelative}/`}`);

/* ---------------------------------------------- 1. the tool's own source */
const target = path.join(project, ".edit-mode");
fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(path.join(TOOL, "src"), target, { recursive: true });
console.log(`copied  .edit-mode/  (${fs.readdirSync(target).length} files)`);

/* ------------------------------------------------------------ 2. ignore */
const ignorePath = path.join(project, ".gitignore");
const ignore = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, "utf8") : "";
if (!/^\/?\.edit-mode\/?$/m.test(ignore)) {
  fs.writeFileSync(
    ignorePath,
    `${ignore.replace(/\s*$/, "")}\n\n# edit-mode (a development-only tool, installed with its install.mjs)\n/.edit-mode/\n`
  );
  console.log("added   /.edit-mode/ to .gitignore");
} else {
  console.log("ok      .gitignore already ignores /.edit-mode/");
}

/* --------------------------------------- 3. the production stand-ins */
const routeFile = (comment, factory) => `${comment}
import { ${factory} } from "#edit-mode/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = ${factory}();
export const GET = handlers.GET;
export const POST = handlers.POST;
`;

const stubs = {
  [relative("dev/edit-mode-absent.tsx")]: `"use client";

/**
 * The production stand-in for the edit-mode overlay, and the reason a build
 * works on a machine that does not have the tool. \`next.config.ts\` aliases
 * \`#edit-mode/overlay\` here whenever the tool is absent or the build is not a
 * development one, and \`tsconfig.json\` types the specifier against this file
 * always — so the type-checker never needs the tool either.
 */
export type EditModeProps = {
  transport?: unknown;
  page?: string;
  editEndpoint?: string;
  commitEndpoint?: string;
  revertEndpoint?: string;
};

/* The stand-in takes the real overlay's props so a host that passes them still
   type-checks against this file. It renders nothing either way. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function EditModeOverlay(_props: EditModeProps = {}) {
  return null;
}
`,
  [relative("dev/edit-mode-routes-absent.ts")]: `/**
 * The production stand-in for the edit-mode route factories: handlers that are
 * 404 and nothing else. See \`edit-mode-absent.tsx\` beside this file.
 */
const notFound = async () => new Response(null, { status: 404 });
const dead = () => ({ GET: notFound, POST: notFound });

export const createEditCopyRoute = dead;
export const createCommitCopyRoute = dead;
export const createRevertCopyRoute = dead;
`,
  [relative("app/api/dev/edit-copy/route.ts")]: routeFile(
    `/**
 * POST /api/dev/edit-copy — rewrite one run of copy in the source.
 *
 * IT DOES NOT EXIST IN PRODUCTION, and that is the whole of its access control.
 * There is no session and no token because there is no user to distinguish: the
 * factory answers 404 unless NODE_ENV is \`development\`, and outside development
 * the specifier below resolves to a stand-in that is 404 and nothing else — so
 * the code that could write a file is not in the build at all.
 */`,
    "createEditCopyRoute"
  ),
  [relative("app/api/dev/revert-copy/route.ts")]: routeFile(
    `/**
 * GET  /api/dev/revert-copy?page=/x — what Cancel would throw away on that page.
 * POST /api/dev/revert-copy — throw it away.
 *
 * Development only, by the same two mechanisms as the routes beside it.
 */`,
    "createRevertCopyRoute"
  ),
  [relative("app/api/dev/commit-copy/route.ts")]: routeFile(
    `/**
 * GET  /api/dev/commit-copy — what is waiting to be saved.
 * POST /api/dev/commit-copy — commit exactly those edits and push.
 *
 * Development only, by the same two mechanisms as the edit route beside it.
 */`,
    "createCommitCopyRoute"
  ),
};

/* These five are the tool's own boilerplate, not the project's, so they are
   REWRITTEN every run rather than preserved. That is what makes re-running the
   installer a real sync: a stand-in left behind at an older version is exactly
   how a project ends up mounting a route the tool no longer exports. Nothing
   here is a file anybody edits by hand — the wiring a project owns is in
   next.config.ts, tsconfig.json and the mount, and none of those are touched. */
for (const [rel, contents] of Object.entries(stubs)) {
  const file = path.join(project, rel);
  const existed = fs.existsSync(file);
  const changed = !existed || fs.readFileSync(file, "utf8") !== contents;
  if (!changed) {
    console.log(`ok      ${rel} up to date`);
    continue;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  console.log(`${existed ? "updated" : "wrote  "} ${rel}`);
}

/* The mount component is written ONCE and never overwritten, because it is the
   one file here a project has a reason to edit — it is where the endpoint props
   go if the routes are mounted somewhere other than /api/dev. */
const mountRelative = relative("components/dev/edit-mode.tsx");
const mountFile = path.join(project, mountRelative);
if (fs.existsSync(mountFile)) {
  console.log(`kept    ${mountRelative} (yours; not overwritten)`);
} else {
  fs.mkdirSync(path.dirname(mountFile), { recursive: true });
  fs.writeFileSync(
    mountFile,
    `"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";

/**
 * The mount point for inline copy editing, and the boundary that keeps it off
 * the deployed site.
 *
 * \`process.env.NODE_ENV\` is substituted with a literal at build time, so in a
 * production build this ternary is \`"production" === "development"\` — false,
 * constant, and resolvable by the bundler before it decides what to emit. The
 * \`import()\` sits in the dead arm, which is why the overlay is not merely
 * unrendered in production but absent from the output: no chunk, no component
 * name, no stylesheet. The check is structural rather than a runtime \`if\`,
 * because a runtime \`if\` would still ship the code it declines to run. And the
 * specifier resolves to a committed stand-in outside development anyway, so
 * neither half of the guarantee rests on the other.
 *
 * It is a CLIENT component, because it reads the current route with
 * \`usePathname\` and hands it to the overlay as \`page\`. That is what scopes
 * Cancel to the page you are on and keeps the counts on Save and Cancel right
 * after a click through the nav, which does not reload the document. Marking it
 * a client component costs the deployed site nothing: in a production build the
 * ternary above is constant, the import is dead, and this function returns null.
 */
const Overlay =
  process.env.NODE_ENV === "development"
    ? dynamic(() => import("#edit-mode/overlay").then((m) => m.EditModeOverlay))
    : null;

export function DevEditMode() {
  /* The page the overlay scopes Cancel to, and the value that makes the two
     counts follow a client navigation — which does not reload, so the address
     read once at mount would go stale the first time you click the nav. */
  const page = usePathname() ?? "/";
  if (!Overlay) return null;
  return <Overlay page={page} />;
}
`
  );
  console.log(`wrote   ${mountRelative}`);
}

/* ------------------------------------------------- 4. the three hand edits */
const overlayAbsent = `./${relative("dev/edit-mode-absent.tsx")}`;
const routesAbsent = `./${relative("dev/edit-mode-routes-absent.ts")}`;
/* The layout sits one level inside the source directory, so this relative path
   is right in both layouts. A project with an alias may prefer that spelling. */
const importPath = "../components/dev/edit-mode";

console.log(`
Three edits left, and they are the whole of the wiring.

1. next.config.ts — resolve the specifier to the tool in development, to the
   stand-ins otherwise:

     import fs from "node:fs";
     import path from "node:path";

     const editMode = (name: string, absent: string) => {
       const installed = path.join(process.cwd(), ".edit-mode", name);
       return process.env.NODE_ENV === "development" && fs.existsSync(installed)
         ? \`./.edit-mode/\${name}\`
         : absent;
     };

   and inside the config object:

     turbopack: {
       resolveAlias: {
         "#edit-mode/overlay": editMode("overlay.tsx", "${overlayAbsent}"),
         "#edit-mode/routes": editMode("routes.ts", "${routesAbsent}"),
       },
     },

2. tsconfig.json — type the specifier against the stand-ins, always, so the
   type-checker never needs the tool:

     "paths": {
       "#edit-mode/overlay": ["${overlayAbsent}"],
       "#edit-mode/routes": ["${routesAbsent}"]
     }

3. Render the mount at the end of <body> in ${relative("app/layout.tsx")}:

     import { DevEditMode } from "${importPath}";   // or your own alias
     ...
     <DevEditMode />

Restart the dev server once after the first install.`);
