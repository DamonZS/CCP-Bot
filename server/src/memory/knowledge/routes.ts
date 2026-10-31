import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppVariables } from "../../auth/guards";
import { KnowledgeRefusedError, type KnowledgeStore } from "./store";

/**
 * The knowledge base's own two doors: import a document, search what is imported.
 *
 * They sit behind the same actor middleware as `/api/memory` and are mounted from the same store,
 * so a person's documents belong to the person `/api/memory` already answers for, and nothing here
 * can be reached by a request `/api/memory` would have refused.
 */
export function createKnowledgeRoutes(
  store: KnowledgeStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser, bodyLimit({ maxSize: 512_000 }));
  routes.onError((error, context) => {
    if (error instanceof KnowledgeRefusedError)
      return context.json({ error: error.message }, 400);
    console.error(
      JSON.stringify({
        type: "knowledge-route-error",
        error: error.name,
        context: { route: context.req.path },
        timestamp: new Date().toISOString(),
      }),
    );
    return context.json({ error: "Knowledge is unavailable. Try again." }, 503);
  });
  routes.post("/documents", async (context) =>
    context.json(await store.import(context.var.actor.id, await body(context.req.raw)), 201),
  );
  routes.get("/search", async (context) => {
    const query = context.req.query("q") ?? "";
    if (query.trim().length === 0)
      throw new KnowledgeRefusedError("Supply a query to search for.");
    const requested = Number(context.req.query("limit") ?? "");
    return context.json({
      results: await store.search(
        context.var.actor.id,
        query,
        Number.isFinite(requested) && requested > 0 ? requested : undefined,
      ),
    });
  });
  return routes;
}

async function body(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new KnowledgeRefusedError("Supply a document as JSON.");
  try {
    return await request.json();
  } catch {
    throw new KnowledgeRefusedError("The document could not be read.");
  }
}