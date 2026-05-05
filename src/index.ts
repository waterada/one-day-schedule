/// <reference types="@cloudflare/workers-types" />

import { ScheduleDO } from "./schedule-do";
export { ScheduleDO };

interface Env {
  ASSETS: Fetcher;
  SCHEDULE_DO: DurableObjectNamespace;
  SHARED_SECRET: string;
}

const DO_NAME = "daughter";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.SHARED_SECRET) {
    return json(500, { error: "secret_not_configured" });
  }

  const auth = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${env.SHARED_SECRET}`;
  if (!timingSafeEqual(auth, expected)) {
    return json(401, { error: "unauthorized" });
  }

  if (url.pathname === "/api/state") {
    const id = env.SCHEDULE_DO.idFromName(DO_NAME);
    const stub = env.SCHEDULE_DO.get(id);
    // Forward to DO with a stable internal URL.
    const forwardUrl = new URL("https://do.local/state");
    return stub.fetch(forwardUrl.toString(), {
      method: request.method,
      headers: { "content-type": "application/json" },
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
    });
  }

  return json(404, { error: "not_found" });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
