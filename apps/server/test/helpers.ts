import { FastifyInstance } from "fastify";
import { AuditLog } from "../src/audit.js";
import { buildApp } from "../src/http.js";
import { MockInsight } from "../src/adapters/insight.js";
import { MockTranscriber } from "../src/adapters/transcriber.js";
import { createDb, Db, seedUsers } from "../src/store.js";

export interface Ctx {
  app: FastifyInstance;
  db: Db;
  audit: AuditLog;
}

export function makeCtx(): Ctx {
  const db = createDb();
  seedUsers(db);
  const audit = new AuditLog();
  const app = buildApp({ db, audit, transcriber: new MockTranscriber(), insight: new MockInsight() });
  return { app, db, audit };
}

export async function login(ctx: Ctx, email: string): Promise<string> {
  const res = await ctx.app.inject({ method: "POST", url: "/auth/dev-login", payload: { email } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
  return res.json().token as string;
}

export function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** Create a meeting, satisfy consent, record one chunk, stop, and wait ready. */
export async function recordMeeting(
  ctx: Ctx,
  token: string,
  opts: { attendees?: string[]; title?: string } = {},
): Promise<string> {
  const create = await ctx.app.inject({
    method: "POST",
    url: "/meetings",
    headers: auth(token),
    payload: { mode: "virtual_desktop", title: opts.title, attendeeUserIds: opts.attendees ?? ["u_priya", "u_omar"] },
  });
  const id = create.json().meeting.id as string;
  await ctx.app.inject({
    method: "POST",
    url: `/meetings/${id}/consent`,
    headers: auth(token),
    payload: { mechanism: "verbal_announcement_attested" },
  });
  await ctx.app.inject({ method: "POST", url: `/meetings/${id}/start`, headers: auth(token) });
  await ctx.app.inject({
    method: "POST",
    url: `/meetings/${id}/chunks`,
    headers: auth(token),
    payload: { seq: 0, dataBase64: Buffer.from("audio").toString("base64") },
  });
  await ctx.app.inject({ method: "POST", url: `/meetings/${id}/stop`, headers: auth(token) });
  for (let i = 0; i < 100; i++) {
    const m = await ctx.app.inject({ method: "GET", url: `/meetings/${id}`, headers: auth(token) });
    if (m.json().meeting.status === "ready") return id;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("meeting never became ready");
}
