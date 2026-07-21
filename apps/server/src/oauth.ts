/**
 * MCP OAuth 2.1 Authorization Server + Resource Server (design-spec §6.4).
 *
 * Collective is the authorization server for its own /mcp resource. An
 * org_admin mints an allowlisted client (§6.4 disables open dynamic
 * registration in favor of an org-approved client set) and enters its
 * id/secret into the Claude surface. The user authenticates as themselves
 * through the normal web login and approves on a consent page; the client
 * then receives an audience-bound (RFC 8707) access token it presents on
 * /mcp. Discovery is RFC 9728 (protected-resource metadata) + RFC 8414
 * (authorization-server metadata); the code flow is PKCE-only (S256).
 *
 * Every tool call still executes under the caller's identity and is
 * audit-logged (mcp.ts) — there is no service-account "god token".
 *
 * Clients and issued tokens live in the Db (persisted like connector tokens).
 * Pending authorize requests and one-time codes are in-memory and short-lived,
 * exactly like login sessions — a restart mid-handshake just means retry.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { User } from "@collective/shared";
import { AuditLog } from "./audit.js";
import { publicOrigin, webOrigin } from "./config.js";
import { Db, OAuthClient } from "./store.js";

/** Read tiers exposed as OAuth scopes (spec §6.4). */
export const OAUTH_SCOPES = ["meetings.search", "meetings.read", "transcripts.read"] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

export interface OAuthConfig {
  /** Public origin of THIS server — the AS issuer and the resource host. */
  issuer: string;
  /** The protected resource URL (the MCP endpoint) tokens are bound to. */
  resource: string;
  /** Origin of the web app, where the browser consent page lives. */
  webOrigin: string;
}

export function oauthConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OAuthConfig {
  const issuer = publicOrigin(env);
  return { issuer, resource: `${issuer}/mcp`, webOrigin: webOrigin(env) };
}

const b64urlSha256 = (input: string): string => createHash("sha256").update(input).digest("base64url");
const sha256hex = (input: string): string => createHash("sha256").update(input).digest("hex");
const tok = (prefix: string): string => `${prefix}_${randomBytes(32).toString("base64url")}`;

/** Constant-time hex compare (secret verification). */
function hexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

interface PendingAuthorize {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  state?: string;
  resource: string;
  createdAtMs: number;
}

interface AuthCode {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  expiresAtMs: number;
}

export type AuthorizeResult =
  | { kind: "consent"; consentUrl: string }
  /** Bad client_id/redirect_uri — cannot safely bounce back, so show a page. */
  | { kind: "error_page"; message: string }
  /** Recoverable error — redirect back to the client per OAuth. */
  | { kind: "redirect_error"; url: string };

export type TokenResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; error: string; desc?: string };

const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
const ACCESS_TTL_SEC = 3600;

export class OAuthProvider {
  private pending = new Map<string, PendingAuthorize>(); // rid -> request
  private codes = new Map<string, AuthCode>(); // code -> data

  constructor(
    private db: Db,
    private audit: AuditLog,
    private cfg: OAuthConfig,
  ) {}

  /* ----------------------------- discovery ---------------------------- */

