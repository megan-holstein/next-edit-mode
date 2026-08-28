/**
 * The small amount of git this tool needs, and the containment rule every other
 * module derives from.
 *
 * Kept separate so `copy-source.ts` (which parses TypeScript) and `commit.ts`
 * (which runs git) can share them without importing each other.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { projectRoot, sourceDirectory } from "./config";

const run = promisify(execFile);

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
 * Run git in the host project. Never throws: a failed command is a result with
 * a code and the real stderr, because every caller here has something specific
 * to say about a failure and none of them want a stack trace instead.
 */
export async function git(args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await run("git", args, {
      cwd: projectRoot(),
      maxBuffer: 8 * 1024 * 1024,
      // Nothing here may ever sit waiting on a credential prompt: a dev server
      // that hangs on `git push` looks to the browser exactly like a bug.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr || failure.message || "git failed",
    };
  }
}

/** The first line of a git failure, which is the part worth showing a person. */
export function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).filter(Boolean)[0];
  return line ?? "no reason given";
}
