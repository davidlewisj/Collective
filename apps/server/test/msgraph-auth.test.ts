import { generateKeyPairSync, createSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit.js";
import { buildApp } from "../src/http.js";
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

// A real RSA keypair stands in for the tenant's Entra signing key: tokens are
// signed with the private half, and the public half is served as JWKS — so the
// tests exercise the actual RS256 verification path, no live tenant needed.
const SIGNING = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-signing-key-1";
// A second, unrelated key: tokens signed with this must be rejected (its kid is
// not in the JWKS, and its signature won't match the published key either).
const IMPOSTOR = generateKeyPairSync("rsa", { modulusLength: 2048 });

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

function signIdToken(
  payload: Record<string, unknown>,
  opts: { key?: typeof SIGNING.privateKey; kid?: string; alg?: string } = {},
): string {
  const header = { alg: opts.alg ?? "RS256", typ: "JWT", kid: opts.kid ?? KID };
  const signingInput = `${b64(header)}.${b64(payload)}`;
  const sig = createSign("RSA-SHA256").update(signingInput).sign(opts.key ?? SIGNING.privateKey);
  return `${signingInput}.${sig.toString("base64url")}`;
}

function jwks() {
  const jwk = SIGNING.publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return { keys: [{ ...jwk, kid: KID, use: "sig", alg: "RS256" }] };
}

function validClaims(opts: { email: string; name: string; oid: string }) {
  return {
    iss: `https://login.microsoftonline.com/${CFG.tenantId}/v2.0`,
    aud: CFG.clientId,
    exp: Math.floor(Date.now() / 1000) + 3600,
    preferred_username: opts.email,
    name: opts.name,
    oid: opts.oid,
    amr: ["pwd", "mfa"],
  };
}

/** Fake Microsoft HTTP: serves JWKS, and a token response carrying `idToken`. */
function msHttpWith(idToken: string, opts: { calendarSubject?: string } = {}): HttpJson {
  return async (url) => {
    if (url.includes("/discovery/v2.0/keys")) {
      return { status: 200, json: async () => jwks() };
    }
    if (url.includes("/oauth2/v2.0/token")) {
      return {
        status: 200,
        json: async () => ({
          id_token: idToken,
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
  const idToken = signIdToken(validClaims(opts));
  const graph = new MsGraph(CFG, msHttpWith(idToken, { calendarSubject: opts.calendarSubject }));
  const app = buildApp({
    db,
    audit,
    transcriber: new MockTranscriber(),
    graph,
    webOrigin: "http://localhost:5173",
  });
  return { db, audit, app };
}

/** Build an app whose Microsoft token endpoint returns exactly `idToken`. */
function ctxWithIdToken(idToken: string) {
  const db = createDb();
  seedUsers(db);
  const audit = new AuditLog();
  const graph = new MsGraph(CFG, msHttpWith(idToken));
  const app = buildApp({
    db,
    audit,
    transcriber: new MockTranscriber(),
    graph,
    webOrigin: "http://localhost:5173",
  });
  return { db, audit, app };
}

/** Drive /auth/microsoft → /auth/callback and return the callback response. */
async function completeCallback(app: ReturnType<typeof makeGraphCtx>["app"]) {
  const start = await app.inject({ method: "GET", url: "/auth/microsoft" });
  const state = new URL(start.headers.location as string).searchParams.get("state")!;
  return app.inject({ method: "GET", url: `/auth/callback?code=fake-code&state=${state}` });
}

async function signInWithMicrosoft(app: ReturnType<typeof makeGraphCtx>["app"]): Promise<string> {
  const cb = await completeCallback(app);
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

  it("rejects an id_token signed by an untrusted key (no session issued)", async () => {
    // Right issuer/audience/expiry, but signed with a key that isn't in the
    // tenant JWKS — the exact forgery that a claims-only check would let in.
    const forged = signIdToken(validClaims({ email: "attacker@evil.example", name: "Mallory", oid: "oid-evil" }), {
      key: IMPOSTOR.privateKey,
      kid: "not-a-real-kid",
    });
    const ctx = ctxWithIdToken(forged);
    const cb = await completeCallback(ctx.app);
    expect(String(cb.headers.location)).toContain("msError=signin_failed");
    expect(String(cb.headers.location)).not.toContain("msToken=");
    expect(ctx.audit.query({}).some((e) => e.action === "session.login_microsoft_failed")).toBe(true);
    expect([...ctx.db.users.values()].some((u) => u.email === "attacker@evil.example")).toBe(false);
  });

  it("rejects a token whose signature is valid but kid matches while payload was swapped", async () => {
    // Sign a benign payload, then splice in an elevated payload keeping the
    // original signature: signature no longer matches the signing input.
    const honest = signIdToken(validClaims({ email: "priya@collective.dev", name: "Priya N", oid: "oid-priya" }));
    const [h, , s] = honest.split(".");
    const tampered = `${h}.${b64(validClaims({ email: "attacker@evil.example", name: "Mallory", oid: "x" }))}.${s}`;
    const ctx = ctxWithIdToken(tampered);
    const cb = await completeCallback(ctx.app);
    expect(String(cb.headers.location)).toContain("msError=signin_failed");
  });

  it("rejects an unsigned id_token (alg: none)", async () => {
    const claims = validClaims({ email: "x@y.co", name: "X", oid: "o" });
    const unsigned = `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.`;
    const ctx = ctxWithIdToken(unsigned);
    const cb = await completeCallback(ctx.app);
    expect(String(cb.headers.location)).toContain("msError=signin_failed");
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
