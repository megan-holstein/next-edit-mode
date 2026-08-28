/**
 * Everything about this tool a project might reasonably want to set, in one
 * place, read from the environment.
 *
 * WHY THE ENVIRONMENT AND NOT A CONFIG FILE. The tool runs inside somebody
 * else's dev server, and the only thing guaranteed to reach it there is
 * `process.env` — a config file would need a resolution order, a watcher, and a
 * schema, for four values that most projects never change. Anything set here
 * belongs in the project's own `.env.local`, which is already gitignored by the
 * framework's convention, so one developer's preference never lands in a shared
 * repository.
 *
 * Every value has a default that suits an ordinary Next.js project, so a
 * project that sets none of them works.
 */
import fs from "node:fs";
import path from "node:path";

/** The host project this tool is mounted in. Everything is derived from it. */
export function projectRoot(): string {
  return process.cwd();
}

/**
 * The one directory this tool reads from and writes to, relative to the project
 * root. `EDIT_MODE_SRC` sets it explicitly; otherwise it is `src` in a project
 * that has one, and the project root in a project that keeps `app/` at the top
 * level. Both layouts are ordinary Next.js and this tool serves either.
 *
 * It is a containment boundary as well as a search root: nothing outside it is
 * ever read or written, which is what makes "it cannot touch your config, your
 * scripts or your lockfile" a property of the code rather than a promise.
 */
export function sourceDirectory(): string {
  const configured = process.env.EDIT_MODE_SRC?.trim();
  if (configured) return path.resolve(projectRoot(), configured);
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
 * `auto` (the default) pushes, because an unpushed commit is an unbacked-up
 * commit and the button's whole promise is that the words are safe. `never`
 * commits and stops, which is the right setting on a branch that is not meant
 * to leave the machine, or where a push triggers a deployment.
 */
export function pushAfterCommit(): boolean {
  return (process.env.EDIT_MODE_PUSH ?? "auto").trim().toLowerCase() !== "never";
}

/** The subject line of the commit Save makes. */
export function commitSubject(): string {
  return process.env.EDIT_MODE_COMMIT_SUBJECT?.trim() || "Copy: edited in place from the browser";
}

/**
 * Where the ledger of uncommitted edits is kept. `.next/cache/` by default:
 * gitignored in every Next.js project by the framework's own convention,
 * survives a dev-server restart, and is thrown away by the same `rm -rf .next`
 * that throws away everything else derived.
 */
export function ledgerPath(): string {
  const configured = process.env.EDIT_MODE_LEDGER?.trim();
  if (configured) return path.resolve(projectRoot(), configured);
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
