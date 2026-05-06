/// <reference types="@cloudflare/workers-types" />

import { sendPush, type PushSubscriptionLike, type VapidKeys } from "./web-push";

interface PlacedTask {
  id: number;
  name: string;
  color?: string;
  startH: number;
  duration: number;
  done?: boolean;
}

export interface PushSubscriptionRecord extends PushSubscriptionLike {
  updatedAt: number;
}

export interface ScheduleState {
  tasks: unknown[];
  placed: unknown[];
  version: number;
  updatedAt: number;
  pushSubscription: PushSubscriptionRecord | null;
  notifiedToday: { date: string; ids: number[] };
}

interface DoEnv {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

const STORAGE_KEY = "data";

function emptyState(): ScheduleState {
  return {
    tasks: [],
    placed: [],
    version: 0,
    updatedAt: 0,
    pushSubscription: null,
    notifiedToday: { date: "", ids: [] },
  };
}

// Forward-fill any missing fields on legacy stored states.
function hydrate(raw: Partial<ScheduleState> | undefined): ScheduleState {
  const e = emptyState();
  if (!raw) return e;
  return {
    tasks: Array.isArray(raw.tasks) ? raw.tasks : e.tasks,
    placed: Array.isArray(raw.placed) ? raw.placed : e.placed,
    version: typeof raw.version === "number" ? raw.version : e.version,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : e.updatedAt,
    pushSubscription: raw.pushSubscription ?? e.pushSubscription,
    notifiedToday: raw.notifiedToday && typeof raw.notifiedToday.date === "string" && Array.isArray(raw.notifiedToday.ids)
      ? raw.notifiedToday
      : e.notifiedToday,
  };
}

// Public projection — never expose push subscription / notification bookkeeping to the client.
function publicView(s: ScheduleState): { tasks: unknown[]; placed: unknown[]; version: number; updatedAt: number } {
  return { tasks: s.tasks, placed: s.placed, version: s.version, updatedAt: s.updatedAt };
}

export class ScheduleDO {
  private state: DurableObjectState;
  private env: DoEnv;

  constructor(state: DurableObjectState, env: DoEnv) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/state") return this.handleState(request);
    if (path === "/push/subscribe") return this.handleSubscribe(request);
    if (path === "/tick-notifications") return this.handleTick(request);

    return new Response("not found", { status: 404 });
  }

  private async handleState(request: Request): Promise<Response> {
    if (request.method === "GET") {
      const s = hydrate(await this.state.storage.get<ScheduleState>(STORAGE_KEY));
      return json(200, publicView(s));
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
      const result = await this.state.blockConcurrencyWhile(async () => {
        const current = hydrate(await this.state.storage.get<ScheduleState>(STORAGE_KEY));
        if (baseVersion !== current.version) {
          return { conflict: true, current } as const;
        }
        const next: ScheduleState = {
          ...current,
          tasks,
          placed,
          version: current.version + 1,
          updatedAt: Date.now(),
        };
        await this.state.storage.put(STORAGE_KEY, next);
        return { conflict: false, current: next } as const;
      });

      if (result.conflict) {
        return json(409, { error: "version_conflict", current: publicView(result.current) });
      }
      return json(200, { version: result.current.version, updatedAt: result.current.updatedAt });
    }

    return new Response("method not allowed", { status: 405 });
  }

  private async handleSubscribe(request: Request): Promise<Response> {
    if (request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json(400, { error: "invalid_json" });
      }
      const sub = validateSubscriptionBody(body);
      if (!sub.ok) return json(400, { error: sub.error });

      await this.state.blockConcurrencyWhile(async () => {
        const current = hydrate(await this.state.storage.get<ScheduleState>(STORAGE_KEY));
        const next: ScheduleState = {
          ...current,
          pushSubscription: { ...sub.value, updatedAt: Date.now() },
        };
        await this.state.storage.put(STORAGE_KEY, next);
      });
      return json(200, { ok: true });
    }

    if (request.method === "DELETE") {
      await this.state.blockConcurrencyWhile(async () => {
        const current = hydrate(await this.state.storage.get<ScheduleState>(STORAGE_KEY));
        if (!current.pushSubscription) return;
        const next: ScheduleState = { ...current, pushSubscription: null };
        await this.state.storage.put(STORAGE_KEY, next);
      });
      return json(200, { ok: true });
    }

