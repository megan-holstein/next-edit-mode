/**
 * The three route handlers a host project mounts, as factories.
 *
 * WHAT IS LEFT HERE IS HTTP AND NOTHING ELSE: the dev-only gate, what counts as
 * a malformed request, and which status code a reply deserves. The behaviour
 * behind them lives in `engine.ts`, which an Electron host reaches over IPC
 * instead — one implementation, so a fix made for either host is made for both.
 *
 * THE DEV-ONLY GUARANTEE IS THE HOST'S, NOT THIS FILE'S. Each factory returns
 * handlers that check NODE_ENV first and answer 404 otherwise, and load the
 * engine behind them only after that check — but the host's own route file
 * makes the same check before it ever calls these, so the guarantee does not
 * depend on a tool one directory away being right. Two independent checks, and
 * neither is load-bearing alone.
 *
 * Every handler takes and returns a plain `Request`/`Response`, so nothing here
 * imports from `next/server` and the tool has no framework dependency at all.
 */
import type { ErrorReply } from "./engine";

const notFound = () => new Response(null, { status: 404 });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const inDevelopment = () => process.env.NODE_ENV === "development";

/**
 * A reply the engine caught a failure for, as against one it decided on. The
 * engine attaches its payload — the pending list, or the plan — to every reply
 * it reasoned its way to, including a refusal; a caught failure has neither. So
 * the presence of the payload is the difference between 200 and 500, and no
 * second channel is needed to carry it.
 */
function isFailure(reply: object): reply is ErrorReply {
  return (
    "status" in reply &&
    (reply as ErrorReply).status === "error" &&
    !("pending" in reply) &&
    !("plan" in reply)
  );
}

const served = (reply: object) => json(reply, isFailure(reply) ? 500 : 200);

export type RouteHandlers = {
  GET: (request?: Request) => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
};

/**
 * `POST` searches the host's `src/` for the text the browser sent and rewrites
 * it; `GET` is 404, because there is nothing here to read.
 */
export function createEditCopyRoute(): RouteHandlers {
  return {
    async GET() {
      return notFound();
    },
    async POST(request: Request) {
      if (!inDevelopment()) return notFound();

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ status: "error", message: "Malformed request.", tone: "alarm" }, 400);
      }

      const payload = body as {
        oldText?: unknown;
        newText?: unknown;
        pagePath?: unknown;
        before?: unknown;
        after?: unknown;
        target?: { file?: unknown; line?: unknown };
      };
      if (typeof payload.oldText !== "string" || typeof payload.newText !== "string") {
        return json({ status: "error", message: "Malformed request.", tone: "alarm" }, 400);
      }

      const target =
        payload.target &&
        typeof payload.target.file === "string" &&
        typeof payload.target.line === "number"
          ? { file: payload.target.file, line: payload.target.line }
          : undefined;

      const { handleEdit } = await import("./engine");
      return served(
        await handleEdit({
          oldText: payload.oldText,
          newText: payload.newText,
          pagePath: typeof payload.pagePath === "string" ? payload.pagePath : undefined,
          before: typeof payload.before === "string" ? payload.before : undefined,
          after: typeof payload.after === "string" ? payload.after : undefined,
          target,
        })
      );
    },
  };
}

/**
 * `GET` reports what is waiting to be saved, which is what puts the counts on
 * the Save and Cancel buttons; `POST` commits and pushes it.
 */
export function createCommitCopyRoute(): RouteHandlers {
  return {
    async GET() {
      if (!inDevelopment()) return notFound();
      const { handlePending } = await import("./engine");
      return served(await handlePending());
    },
    async POST() {
      if (!inDevelopment()) return notFound();
      const { handleCommit } = await import("./engine");
      return served(await handleCommit());
    },
  };
}

/**
 * `GET ?page=/x` reports what Cancel would throw away on that page — including
 * the two things a person should see before destroying typed work: other pages
 * whose edits ride along in a shared file, and any file somebody has staged.
 * `POST` does it.
 */
export function createRevertCopyRoute(): RouteHandlers {
  return {
    async GET(request?: Request) {
      if (!inDevelopment()) return notFound();
      const page = request ? new URL(request.url).searchParams.get("page") : null;
      if (!page) return json({ status: "error", message: "No page given.", tone: "alarm" }, 400);
      const { handleRevertPlan } = await import("./engine");
      return served(await handleRevertPlan(page));
    },
    async POST(request: Request) {
      if (!inDevelopment()) return notFound();
      let page: unknown;
      try {
        page = ((await request.json()) as { pagePath?: unknown }).pagePath;
      } catch {
        page = null;
      }
      if (typeof page !== "string" || !page) {
        return json({ status: "error", message: "No page given.", tone: "alarm" }, 400);
      }
      const { handleRevert } = await import("./engine");
      return served(await handleRevert(page));
    },
  };
}
