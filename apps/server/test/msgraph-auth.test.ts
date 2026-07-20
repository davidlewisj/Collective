import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit.js";
import { buildApp } from "../src/http.js";
import { MockInsight } from "../src/adapters/insight.js";
import { MockTranscriber } from "../src/adapters/transcriber.js";
import { HttpJson, MsGraph } from "../src/msgraph.js";
import { createDb, seedUsers } from "../src/store.js";
import { auth } from "./helpers.js";

const CFG = {
  tenantId: "tenant-123",
  clientId: "client-abc",
  clientSecret: "s3cret",
  redirectUri: "http://localhost:4000/auth/callback",
};

function fakeIdToken(payload: Record<string, unknown>): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}

function fakeMsHttp(opts: { email: string; name: string; oid: string; calendarSubject?: string }): HttpJson {
  return async (url) => {
    if (url.includes("/oauth2/v2.0/token")) {
      return {
        status: 200,
        json: async () => ({
          id_token: fakeIdToken({
            iss: `https://login.microsoftonline.com/${CFG.tenantId}/v2.0`,
            aud: CFG.clientId,
            exp: Math.floor(Date.now() / 1000) + 3600,
            preferred_username: opts.email,
            name: opts.name,
            oid: opts.oid,
            amr: ["pwd", "mfa"],
          }),
          access_token: "graph-access-token",
          refresh_token: "graph-refresh-token",
          expires_in: 3600,
        }),
      };
    }
    if (url.includes("/me/calendarView")) {
      const now = Date.now();
      const iso = (ms: number) => new Date(ms).toISOString().replace("Z", "");
      return {
        status: 200,
        json: async () => ({
          value: opts.calendarSubject
            ? [
                {
                  subject: opts.calendarSubject,
                  isAllDay: false,
                  start: { dateTime: iso(now - 5 * 60000) },
                  end: { dateTime: iso(now + 25 * 60000) },
                  attendees: [{ emailAddress: { address: "PRIYA@collective.dev" } }],
                },
              ]
            : [],
        }),
      };
    }
    throw new Error(`unexpected url: ${url}`);
  };
}

function makeGraphCtx(opts: { email: string; name: string; oid: string; calendarSubject?: string }) {
  const db = createDb();
  seedUsers(db);
  const audit = new AuditLog();
  const graph = new MsGraph(CFG, fakeMsHttp(opts));
  const app = buildApp({
    db,
    audit,
    transcriber: new MockTranscriber(),
    insight: new MockInsight(),
    graph,
    webOrigin: "http://localhost:5173",
  });
  return { db, audit, app };
}

async function signInWithMicrosoft(app: ReturnType<typeof makeGraphCtx>["app"]): Promise<string> {
  const start = await app.inject({ method: "GET", url: "/auth/microsoft" });
  expect(start.statusCode).toBe(302);
  const state = new URL(start.headers.location as string).searchParams.get("state")!;
  const cb = await app.inject({ method: "GET", url: `/auth/callback?code=fake-code&state=${state}` });
  expect(cb.statusCode).toBe(302);
  const frag = String(cb.headers.location).split("#")[1] ?? "";
  const token = new URLSearchParams(frag).get("msToken");
  expect(token).toBeTruthy();
  return token!;
}

describe("Microsoft Entra sign-in (ID-1)", () => {
  it("builds a correct authorize URL", () => {
    const g = new MsGraph(CFG);
    const url = new URL(g.authorizeUrl("st4te"));
    expect(url.origin + url.pathname).toBe(
      `https://login.microsoftonline.com/${CFG.tenantId}/oauth2/v2.0/authorize`,
    );
    expect(url.searchParams.get("client_id")).toBe(CFG.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(CFG.redirectUri);
    expect(url.searchParams.get("state")).toBe("st4te");
    expect(url.searchParams.get("scope")).toContain("Calendars.Read");
  });

  it("auto-provisions unknown accounts as members and issues a working session", async () => {
    const ctx = makeGraphCtx({ email: "DLewis@tmj.example", name: "David Lewis", oid: "OID-1234-abcd" });
    const token = await signInWithMicrosoft(ctx.app);
    const me = (await ctx.app.inject({ method: "GET", url: "/me", headers: auth(token) })).json();
    expect(me.user.email).toBe("dlewis@tmj.example");
    expect(me.user.displayName).toBe("David Lewis");
    expect(me.user.role).toBe("member"); // least privilege on first sign-in
    expect(ctx.db.graphAuth.get(me.user.id)?.refreshToken).toBe("graph-refresh-token");
    expect(ctx.audit.query({}).some((e) => e.action === "session.login_microsoft" && e.detail?.includes("mfa"))).toBe(
      true,
    );
  });

  it("links a Microsoft account to an existing directory user by email", async () => {
    const ctx = makeGraphCtx({ email: "priya@collective.dev", name: "Priya N", oid: "oid-priya" });
    const token = await signInWithMicrosoft(ctx.app);
    const me = (await ctx.app.inject({ method: "GET", url: "/me", headers: auth(token) })).json();
    expect(me.user.id).toBe("u_priya"); // no duplicate account
  });

  it("rejects a forged or replayed state", async () => {
    const ctx = makeGraphCtx({ email: "a@b.co", name: "A", oid: "o" });
    const cb = await ctx.app.inject({ method: "GET", url: "/auth/callback?code=x&state=never-issued" });
    expect(cb.statusCode).toBe(302);
    expect(String(cb.headers.location)).toContain("msError=invalid_state");
  });

  it("names untitled captures from the Graph calendar and maps attendees", async () => {
    const ctx = makeGraphCtx({
      email: "dana@collective.dev",
      name: "Dana",
      oid: "oid-dana",
      calendarSubject: "Quarterly compliance review",
    });
    const token = await signInWithMicrosoft(ctx.app);
    const res = (
      await ctx.app.inject({
        method: "POST",
        url: "/meetings",
        headers: auth(token),
        payload: { mode: "virtual_desktop" },
      })
    ).json();
    expect(res.meeting.title).toBe("Quarterly compliance review");
    expect(res.meeting.namedFromCalendar).toBe(true);
    expect(res.meeting.attendeeUserIds).toContain("u_priya");
    expect(ctx.audit.query({}).some((e) => e.action === "meeting.named_from_calendar" && e.detail?.includes("via graph"))).toBe(true);
  });
});

describe("role management", () => {
  it("org_admin can promote a provisioned user; members cannot; self-change refused", async () => {
    const ctx = makeGraphCtx({ email: "new@person.example", name: "New Person", oid: "oid-new" });
    const msToken = await signInWithMicrosoft(ctx.app);
    const me = (await ctx.app.inject({ method: "GET", url: "/me", headers: auth(msToken) })).json();

    const dana = (
      await ctx.app.inject({ method: "POST", url: "/auth/dev-login", payload: { email: "dana@collective.dev" } })
    ).json().token as string;

    const denied = await ctx.app.inject({
      method: "PUT",
      url: `/admin/users/${me.user.id}/role`,
      headers: auth(msToken),
      payload: { role: "org_admin" },
    });
    expect(denied.statusCode).toBe(403);

    const self = await ctx.app.inject({
      method: "PUT",
      url: "/admin/users/u_dana/role",
      headers: auth(dana),
      payload: { role: "member" },
    });
    expect(self.statusCode).toBe(400);

    const ok = await ctx.app.inject({
      method: "PUT",
      url: `/admin/users/${me.user.id}/role`,
      headers: auth(dana),
      payload: { role: "org_admin" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.role).toBe("org_admin");
  });
});
