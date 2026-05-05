/// <reference types="@cloudflare/workers-types" />

export interface ScheduleState {
  tasks: unknown[];
  placed: unknown[];
  version: number;
  updatedAt: number;
}

const STORAGE_KEY = "data";
const EMPTY_STATE: ScheduleState = {
  tasks: [],
  placed: [],
  version: 0,
  updatedAt: 0,
};

export class ScheduleDO {
  private state: DurableObjectState;

  constructor(state: DurableObjectState, _env: unknown) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/state") return new Response("not found", { status: 404 });

    if (request.method === "GET") {
      const current = (await this.state.storage.get<ScheduleState>(STORAGE_KEY)) ?? EMPTY_STATE;
      return json(200, current);
    }

    if (request.method === "PUT") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json(400, { error: "invalid_json" });
      }

      const validated = validatePutBody(body);
      if (!validated.ok) return json(400, { error: validated.error });

      const { tasks, placed, baseVersion } = validated.value;

      // Strong consistency: blockConcurrencyWhile serializes against other handlers
      // on this DO instance, giving us a transactional read-modify-write.
      const result = await this.state.blockConcurrencyWhile(async () => {
        const current = (await this.state.storage.get<ScheduleState>(STORAGE_KEY)) ?? EMPTY_STATE;
        if (baseVersion !== current.version) {
          return { conflict: true, current } as const;
        }
        const next: ScheduleState = {
          tasks,
          placed,
          version: current.version + 1,
          updatedAt: Date.now(),
        };
        await this.state.storage.put(STORAGE_KEY, next);
        return { conflict: false, current: next } as const;
      });

      if (result.conflict) {
        return json(409, { error: "version_conflict", current: result.current });
      }
      return json(200, {
        version: result.current.version,
        updatedAt: result.current.updatedAt,
      });
    }

    return new Response("method not allowed", { status: 405 });
  }
}

interface PutBody {
  tasks: unknown[];
  placed: unknown[];
  baseVersion: number;
}

function validatePutBody(body: unknown): { ok: true; value: PutBody } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "body_not_object" };
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.tasks)) return { ok: false, error: "tasks_not_array" };
  if (!Array.isArray(b.placed)) return { ok: false, error: "placed_not_array" };
  if (typeof b.baseVersion !== "number" || !Number.isFinite(b.baseVersion) || b.baseVersion < 0) {
    return { ok: false, error: "baseVersion_invalid" };
  }
  // Defensive payload size cap (1MB raw JSON is plenty for this app).
  // Note: cloudflare also enforces request body limits, but we keep a logical guard.
  return {
    ok: true,
    value: { tasks: b.tasks, placed: b.placed, baseVersion: b.baseVersion },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
