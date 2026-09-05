/**
 * The small amount of git this tool needs, and the containment rule every other
 * module derives from.
 *
 * Kept separate so `copy-source.ts` (which parses TypeScript) and `commit.ts`
 * (which runs git) can share them without importing each other.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { projectRoot, sourceDirectory } from "./config";

export { projectRoot };

/** The only directory this tool will ever read from or write to. */
export function srcRoot(): string {
  return sourceDirectory();
}

/** Guard against any path that tries to climb out of the source directory. */
export function insideSrc(candidateFile: string): boolean {
  const root = srcRoot();
  const resolved = path.resolve(candidateFile);
  return resolved === root || resolved.startsWith(root + path.sep);
}

export type GitResult = { code: number; stdout: string; stderr: string };

/**
 * The two things a caller occasionally needs beyond arguments. Both exist for
 * the commit path: `env` carries `GIT_INDEX_FILE`, which is what lets a commit
 * be assembled without touching the index anybody else is using, and `stdin`
 * feeds `hash-object --stdin` the rebuilt content of a file that was never
 * written to disk in that form.
 */
export type GitOptions = {
  /** Added to the inherited environment for this one command. */
  env?: Record<string, string>;
  /** Written to the command's standard input, which is then closed. */
  stdin?: string;
};

/**
 * Run git in the host project. Never throws: a failed command is a result with
 * a code and the real stderr, because every caller here has something specific
 * to say about a failure and none of them want a stack trace instead.
 *
 * The callback form of `execFile` rather than the promisified one, because the
 * promise alone gives no way to reach the child's standard input, and one
 * command here has to be fed content that exists nowhere on disk.
 */
export function git(args: string[], options: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      {
        cwd: projectRoot(),
        maxBuffer: 8 * 1024 * 1024,
        // Nothing here may ever sit waiting on a credential prompt: a dev server
        // that hangs on `git push` looks to the browser exactly like a bug.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const failure = error as { code?: number | string; message?: string };
        resolve({
          code: typeof failure.code === "number" ? failure.code : 1,
          stdout: stdout ?? "",
          stderr: stderr || failure.message || "git failed",
        });
      }
    );
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  });
}

/** The first line of a git failure, which is the part worth showing a person. */
export function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).filter(Boolean)[0];
  return line ?? "no reason given";
}