    return new Response("method not allowed", { status: 405 });
  }

  private async handleTick(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

    const vapid = readVapid(this.env);
    if (!vapid) return json(200, { ok: true, skipped: "vapid_not_configured" });

    // Snapshot under lock (we want internally consistent decisions; sending happens outside the lock).
    const snapshot = await this.state.blockConcurrencyWhile(async () => {
      return hydrate(await this.state.storage.get<ScheduleState>(STORAGE_KEY));
    });

    if (!snapshot.pushSubscription) return json(200, { ok: true, skipped: "no_subscription" });

    const { dateStr: today, decimalHours: nowH } = jstNow();
    const placed = snapshot.placed.filter(isPlacedTask);

    const alreadyNotified = snapshot.notifiedToday.date === today
      ? new Set(snapshot.notifiedToday.ids)
      : new Set<number>();

    const due: PlacedTask[] = [];
    for (const t of placed) {
      if (t.done) continue;
      if (alreadyNotified.has(t.id)) continue;
      const endH = t.startH + t.duration;
      const triggerH = endH - 1 / 60;  // 1 minute before end
      const deltaSec = (triggerH - nowH) * 3600;
      if (Math.abs(deltaSec) <= 30) due.push(t);
    }

    if (due.length === 0) {
      // Still ensure the date stamp rolls over even when nothing is due.
      if (snapshot.notifiedToday.date !== today) {
        await this.state.blockConcurrencyWhile(async () => {
          const cur = hydrate(await this.state.storage.get<ScheduleState>(STORAGE_KEY));
          const next: ScheduleState = { ...cur, notifiedToday: { date: today, ids: [] } };
          await this.state.storage.put(STORAGE_KEY, next);
        });
      }
      return json(200, { ok: true, sent: 0 });
    }

    let expired = false;
    let sent = 0;
    for (const t of due) {
      const payload = {
        title: `あと1分で「${t.name}」がおわるよ`,
        body: "もうすぐ つぎの じかんだよ",
        tag: `task-${t.id}`,
      };
      try {
        const r = await sendPush(snapshot.pushSubscription, payload, vapid);
        if (r.expired) expired = true;
        if (r.ok) sent++;
        else console.warn("push failed", r.status, t.id);
      } catch (e) {
        console.warn("push threw", e);
      }
    }

    // Persist: mark notified, optionally clear expired sub. Re-read inside lock to avoid clobbering concurrent /state writes.
    await this.state.blockConcurrencyWhile(async () => {
      const cur = hydrate(await this.state.storage.get<ScheduleState>(STORAGE_KEY));
      const ids = cur.notifiedToday.date === today ? cur.notifiedToday.ids.slice() : [];
      for (const t of due) if (!ids.includes(t.id)) ids.push(t.id);
      const next: ScheduleState = {
        ...cur,
        notifiedToday: { date: today, ids },
        pushSubscription: expired ? null : cur.pushSubscription,
      };
      await this.state.storage.put(STORAGE_KEY, next);
    });

    return json(200, { ok: true, sent, expired });
  }
}

function readVapid(env: DoEnv): VapidKeys | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return null;
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT,
  };
}

function jstNow(): { dateStr: string; decimalHours: number } {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  const y = jst.getUTCFullYear();
  const m = jst.getUTCMonth() + 1;
  const d = jst.getUTCDate();
  const h = jst.getUTCHours();
  const mn = jst.getUTCMinutes();
  const sec = jst.getUTCSeconds();
  const dateStr = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { dateStr, decimalHours: h + mn / 60 + sec / 3600 };
}

function isPlacedTask(v: unknown): v is PlacedTask {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === "number"
    && typeof r.name === "string"
    && typeof r.startH === "number"
    && typeof r.duration === "number";
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
  return { ok: true, value: { tasks: b.tasks, placed: b.placed, baseVersion: b.baseVersion } };
}

function validateSubscriptionBody(body: unknown): { ok: true; value: PushSubscriptionLike } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "body_not_object" };
  const b = body as Record<string, unknown>;
  if (typeof b.endpoint !== "string" || !b.endpoint.startsWith("https://")) return { ok: false, error: "endpoint_invalid" };
  if (typeof b.keys !== "object" || b.keys === null) return { ok: false, error: "keys_missing" };
  const k = b.keys as Record<string, unknown>;
  if (typeof k.p256dh !== "string" || typeof k.auth !== "string") return { ok: false, error: "keys_invalid" };
  return { ok: true, value: { endpoint: b.endpoint, keys: { p256dh: k.p256dh, auth: k.auth } } };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
