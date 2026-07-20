import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit.js";
import { buildApp } from "../src/http.js";
import { MockInsight } from "../src/adapters/insight.js";
import { MockTranscriber } from "../src/adapters/transcriber.js";
import { OAuthProvider } from "../src/oauth.js";
import { hasToolScope } from "../src/mcp.js";
import { createDb, seedUsers } from "../src/store.js";
import { auth, login, type Ctx } from "./helpers.js";

const ISSUER = "http://localhost:4000";
const RESOURCE = `${ISSUER}/mcp`;
const REDIRECT = "https://claude.example/api/mcp/auth_callback";

function makeCtx(): Ctx {
  const db = createDb();
  seedUsers(db);
  const audit = new AuditLog();
  const oauth = new OAuthProvider(db, audit, { issuer: ISSUER, resource: RESOURCE, webOrigin: "http://localhost:5173" });
  const app = buildApp({
    db,
    audit,
    transcriber: new MockTranscriber(),
    insight: new MockInsight(),
    oauth,
    webOrigin: "http://localhost:5173",
  });
  return { app, db, audit };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Admin mints an allowlisted client and returns its credentials. */
async function mintClient(ctx: Ctx, adminToken: string) {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/admin/oauth-clients",
    headers: auth(adminToken),
    payload: { name: "Claude (claude.ai)", redirectUris: [REDIRECT] },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { client: { clientId: string }; clientSecret: string };
  return { clientId: body.client.clientId, clientSecret: body.clientSecret };
}

/** Run authorize → consent(approve as `approverToken`) and return the code. */
async function getAuthCode(
  ctx: Ctx,
  opts: { clientId: string; challenge: string; approverToken: string; scope?: string; resource?: string; state?: string },
): Promise<string> {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: REDIRECT,
    code_challenge: opts.challenge,
    code_challenge_method: "S256",
    resource: opts.resource ?? RESOURCE,
    state: opts.state ?? "st4te",
  });
  if (opts.scope) q.set("scope", opts.scope);
  const authz = await ctx.app.inject({ method: "GET", url: `/oauth/authorize?${q}` });
  expect(authz.statusCode).toBe(302);
  const rid = new URL(authz.headers.location as string).searchParams.get("rid")!;
  expect(rid).toBeTruthy();
  const decision = await ctx.app.inject({
    method: "POST",
    url: "/oauth/authorize/decision",
    headers: auth(opts.approverToken),
    payload: { rid, approve: true },
  });
  expect(decision.statusCode).toBe(200);
  const redirectTo = (decision.json() as { redirectTo: string }).redirectTo;
  const u = new URL(redirectTo);
  expect(u.searchParams.get("state")).toBe(opts.state ?? "st4te");
  return u.searchParams.get("code")!;
}

async function exchange(
  ctx: Ctx,
  params: Record<string, string>,
) {
  return ctx.app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(params).toString(),
  });
}

describe("MCP OAuth discovery (RFC 9728 / RFC 8414)", () => {
  it("publishes protected-resource metadata pointing at the AS", async () => {
    const ctx = makeCtx();
    const res = await ctx.app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource" });
    expect(res.statusCode).toBe(200);
    const m = res.json();
    expect(m.resource).toBe(RESOURCE);
    expect(m.authorization_servers).toContain(ISSUER);
    expect(m.scopes_supported).toContain("transcripts.read");
  });

  it("publishes AS metadata with PKCE S256 and no dynamic registration", async () => {
    const ctx = makeCtx();
    const res = await ctx.app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" });
    expect(res.statusCode).toBe(200);
    const m = res.json();
    expect(m.issuer).toBe(ISSUER);
    expect(m.authorization_endpoint).toBe(`${ISSUER}/oauth/authorize`);
    expect(m.token_endpoint).toBe(`${ISSUER}/oauth/token`);
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(m.grant_types_supported).toContain("refresh_token");
    // Dynamic client registration is deliberately disabled (spec §6.4).
    expect(m.registration_endpoint).toBeUndefined();
  });
});

