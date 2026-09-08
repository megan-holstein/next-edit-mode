/**
 * Everything about this tool a project might reasonably want to set, in one
 * place, read from whichever channel the host actually has.
 *
 * THERE ARE TWO KINDS OF HOST, and they are told apart by whether the host owns
 * its own process. A Next.js dev server does not: the tool runs inside somebody
 * else's server, and the only thing guaranteed to reach it there is
 * `process.env`. So the environment is that host's channel, and a config file
 * would need a resolution order, a watcher, and a schema for five values that
 * most projects never change. Anything set that way belongs in the project's
 * own `.env.local`, which the framework already gitignores, so one developer's
 * preference never lands in a shared repository.
 *
 * An EMBEDDING HOST — an Electron main process, say — does own its process, and
 * knows at startup where the checkout is, because it is the checkout it runs
 * from. Such a host calls `configure()` once and passes the values in code
 * rather than arranging for environment variables to exist before this module
 * is first read. `process.cwd()` is no answer there either: a launched
 * application runs from wherever it was launched, which is not the project
 * root.
 *
 * The order is therefore what the host configured, then the environment, then a
 * default that suits an ordinary Next.js project. A host that never calls
 * `configure()` behaves exactly as it did before this existed.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * What an embedding host sets in code. Only `projectRoot` is required, because
 * it is the one value nothing can derive once `process.cwd()` has stopped being
 * the project: git runs there, and every other path here hangs off it.
 */
export type EngineOptions = {
  /** Absolute path to the checkout. Git runs here; every path derives from it. */
  projectRoot: string;
  /** Absolute, or relative to `projectRoot`. Defaults as the environment does. */
  sourceDirectory?: string;
  /** Absolute, or relative to `projectRoot`. Defaults as the environment does. */
  ledgerPath?: string;
  /** Whether Save pushes after it commits. Default true. */
  push?: boolean;
  /** The subject line of the commit Save makes. */
  commitSubject?: string;
};

/**
 * Set once by an embedding host, before anything else here is called. Held as
 * one object rather than as five variables, so that `configure()` replaces the
 * settings wholesale and a host cannot half-configure the tool by calling it
 * twice.
 */
let configured: EngineOptions | null = null;

/**
 * Take the host's settings. Call it once, at startup, before the first edit is
 * served. Every getter below reads it afresh, so a later call replaces what an
 * earlier one set rather than merging with it.
 */
export function configure(options: EngineOptions): void {
  configured = { ...options };
}

/** The host project this tool is mounted in. Everything is derived from it. */
export function projectRoot(): string {
  if (configured) return path.resolve(configured.projectRoot);
  return process.cwd();
}

/**
 * The one directory this tool reads from and writes to. `configure()` sets it
 * explicitly, then `EDIT_MODE_SRC` does; otherwise it is `src` in a project
 * that has one, and the project root in a project that keeps `app/` at the top
 * level. Both layouts are ordinary Next.js and this tool serves either.
 *
 * It is a containment boundary as well as a search root: nothing outside it is
 * ever read or written, which is what makes "it cannot touch your config, your
 * scripts or your lockfile" a property of the code rather than a promise.
 */
export function sourceDirectory(): string {
  const set = configured?.sourceDirectory?.trim();
  if (set) return path.resolve(projectRoot(), set);
  const fromEnvironment = process.env.EDIT_MODE_SRC?.trim();
  if (fromEnvironment) return path.resolve(projectRoot(), fromEnvironment);
  const src = path.join(projectRoot(), "src");
  try {
    if (fs.statSync(src).isDirectory()) return src;
  } catch {
    /* no src/ — this project keeps app/ at the root */
  }
  return projectRoot();
}

/**
 * Whether Save pushes after it commits.
 *
 * Pushing is the default, because an unpushed commit is an unbacked-up commit
 * and the button's whole promise is that the words are safe. `push: false`, or
 * `EDIT_MODE_PUSH=never`, commits and stops, which is the right setting on a
 * branch that is not meant to leave the machine, or where a push triggers a
 * deployment.
 */
export function pushAfterCommit(): boolean {
  if (configured && configured.push !== undefined) return configured.push;
  return (process.env.EDIT_MODE_PUSH ?? "auto").trim().toLowerCase() !== "never";
}

/** The subject line of the commit Save makes. */
export function commitSubject(): string {
  return (
    configured?.commitSubject?.trim() ||
    process.env.EDIT_MODE_COMMIT_SUBJECT?.trim() ||
    "Copy: edited in place from the browser"
  );
}

/**
 * Where the ledger of uncommitted edits is kept. `.next/cache/` by default:
 * gitignored in every Next.js project by the framework's own convention,
 * survives a dev-server restart, and is thrown away by the same `rm -rf .next`
 * that throws away everything else derived. A host with no `.next` — an
 * Electron app, say — names its own path through `configure()`, somewhere its
 * repository already ignores.
 */
export function ledgerPath(): string {
  const set = configured?.ledgerPath?.trim();
  if (set) return path.resolve(projectRoot(), set);
  const fromEnvironment = process.env.EDIT_MODE_LEDGER?.trim();
  if (fromEnvironment) return path.resolve(projectRoot(), fromEnvironment);
  return path.join(projectRoot(), ".next", "cache", "edit-mode-ledger.json");
}

/**
 * The source directory as it should be NAMED to a person — `src/` in the usual
 * layout, `the project root` where `app/` sits at the top level. Only ever used
 * in messages; every decision is made against the resolved path above.
 */
export function sourceDirectoryLabel(): string {
  const relative = path.relative(projectRoot(), sourceDirectory());
  return relative ? `${relative}/` : "the project root";
}

/** The source directory as a path prefix, relative to the project root. */
export function sourcePrefix(): string {
  const relative = path.relative(projectRoot(), sourceDirectory());
  return relative ? `${relative}/` : "";
}
