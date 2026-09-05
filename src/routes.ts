/**
 * The two route handlers a host project mounts, as factories.
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

const notFound = () => new Response(null, { status: 404 });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const inDevelopment = () => process.env.NODE_ENV === "development";

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

      try {
        const { editCopy } = await import("./copy-source");
        const { pendingEdits, recordEdit } = await import("./ledger");
        const result = await editCopy({
          oldText: payload.oldText,
          newText: payload.newText,
          pagePath: typeof payload.pagePath === "string" ? payload.pagePath : undefined,
          before: typeof payload.before === "string" ? payload.before : undefined,
          after: typeof payload.after === "string" ? payload.after : undefined,
          target,
        });
        if (result.status === "saved") {
          // The substitution goes into the ledger with the file, because the
          // commit is rebuilt from these rather than from the working tree.
          await recordEdit(
            result.file,
            typeof payload.pagePath === "string" ? payload.pagePath : undefined,
            { removed: result.removed, replacement: result.replacement }
          );
        }
        return json({ ...result, pending: await pendingEdits() });
      } catch (error) {
        return json(
          {
            status: "error",
            message: error instanceof Error ? error.message : "The save failed.",
            tone: "alarm",
          },
          500
        );
      }
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
      try {
        const { pendingEdits } = await import("./ledger");
        return json({ pending: await pendingEdits() });
      } catch (error) {
        return json(
          {
            status: "error",
            message: error instanceof Error ? error.message : "Could not read the ledger.",
            tone: "alarm",
          },
          500
        );
      }
    },
    async POST() {
      if (!inDevelopment()) return notFound();
      try {
        const { commitEdits } = await import("./commit");
        const { pendingEdits } = await import("./ledger");
        const result = await commitEdits();
        return json({ ...result, pending: await pendingEdits() });
      } catch (error) {
        return json(
          {
            status: "error",
            message: error instanceof Error ? error.message : "The commit failed.",
            tone: "alarm",
          },
          500
        );
      }
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
      try {
        const { planRevert } = await import("./revert");
        return json({ plan: await planRevert(page) });
      } catch (error) {
        return json(
          {
            status: "error",
            message: error instanceof Error ? error.message : "Could not read the ledger.",
            tone: "alarm",
          },
          500
        );
      }
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
      try {
        const { revertPage } = await import("./revert");
        const { pendingEdits } = await import("./ledger");
        const result = await revertPage(page);
        return json({ ...result, pending: await pendingEdits() });
      } catch (error) {
        return json(
          {
            status: "error",
            message: error instanceof Error ? error.message : "The revert failed.",
            tone: "alarm",
          },
          500
        );
      }
    },
  };
}