describe("MCP OAuth authorization-code + PKCE flow", () => {
  it("mints a client, runs the full flow, and issues a working token under the approver", async () => {
    const ctx = makeCtx();
    const dana = await login(ctx, "dana@collective.dev"); // org_admin
    const priya = await login(ctx, "priya@collective.dev"); // the human who approves
    const { clientId, clientSecret } = await mintClient(ctx, dana);
    const { verifier, challenge } = pkce();

    const code = await getAuthCode(ctx, { clientId, challenge, approverToken: priya });

    const tok = await exchange(ctx, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: verifier,
    });
    expect(tok.statusCode).toBe(200);
    const body = tok.json() as { access_token: string; refresh_token: string; token_type: string; scope: string };
    expect(body.token_type).toBe("Bearer");
    expect(body.access_token).toMatch(/^mcpat_/);
    expect(body.refresh_token).toMatch(/^mcprt_/);

    // The token authenticates on /mcp (no 401), and the access is the
    // approver's — a session token for priya reaches /mcp the same way.
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    };
    const mcp = await ctx.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${body.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: initialize,
    });
    expect(mcp.statusCode).not.toBe(401);
    expect(mcp.body).toContain("collective"); // server info in the initialize result

    // The consent + issuance were recorded under priya, not the client.
    const events = ctx.audit.query({});
    expect(events.some((e) => e.action === "oauth.authorize" && e.actorUserId === "u_priya")).toBe(true);
    expect(events.some((e) => e.action === "oauth.token_issued" && e.actorUserId === "u_priya")).toBe(true);
  });

  it("refreshes access tokens and rotates the refresh token", async () => {
    const ctx = makeCtx();
    const dana = await login(ctx, "dana@collective.dev");
    const priya = await login(ctx, "priya@collective.dev");
    const { clientId, clientSecret } = await mintClient(ctx, dana);
    const { verifier, challenge } = pkce();
    const code = await getAuthCode(ctx, { clientId, challenge, approverToken: priya });
    const first = (
      await exchange(ctx, {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: verifier,
      })
    ).json() as { refresh_token: string };

    const refreshed = await exchange(ctx, {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    });
    expect(refreshed.statusCode).toBe(200);
    const body = refreshed.json() as { access_token: string; refresh_token: string };
    expect(body.access_token).toMatch(/^mcpat_/);
    expect(body.refresh_token).not.toBe(first.refresh_token); // rotated

    // The old refresh token is now dead.
    const reuse = await exchange(ctx, {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    });
    expect(reuse.statusCode).toBe(400);
  });

  it("carries only the requested scopes onto the token", async () => {
    const ctx = makeCtx();
    const dana = await login(ctx, "dana@collective.dev");
    const priya = await login(ctx, "priya@collective.dev");
    const { clientId, clientSecret } = await mintClient(ctx, dana);
    const { verifier, challenge } = pkce();
    const code = await getAuthCode(ctx, { clientId, challenge, approverToken: priya, scope: "meetings.search" });
    const body = (
      await exchange(ctx, {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: verifier,
      })
    ).json() as { scope: string };
    expect(body.scope).toBe("meetings.search");
  });
});

