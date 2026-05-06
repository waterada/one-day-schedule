/// <reference types="@cloudflare/workers-types" />

import { ScheduleDO } from "./schedule-do";
export { ScheduleDO };

interface Env {
  ASSETS: Fetcher;
  SCHEDULE_DO: DurableObjectNamespace;
  SHARED_SECRET: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
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

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const id = env.SCHEDULE_DO.idFromName(DO_NAME);
    const stub = env.SCHEDULE_DO.get(id);
    ctx.waitUntil(
      stub.fetch("https://do.local/tick-notifications", { method: "POST" })
        .catch((e) => console.warn("tick-notifications failed", e)),
    );
  },
} satisfies ExportedHandler<Env>;

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  // Public endpoint: VAPID public key (no Bearer required so the SW can fetch before auth flow).
  if (url.pathname === "/api/push/public-key" && request.method === "GET") {
    if (!env.VAPID_PUBLIC_KEY) return json(503, { error: "vapid_not_configured" });
    return json(200, { publicKey: env.VAPID_PUBLIC_KEY });
  }

  if (!env.SHARED_SECRET) {
    return json(500, { error: "secret_not_configured" });
  }

  const auth = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${env.SHARED_SECRET}`;
  if (!timingSafeEqual(auth, expected)) {
    return json(401, { error: "unauthorized" });
  }

  if (url.pathname === "/api/state") {
    return forwardToDo(request, env, "/state");
  }

  if (url.pathname === "/api/push/subscribe") {
    if (request.method !== "POST" && request.method !== "DELETE") {
      return json(405, { error: "method_not_allowed" });
    }
    return forwardToDo(request, env, "/push/subscribe");
  }

  return json(404, { error: "not_found" });
}

async function forwardToDo(request: Request, env: Env, doPath: string): Promise<Response> {
  const id = env.SCHEDULE_DO.idFromName(DO_NAME);
  const stub = env.SCHEDULE_DO.get(id);
  const init: RequestInit = {
    method: request.method,
    headers: { "content-type": "application/json" },
    body: request.method === "GET" || request.method === "HEAD" || request.method === "DELETE"
      ? undefined
      : await request.text(),
  };
  return stub.fetch(`https://do.local${doPath}`, init);
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