  protectedResourceMetadataUrl(): string {
    return `${this.cfg.issuer}/.well-known/oauth-protected-resource`;
  }

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.cfg.resource,
      authorization_servers: [this.cfg.issuer],
      scopes_supported: [...OAUTH_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "Collective",
    };
  }

  authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.cfg.issuer,
      authorization_endpoint: `${this.cfg.issuer}/oauth/authorize`,
      token_endpoint: `${this.cfg.issuer}/oauth/token`,
      scopes_supported: [...OAUTH_SCOPES],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      code_challenge_methods_supported: ["S256"],
      // No registration_endpoint: dynamic client registration is disabled in
      // favor of the admin-minted allowlist (spec §6.4).
    };
  }

  /* --------------------------- client admin --------------------------- */

  registerClient(input: { name: string; redirectUris: string[] }, byUserId: string): { client: OAuthClient; clientSecret: string } {
    const clientId = tok("mcpc");
    const clientSecret = tok("mcps");
    const client: OAuthClient = {
      clientId,
      clientSecretHash: sha256hex(clientSecret),
      name: input.name,
      redirectUris: input.redirectUris,
      createdAt: new Date().toISOString(),
      createdBy: byUserId,
    };
    this.db.oauthClients.set(clientId, client);
    this.audit.emit({ actorUserId: byUserId, action: "oauth.client_registered", detail: `${client.name} (${clientId})` });
    return { client, clientSecret };
  }

  listClients(): Array<Pick<OAuthClient, "clientId" | "name" | "redirectUris" | "createdAt">> {
    return [...this.db.oauthClients.values()].map(({ clientId, name, redirectUris, createdAt }) => ({
      clientId,
      name,
      redirectUris,
      createdAt,
    }));
  }

  revokeClient(clientId: string, byUserId: string): boolean {
    const client = this.db.oauthClients.get(clientId);
    if (!client) return false;
    this.db.oauthClients.delete(clientId);
    for (const [t, at] of this.db.oauthAccessTokens) if (at.clientId === clientId) this.db.oauthAccessTokens.delete(t);
    for (const [t, rt] of this.db.oauthRefreshTokens) if (rt.clientId === clientId) this.db.oauthRefreshTokens.delete(t);
    this.audit.emit({ actorUserId: byUserId, action: "oauth.client_revoked", detail: `${client.name} (${clientId})` });
    return true;
  }

  /* ---------------------------- authorize ----------------------------- */

  beginAuthorize(q: Record<string, string | undefined>): AuthorizeResult {
    const client = q.client_id ? this.db.oauthClients.get(q.client_id) : undefined;
    if (!client) return { kind: "error_page", message: "Unknown or unregistered client." };
    const redirectUri = q.redirect_uri ?? "";
    if (!client.redirectUris.includes(redirectUri)) {
      return { kind: "error_page", message: "The redirect_uri does not match a value registered for this client." };
    }
    const backError = (error: string, desc?: string): AuthorizeResult => {
      const u = new URL(redirectUri);
      u.searchParams.set("error", error);
      if (desc) u.searchParams.set("error_description", desc);
      if (q.state) u.searchParams.set("state", q.state);
      return { kind: "redirect_error", url: u.toString() };
    };
    if (q.response_type !== "code") return backError("unsupported_response_type");
    if (!q.code_challenge || q.code_challenge_method !== "S256") {
      return backError("invalid_request", "PKCE with code_challenge_method=S256 is required");
    }
    if (q.resource && !this.resourceMatches(q.resource)) return backError("invalid_target", "unknown resource");

    const rid = tok("mcprid");
    this.pending.set(rid, {
      clientId: client.clientId,
      redirectUri,
      codeChallenge: q.code_challenge,
      scope: this.grantableScope(q.scope),
      state: q.state,
      resource: this.cfg.resource,
      createdAtMs: Date.now(),
    });
    this.sweep();
    return { kind: "consent", consentUrl: `${this.cfg.webOrigin}/connect?rid=${encodeURIComponent(rid)}` };
  }

  /** Details for the consent page to render (rid is unguessable + expiring). */
  authorizeInfo(rid: string): { clientName: string; scopes: string[]; resource: string } | undefined {
    const p = this.getPending(rid);
    if (!p) return undefined;
    const client = this.db.oauthClients.get(p.clientId);
    if (!client) return undefined;
    return { clientName: client.name, scopes: p.scope.split(" ").filter(Boolean), resource: p.resource };
  }

  /** Resolve the consent decision: mint a code (approve) or an error redirect. */
  decide(rid: string, user: User, approve: boolean): { redirectTo: string } | undefined {
    const p = this.getPending(rid);
    if (!p) return undefined;
    this.pending.delete(rid);
    const u = new URL(p.redirectUri);
    if (p.state) u.searchParams.set("state", p.state);
    if (!approve) {
      u.searchParams.set("error", "access_denied");
      this.audit.emit({ actorUserId: user.id, action: "oauth.authorize_denied", detail: p.clientId });
      return { redirectTo: u.toString() };
    }
    const code = tok("mcpac");
    this.codes.set(code, {
      clientId: p.clientId,
      userId: user.id,
      redirectUri: p.redirectUri,
      codeChallenge: p.codeChallenge,
      scope: p.scope,
      resource: p.resource,
      expiresAtMs: Date.now() + CODE_TTL_MS,
    });
    u.searchParams.set("code", code);
    this.audit.emit({ actorUserId: user.id, action: "oauth.authorize", detail: `${p.clientId} scope=${p.scope}` });
    return { redirectTo: u.toString() };
  }

  /* ------------------------------ token ------------------------------- */

  token(params: Record<string, string | undefined>, basicAuth?: { id: string; secret: string }): TokenResult {
    const clientId = basicAuth?.id ?? params.client_id;
    const clientSecret = basicAuth?.secret ?? params.client_secret;
    if (!clientId) return { ok: false, status: 401, error: "invalid_client" };
    const client = this.db.oauthClients.get(clientId);
    if (!client) return { ok: false, status: 401, error: "invalid_client" };
    if (!clientSecret || !hexEquals(sha256hex(clientSecret), client.clientSecretHash)) {
      return { ok: false, status: 401, error: "invalid_client" };
    }

    if (params.grant_type === "authorization_code") {
      const code = params.code ? this.codes.get(params.code) : undefined;
      if (params.code) this.codes.delete(params.code); // single use, even on failure
      if (!code) return { ok: false, status: 400, error: "invalid_grant" };
      if (code.expiresAtMs < Date.now()) return { ok: false, status: 400, error: "invalid_grant", desc: "code expired" };
      if (code.clientId !== clientId) return { ok: false, status: 400, error: "invalid_grant", desc: "client mismatch" };
      if (code.redirectUri !== params.redirect_uri) {
        return { ok: false, status: 400, error: "invalid_grant", desc: "redirect_uri mismatch" };
      }
      if (!params.code_verifier || b64urlSha256(params.code_verifier) !== code.codeChallenge) {
        return { ok: false, status: 400, error: "invalid_grant", desc: "PKCE verification failed" };
      }
      return { ok: true, body: this.issue(clientId, code.userId, code.scope, code.resource) };
    }

    if (params.grant_type === "refresh_token") {
      const rt = params.refresh_token ? this.db.oauthRefreshTokens.get(params.refresh_token) : undefined;
      if (params.refresh_token) this.db.oauthRefreshTokens.delete(params.refresh_token); // rotation
      if (!rt) return { ok: false, status: 400, error: "invalid_grant" };
      if (rt.clientId !== clientId) return { ok: false, status: 400, error: "invalid_grant", desc: "client mismatch" };
      return { ok: true, body: this.issue(clientId, rt.userId, rt.scope, rt.resource) };
    }

    return { ok: false, status: 400, error: "unsupported_grant_type" };
  }

  private issue(clientId: string, userId: string, scope: string, resource: string): Record<string, unknown> {
    const accessToken = tok("mcpat");
    const refreshToken = tok("mcprt");
    this.db.oauthAccessTokens.set(accessToken, {
      token: accessToken,
      clientId,
      userId,
      scope,
      resource,
      expiresAtMs: Date.now() + ACCESS_TTL_SEC * 1000,
    });
    this.db.oauthRefreshTokens.set(refreshToken, { token: refreshToken, clientId, userId, scope, resource });
    this.audit.emit({ actorUserId: userId, action: "oauth.token_issued", detail: `${clientId} scope=${scope}` });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SEC,
      refresh_token: refreshToken,
      scope,
    };
  }

  /* -------------------------- resource server ------------------------- */

  /** Validate a bearer access token for the MCP resource (audience-bound). */
  verifyAccessToken(token: string): { user: User; scopes: string[] } | undefined {
    const at = this.db.oauthAccessTokens.get(token);
    if (!at) return undefined;
    if (at.expiresAtMs < Date.now()) {
      this.db.oauthAccessTokens.delete(token);
      return undefined;
    }
    if (!this.resourceMatches(at.resource)) return undefined; // RFC 8707 audience binding
    const user = this.db.users.get(at.userId);
    if (!user || user.deactivated) return undefined;
    return { user, scopes: at.scope.split(" ").filter(Boolean) };
  }

  /* ------------------------------ helpers ----------------------------- */

  private grantableScope(requested?: string): string {
    const req = (requested ?? "").split(/\s+/).filter(Boolean);
    const granted = req.length ? OAUTH_SCOPES.filter((s) => req.includes(s)) : [...OAUTH_SCOPES];
    // An unrecognized scope set shouldn't lock the connector out of everything.
    return (granted.length ? granted : [...OAUTH_SCOPES]).join(" ");
  }

  private resourceMatches(r: string): boolean {
    const norm = (s: string) => s.replace(/\/+$/, "");
    return norm(r) === norm(this.cfg.resource) || norm(r) === norm(this.cfg.issuer);
  }

  private getPending(rid: string): PendingAuthorize | undefined {
    const p = this.pending.get(rid);
    if (!p) return undefined;
    if (Date.now() - p.createdAtMs > PENDING_TTL_MS) {
      this.pending.delete(rid);
      return undefined;
    }
    return p;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [rid, p] of this.pending) if (now - p.createdAtMs > PENDING_TTL_MS) this.pending.delete(rid);
    for (const [c, d] of this.codes) if (d.expiresAtMs < now) this.codes.delete(c);
  }
}