describe("MCP OAuth deny paths", () => {
  it("rejects a bad PKCE verifier", async () => {
    const ctx = makeCtx();
    const dana = await login(ctx, "dana@collective.dev");
    const priya = await login(ctx, "priya@collective.dev");
    const { clientId, clientSecret } = await mintClient(ctx, dana);
    const { challenge } = pkce();
    const code = await getAuthCode(ctx, { clientId, challenge, approverToken: priya });
    const res = await exchange(ctx, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: "wrong-verifier",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_grant");
  });

  it("rejects a wrong client secret", async () => {
    const ctx = makeCtx();
    const dana = await login(ctx, "dana@collective.dev");
    const priya = await login(ctx, "priya@collective.dev");
    const { clientId } = await mintClient(ctx, dana);
    const { verifier, challenge } = pkce();
    const code = await getAuthCode(ctx, { clientId, challenge, approverToken: priya });
    const res = await exchange(ctx, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      client_secret: "not-the-secret",
      code_verifier: verifier,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_client");
  });

  it("refuses to redirect to an unregistered redirect_uri", async () => {
    const ctx = makeCtx();
    const dana = await login(ctx, "dana@collective.dev");
    const { clientId } = await mintClient(ctx, dana);
    const { challenge } = pkce();
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://evil.example/steal",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const res = await ctx.app.inject({ method: "GET", url: `/oauth/authorize?${q}` });
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers.location).toBeUndefined(); // never bounced to the attacker URI
  });

  it("rejects an authorization request for a mismatched resource", async () => {
    const ctx = makeCtx();
    const dana = await login(ctx, "dana@collective.dev");
    const { clientId } = await mintClient(ctx, dana);
    const { challenge } = pkce();
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: "https://someone-elses-server.example/mcp",
    });
    const res = await ctx.app.inject({ method: "GET", url: `/oauth/authorize?${q}` });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location)).toContain("error=invalid_target");
  });

  it("makes authorization codes single-use", async () => {
    const ctx = makeCtx();
    const dana = await login(ctx, "dana@collective.dev");
    const priya = await login(ctx, "priya@collective.dev");
    const { clientId, clientSecret } = await mintClient(ctx, dana);
    const { verifier, challenge } = pkce();
    const code = await getAuthCode(ctx, { clientId, challenge, approverToken: priya });
    const p = {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: verifier,
    };
    expect((await exchange(ctx, p)).statusCode).toBe(200);
    expect((await exchange(ctx, p)).statusCode).toBe(400); // reuse rejected
  });
});

describe("MCP resource server", () => {
  it("answers an unauthenticated /mcp with 401 + RFC 9728 pointer", async () => {
    const ctx = makeCtx();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    });
    expect(res.statusCode).toBe(401);
    expect(String(res.headers["www-authenticate"])).toContain("resource_metadata=");
    expect(String(res.headers["www-authenticate"])).toContain("oauth-protected-resource");
  });

  it("rejects a bogus bearer token on /mcp", async () => {
    const ctx = makeCtx();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: "Bearer mcpat_not-a-real-token",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    });
    expect(res.statusCode).toBe(401);
  });

  it("stops using a client's tokens once the client is revoked", async () => {
    const ctx = makeCtx();
    const dana = await login(ctx, "dana@collective.dev");
    const priya = await login(ctx, "priya@collective.dev");
    const { clientId, clientSecret } = await mintClient(ctx, dana);
    const { verifier, challenge } = pkce();
    const code = await getAuthCode(ctx, { clientId, challenge, approverToken: priya });
    const body = (
      await exchange(ctx, {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: verifier,
      })
    ).json() as { access_token: string };

    const del = await ctx.app.inject({ method: "DELETE", url: `/admin/oauth-clients/${clientId}`, headers: auth(dana) });
    expect(del.statusCode).toBe(200);

    const res = await ctx.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${body.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    });
    expect(res.statusCode).toBe(401);
  });

  it("only org_admins can mint connector clients", async () => {
    const ctx = makeCtx();
    const omar = await login(ctx, "omar@collective.dev"); // member
    const res = await ctx.app.inject({
      method: "POST",
      url: "/admin/oauth-clients",
      headers: auth(omar),
      payload: { name: "x", redirectUris: [REDIRECT] },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("MCP scope enforcement", () => {
  it("maps tools to read tiers", () => {
    expect(hasToolScope(["meetings.search"], "search_meetings")).toBe(true);
    expect(hasToolScope(["meetings.search"], "get_transcript")).toBe(false);
    expect(hasToolScope(["transcripts.read"], "get_transcript")).toBe(true);
    expect(hasToolScope(["meetings.read"], "list_meetings")).toBe(true);
    expect(hasToolScope([], "list_meetings")).toBe(false);
  });
});
