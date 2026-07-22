/**
 * HTTP API (docs/api.md). Compliance rules enforced here and in the services:
 * bearer auth with idle timeout (§2.6.1), consent gate before capture
 * (§2.6.2), per-layer ACL on every read (§2.7.2), audit event on every
 * content access (§2.6.1), PHI flag semantics (§6.6).
 */
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import type WebSocket from "ws";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  ConsentMechanism,
  Meeting,
  Note,
  ShareGrant,
  ShareLayer,
  User,
} from "@collective/shared";
import { AuditLog } from "./audit.js";
import { correct } from "./attribution.js";
import { can, canReadAudit, canSeeRecord, isAdmin, readableLayers } from "./rbac.js";
import { consentSatisfied, missingConsent, voiceVendorAllowed } from "./policy.js";
import {
  LiveHub,
  PipelineDeps,
  liveCaptionOnChunk,
  liveSpeakerNames,
  runPostMeetingPipeline,
  speakerNameFn,
} from "./pipeline.js";
import { search } from "./search.js";
import { Db, linkOrProvisionUser, newId, userByEmail } from "./store.js";
import { MsGraph } from "./msgraph.js";
import { OAUTH_SCOPES, OAuthProvider } from "./oauth.js";
import { webOrigin as resolveWebOrigin } from "./config.js";
import { Transcriber } from "./adapters/transcriber.js";
import { MockVoiceEngine, VoiceEngine } from "./adapters/voice.js";
import { AudioStore, MemoryAudioStore } from "./persist.js";
import { IcsFetcher, currentCalendarEvent, httpIcsFetcher } from "./calendar.js";
import { StreamingRelay, UpstreamFactory } from "./relay.js";
import { registerMcp } from "./mcp.js";

export interface AppDeps {
  db: Db;
  audit: AuditLog;
  transcriber: Transcriber;
  /** Voice-recognition engine; defaults to the local mock. */
  voiceEngine?: VoiceEngine;
  /** Defaults to in-memory; main.ts passes the disk store. */
  audioStore?: AudioStore;
  /** Live-caption vendor socket factory (relay.ts); null/absent = no live vendor captions. */
  upstreamFactory?: UpstreamFactory | null;
  /** ICS feed fetcher (calendar.ts); injectable for tests. */
  icsFetcher?: IcsFetcher;
  /** Microsoft Entra sign-in + Graph calendar (msgraph.ts); null = not configured. */
  graph?: MsGraph | null;
  /** MCP OAuth 2.1 AS + resource server (oauth.ts); null = not configured. */
  oauth?: OAuthProvider | null;
  /** Where the web app lives, for post-sign-in redirects. */
  webOrigin?: string;
  /**
   * Built web app directory (apps/web/dist). When set, the server also serves
   * the SPA + its assets so the whole app runs on one origin behind one HTTPS
   * URL — the deploy topology (docs/deploy.md). Unset in dev/tests.
   */
  webDir?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user: User;
    /** Granted MCP scopes when authenticated for /mcp (oauth.ts). */
    mcpScopes?: string[];
  }
}

function fail(reply: FastifyReply, code: number, error: string): never {
  reply.code(code);
  throw Object.assign(new Error(error), { statusCode: code, handled: true });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// API surface that requires a bearer. Everything else on the origin — the web
// app's static assets and its client-side routes (/, /login, /connect, /admin,
// …) — is served without auth so the app can run single-origin (docs/deploy.md).
// "/admin" alone is the SPA page; the admin API lives under "/admin/…".
const PROTECTED_PREFIXES = ["/users", "/meetings", "/search", "/audit", "/memos", "/shares", "/mcp", "/me"];
function routeNeedsAuth(path: string): boolean {
  if (path === "/oauth/authorize/decision") return true;
  if (path.startsWith("/admin/")) return true;
  return PROTECTED_PREFIXES.some((p) => path === p || path.startsWith(p + "/"));
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { db, audit } = deps;
  const hub = new LiveHub();
  const audioStore = deps.audioStore ?? new MemoryAudioStore();
  const voiceEngine = deps.voiceEngine ?? new MockVoiceEngine();
  const relay = new StreamingRelay(db, hub, audit, deps.upstreamFactory ?? null);
  const pipeline: PipelineDeps = {
    ...deps,
    voiceEngine,
    hub,
    audioFor: (id) => audioStore.read(id),
  };

  const app = Fastify({ bodyLimit: 25 * 1024 * 1024 });

  app.setErrorHandler((err, _req, reply) => {
    const code = (err as { statusCode?: number }).statusCode ?? 500;
    reply.code(code).send({ error: err.message });
  });

  // The OAuth token endpoint receives application/x-www-form-urlencoded
  // bodies (RFC 6749 §4.1.3); parse them into a flat string map.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err as Error);
      }
    },
  );

  // CORS: the packaged desktop shell serves the UI from its own loopback
  // origin and calls this server cross-origin. Allow loopback origins by
  // default plus any explicitly configured ones (COLLECTIVE_ALLOWED_ORIGINS,
  // comma-separated). Everything else gets no CORS headers — blocked.
  const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  const extraOrigins = (process.env.COLLECTIVE_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const corsHeaders = (origin: string | undefined): Record<string, string> =>
    origin && (LOOPBACK_ORIGIN.test(origin) || extraOrigins.includes(origin))
      ? {
          "access-control-allow-origin": origin,
          "access-control-allow-headers": "authorization, content-type, accept",
          "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE",
          "access-control-max-age": "600",
          vary: "Origin",
        }
      : {};

  app.addHook("onRequest", async (req, reply) => {
    for (const [k, v] of Object.entries(corsHeaders(req.headers.origin))) reply.header(k, v);
    if (req.method === "OPTIONS") return reply.code(204).send();
  });

  /* ------------------------------- auth -------------------------------- */

  app.post("/auth/dev-login", async (req, reply) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const user = userByEmail(db, email);
    if (!user || user.deactivated) return fail(reply, 404, "unknown user");
    const token = randomBytes(24).toString("hex");
    db.sessions.set(token, { token, userId: user.id, createdAt: Date.now(), lastSeenAt: Date.now() });
    audit.emit({ actorUserId: user.id, action: "session.login" });
    return { token, user };
  });

  /* ------------------- Microsoft Entra sign-in (ID-1) ------------------ */

  const graph = deps.graph ?? null;
  const oauth = deps.oauth ?? null;
  const webOrigin = (deps.webOrigin ?? resolveWebOrigin()).replace(/\/+$/, "");
  const oauthStates = new Map<string, number>(); // state -> createdAt (CSRF)

  app.get("/auth/config", async () => ({ microsoft: !!graph }));

  app.get("/auth/microsoft", async (_req, reply) => {
    if (!graph) return fail(reply, 404, "microsoft sign-in not configured");
    const state = randomBytes(16).toString("hex");
    oauthStates.set(state, Date.now());
    for (const [s, at] of oauthStates) if (Date.now() - at > 10 * 60 * 1000) oauthStates.delete(s);
    return reply.redirect(graph.authorizeUrl(state));
  });

  app.get("/auth/callback", async (req, reply) => {
    if (!graph) return fail(reply, 404, "microsoft sign-in not configured");
    const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };
    const back = (frag: string) => reply.redirect(`${webOrigin}/login#${frag}`);
    if (q.error) return back(`msError=${encodeURIComponent(q.error_description ?? q.error)}`);
    if (!q.code || !q.state || !oauthStates.has(q.state)) return back("msError=invalid_state");
    oauthStates.delete(q.state);
    try {
      const tokens = await graph.exchangeCode(q.code);
      if (!tokens.claims.email) return back("msError=no_email_claim");
      const user = linkOrProvisionUser(db, tokens.claims);
      if (user.deactivated) return back("msError=account_deactivated");
      if (tokens.refreshToken) {
        db.graphAuth.set(user.id, {
          userId: user.id,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAtMs: tokens.expiresAtMs,
        });
      }
      const token = randomBytes(24).toString("hex");
      db.sessions.set(token, { token, userId: user.id, createdAt: Date.now(), lastSeenAt: Date.now() });
      audit.emit({
        actorUserId: user.id,
        action: "session.login_microsoft",
        detail: `oid=${tokens.claims.oid}${tokens.claims.amr ? ` amr=${tokens.claims.amr.join("+")}` : ""}`,
      });
      return back(`msToken=${token}`);
    } catch (err) {
      audit.emit({ actorUserId: "system_auth", action: "session.login_microsoft_failed", detail: String(err) });
      return back("msError=signin_failed");
    }
  });

  /** Fresh Graph access token for a user, refreshing when near expiry. */
  const graphAccessToken = async (userId: string): Promise<string | undefined> => {
    if (!graph) return undefined;
    const auth = db.graphAuth.get(userId);
    if (!auth) return undefined;
    if (auth.expiresAtMs - Date.now() > 60_000) return auth.accessToken;
    try {
      const t = await graph.refresh(auth.refreshToken);
      db.graphAuth.set(userId, {
        userId,
        accessToken: t.accessToken,
        refreshToken: t.refreshToken ?? auth.refreshToken,
        expiresAtMs: t.expiresAtMs,
      });
      return t.accessToken;
    } catch {
      return undefined; // stale grant — user signs in with Microsoft again
    }
  };

  /* ------------- MCP OAuth 2.1 (spec §6.4): AS + discovery ------------- */

  // RFC 9728 protected-resource metadata + RFC 8414 AS metadata. Served at
  // the bare well-known path and the resource-suffixed variant, since MCP
  // clients probe both. Absent when OAuth isn't configured.
  const prMetadata = async (_req: FastifyRequest, reply: FastifyReply) =>
    oauth ? oauth.protectedResourceMetadata() : fail(reply, 404, "not found");
  const asMetadata = async (_req: FastifyRequest, reply: FastifyReply) =>
    oauth ? oauth.authorizationServerMetadata() : fail(reply, 404, "not found");
  app.get("/.well-known/oauth-protected-resource", prMetadata);
  app.get("/.well-known/oauth-protected-resource/mcp", prMetadata);
  app.get("/.well-known/oauth-authorization-server", asMetadata);
  app.get("/.well-known/oauth-authorization-server/mcp", asMetadata);

  // Authorization endpoint: validate, then hand the browser to the web
  // consent page. Bad client/redirect can't be safely bounced back, so they
  // render a page; recoverable errors redirect to the client per OAuth.
  app.get("/oauth/authorize", async (req, reply) => {
    if (!oauth) return fail(reply, 404, "oauth not configured");
    const result = oauth.beginAuthorize(req.query as Record<string, string | undefined>);
    if (result.kind === "consent") return reply.redirect(result.consentUrl);
    if (result.kind === "redirect_error") return reply.redirect(result.url);
    reply.code(400).type("text/html");
    return `<!doctype html><meta charset="utf-8"><title>Collective — connection error</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1>Can't start this connection</h1><p>${escapeHtml(result.message)}</p></body>`;
  });

  // Consent page data (rid is unguessable and short-lived, so this is public).
  app.get("/oauth/authorize/info", async (req, reply) => {
    if (!oauth) return fail(reply, 404, "oauth not configured");
    const info = oauth.authorizeInfo((req.query as { rid?: string }).rid ?? "");
    if (!info) return fail(reply, 404, "request expired");
    return info;
  });

  // Consent decision — requires the signed-in user (not public); the code is
  // minted under THAT user's identity.
  app.post("/oauth/authorize/decision", async (req, reply) => {
    if (!oauth) return fail(reply, 404, "oauth not configured");
    const body = z.object({ rid: z.string(), approve: z.boolean() }).parse(req.body);
    const result = oauth.decide(body.rid, req.user, body.approve);
    if (!result) return fail(reply, 404, "request expired");
    return result;
  });

  // Token endpoint: authorization_code (PKCE) + refresh_token grants.
  app.post("/oauth/token", async (req, reply) => {
    if (!oauth) return fail(reply, 404, "oauth not configured");
    const params = (req.body ?? {}) as Record<string, string | undefined>;
    let basicAuth: { id: string; secret: string } | undefined;
    const authz = req.headers.authorization ?? "";
    if (authz.startsWith("Basic ")) {
      const decoded = Buffer.from(authz.slice(6), "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      if (idx >= 0) {
        basicAuth = {
          id: decodeURIComponent(decoded.slice(0, idx)),
          secret: decodeURIComponent(decoded.slice(idx + 1)),
        };
      }
    }
    reply.header("cache-control", "no-store");
    const result = oauth.token(params, basicAuth);
    if (!result.ok) {
      return reply
        .code(result.status)
        .send({ error: result.error, ...(result.desc ? { error_description: result.desc } : {}) });
    }
    return result.body;
  });

  const PUBLIC = new Set([
    "/auth/dev-login",
    "/health",
    "/auth/config",
    "/auth/microsoft",
    "/auth/callback",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/mcp",
    "/oauth/authorize",
    "/oauth/authorize/info",
    "/oauth/token",
  ]);
  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split("?")[0]!;
    if (PUBLIC.has(path)) return;
    // Web assets and SPA routes (served in single-origin mode) carry no auth.
    if (!routeNeedsAuth(path)) return;
    // Browser WebSockets cannot send an Authorization header, so the live
    // stream route (and only it) may pass the bearer token as ?token=.
    const wsToken = path.endsWith("/stream") ? ((req.query as { token?: string }).token ?? "") : "";
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "") || wsToken;

    // The MCP surface accepts three credential kinds; none grants access to
    // any other route. On failure it answers with the RFC 9728 pointer so an
    // OAuth client can discover how to authenticate.
    if (path === "/mcp") {
      const mcpUnauth = (): never => {
        if (oauth) {
          reply.header("WWW-Authenticate", `Bearer resource_metadata="${oauth.protectedResourceMetadataUrl()}"`);
        }
        return fail(reply, 401, "invalid_token");
      };
      // 1. OAuth 2.1 access token (claude.ai connector — spec §6.4).
      const grant = oauth?.verifyAccessToken(token);
      if (grant) {
        req.user = grant.user;
        req.mcpScopes = grant.scopes;
        return;
      }
      // 2. Long-lived connector token (Claude Desktop via mcp-remote).
      const ct = db.connectorTokens.get(token);
      if (ct) {
        const user = db.users.get(ct.userId);
        if (!user || user.deactivated) return mcpUnauth();
        req.user = user;
        req.mcpScopes = [...OAUTH_SCOPES];
        return;
      }
      // 3. A normal signed-in session (same-origin / in-app use).
      const s = db.sessions.get(token);
      const sUser = s && db.users.get(s.userId);
      if (s && sUser && !sUser.deactivated && Date.now() - s.lastSeenAt <= db.idleMinutes * 60 * 1000) {
        s.lastSeenAt = Date.now();
        req.user = sUser;
        req.mcpScopes = [...OAUTH_SCOPES];
        return;
      }
      return mcpUnauth();
    }

    const session = db.sessions.get(token);
    if (!session) return fail(reply, 401, "unauthenticated");
    const idleMs = db.idleMinutes * 60 * 1000;
    if (Date.now() - session.lastSeenAt > idleMs) {
      db.sessions.delete(token);
      return fail(reply, 401, "session_expired");
    }
    session.lastSeenAt = Date.now();
    const user = db.users.get(session.userId);
    if (!user || user.deactivated) return fail(reply, 401, "unauthenticated");
    req.user = user;
  });

  app.get("/health", async () => ({ ok: true }));
  app.get("/me", async (req) => ({ user: req.user }));

  /* --------------------------- user settings --------------------------- */

  app.get("/me/settings", async (req) => ({
    settings: db.userSettings.get(req.user.id) ?? {},
  }));

  app.put("/me/settings", async (req) => {
    const body = z
      .object({ calendarIcsUrl: z.string().url().max(2000).or(z.literal("")) })
      .parse(req.body);
    const settings = { ...db.userSettings.get(req.user.id) };
    settings.calendarIcsUrl = body.calendarIcsUrl || undefined;
    db.userSettings.set(req.user.id, settings);
    audit.emit({
      actorUserId: req.user.id,
      action: "settings.calendar_updated",
      detail: body.calendarIcsUrl ? "ICS feed set" : "ICS feed cleared",
    });
    return { settings };
  });

  app.get("/me/calendar-preview", async (req, reply) => {
    // Settings "test" button: what would a capture started now be called?
    if (!db.graphAuth.has(req.user.id) && !db.userSettings.get(req.user.id)?.calendarIcsUrl) {
      return fail(reply, 404, "no calendar configured");
    }
    const hit = await eventForUserNow(req.user.id);
    return {
      event: hit ? { title: hit.event.summary, attendeeEmails: hit.event.attendeeEmails, source: hit.source } : null,
    };
  });

  /* ---------------------- Claude connector tokens ---------------------- */

  app.get("/me/connector-token", async (req) => {
    const existing = [...db.connectorTokens.values()].find((t) => t.userId === req.user.id);
    return { exists: !!existing, createdAt: existing?.createdAt ?? null };
  });

  app.post("/me/connector-token", async (req) => {
    // One active token per user; minting replaces (and so revokes) the old one.
    for (const [k, t] of db.connectorTokens) if (t.userId === req.user.id) db.connectorTokens.delete(k);
    const token = `mcp_${randomBytes(24).toString("hex")}`;
    db.connectorTokens.set(token, { token, userId: req.user.id, createdAt: new Date().toISOString() });
    audit.emit({ actorUserId: req.user.id, action: "connector_token.minted" });
    return { token }; // shown once; only its existence is retrievable later
  });

  app.delete("/me/connector-token", async (req) => {
    for (const [k, t] of db.connectorTokens) if (t.userId === req.user.id) db.connectorTokens.delete(k);
    audit.emit({ actorUserId: req.user.id, action: "connector_token.revoked" });
    return { ok: true };
  });
  app.get("/users", async () => ({
    users: [...db.users.values()].map(({ id, displayName, role, speakerHue, bubbleHue }) => ({
      id,
      displayName,
      role,
      speakerHue,
      bubbleHue,
    })),
  }));

  app.put("/me/appearance", async (req, reply) => {
    // Self-only personal bubble color (0 = accent, 1..8 = speaker ramp). Lives
    // on the User record so other viewers see it on the caller's bubbles.
    const bubbleHue = (req.body as { bubbleHue?: unknown } | undefined)?.bubbleHue;
    if (typeof bubbleHue !== "number" || !Number.isInteger(bubbleHue) || bubbleHue < 0 || bubbleHue > 8) {
      return fail(reply, 400, "bubbleHue must be an integer 0..8");
    }
    req.user.bubbleHue = bubbleHue;
    audit.emit({ actorUserId: req.user.id, action: "appearance.updated", detail: `bubbleHue=${bubbleHue}` });
    return { user: req.user };
  });

  /* --------------------------- voiceprint ------------------------------ */

  const voiceprintStatus = (userId: string) => {
    const v = db.voiceprints.get(userId);
    return { enrolled: !!v, createdAt: v?.createdAt ?? null, vendor: v?.vendor ?? null };
  };

  app.get("/me/voiceprint", async (req) => voiceprintStatus(req.user.id));

  app.post("/me/voiceprint", async (req, reply) => {
    // Enroll the caller's own voice so future meetings can auto-attribute them
    // (spec §2.3.3). Biometric data (§2.6.3): explicit consent is required, and
    // a REAL voice vendor is gated on the `voice` BAA. The mock is local.
    const body = z
      .object({ audioBase64: z.string().min(1), consent: z.literal(true) })
      .safeParse(req.body);
    if (!body.success) {
      return fail(reply, 400, "audioBase64 and explicit consent:true are required");
    }
    if (!voiceVendorAllowed(db, voiceEngine.name)) {
      return fail(reply, 409, "voice enrollment needs the voice-vendor BAA on the registry");
    }
    const audio = Buffer.from(body.data.audioBase64, "base64");
    const now = new Date().toISOString();
    const voiceprint = {
      userId: req.user.id,
      entityId: req.user.entityId,
      embedding: voiceEngine.enroll(req.user.id, audio),
      vendor: voiceEngine.name,
      createdAt: now,
      consentAt: now,
    };
    db.voiceprints.set(req.user.id, voiceprint);
    // Never log the embedding; just that enrollment happened, with consent.
    audit.emit({ actorUserId: req.user.id, action: "voiceprint.enrolled", detail: `vendor=${voiceEngine.name}` });
    return voiceprintStatus(req.user.id);
  });

  app.delete("/me/voiceprint", async (req) => {
    // Right to delete biometric data (§2.6.3). Self-only.
    const had = db.voiceprints.delete(req.user.id);
    if (had) audit.emit({ actorUserId: req.user.id, action: "voiceprint.deleted" });
    return voiceprintStatus(req.user.id);
  });

  /* ----------------------------- meetings ------------------------------ */

  const getMeeting = (req: FastifyRequest, reply: FastifyReply, id: string): Meeting => {
    const m = db.meetings.get(id);
    if (!m || m.status === "deleted" || !canSeeRecord(db, req.user, m)) return fail(reply, 404, "not found");
    return m;
  };

  app.get("/meetings", async (req) => {
    const meetings = [...db.meetings.values()]
      .filter((m) => m.status !== "deleted" && canSeeRecord(db, req.user, m))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((m) => ({ ...m, myLayers: readableLayers(db, req.user, m) }));
    return { meetings };
  });

  const icsFetcher = deps.icsFetcher ?? httpIcsFetcher;

  /** Calendar event covering "now" for a user: Graph first, ICS fallback. */
  const eventForUserNow = async (userId: string) => {
    const accessToken = await graphAccessToken(userId);
    if (accessToken && graph) {
      try {
        const event = await graph.currentEvent(accessToken);
        if (event) return { event, source: "graph" as const };
      } catch {
        /* fall through to ICS */
      }
    }
    const icsUrl = db.userSettings.get(userId)?.calendarIcsUrl;
    if (icsUrl) {
      const event = await currentCalendarEvent(icsUrl, icsFetcher);
      if (event) return { event, source: "ics" as const };
    }
    return undefined;
  };

  app.post("/meetings", async (req) => {
    const body = z
      .object({
        title: z.string().max(200).optional(),
        mode: z.enum(["virtual_desktop", "in_person", "mobile_speakerphone"]),
        attendeeUserIds: z.array(z.string()).default([]),
      })
      .parse(req.body ?? {});
    const meeting: Meeting = {
      id: newId("mtg"),
      entityId: req.user.entityId,
      ownerUserId: req.user.id,
      title: body.title ?? "",
      mode: body.mode,
      status: "draft",
      attendeeUserIds: body.attendeeUserIds.filter((id) => id !== req.user.id && db.users.has(id)),
      phiFlag: null,
      consent: [],
      audioChunks: 0,
      createdAt: new Date().toISOString(),
    };

    // Calendar naming (AT-3): untitled meetings pick up the current calendar
    // event's name — Microsoft Graph when the owner signed in with Microsoft,
    // else their ICS feed — plus attendees whose emails match the directory.
    // Any calendar failure silently yields an untitled meeting.
    if (!meeting.title) {
      const hit = await eventForUserNow(req.user.id);
      if (hit) {
        meeting.title = hit.event.summary.slice(0, 200);
        meeting.namedFromCalendar = true;
        for (const email of hit.event.attendeeEmails) {
          const u = userByEmail(db, email);
          if (u && u.id !== req.user.id && !meeting.attendeeUserIds.includes(u.id)) {
            meeting.attendeeUserIds.push(u.id);
          }
        }
        audit.emit({
          actorUserId: req.user.id,
          action: "meeting.named_from_calendar",
          meetingId: meeting.id,
          detail: `"${meeting.title}" via ${hit.source} +${hit.event.attendeeEmails.length} attendee email(s)`,
        });
      }
    }

    db.meetings.set(meeting.id, meeting);
    audit.emit({ actorUserId: req.user.id, action: "meeting.create", meetingId: meeting.id });
    return { meeting };
  });

  app.get("/meetings/:id", async (req, reply) => {
    const m = getMeeting(req, reply, (req.params as { id: string }).id);
    audit.emit({ actorUserId: req.user.id, action: "meeting.read", meetingId: m.id, layer: "record" });
    return { meeting: m, myLayers: readableLayers(db, req.user, m) };
  });

  app.patch("/meetings/:id", async (req, reply) => {
    const m = getMeeting(req, reply, (req.params as { id: string }).id);
    if (m.ownerUserId !== req.user.id) return fail(reply, 403, "owner only");
    const { title } = z.object({ title: z.string().max(200) }).parse(req.body);
    m.title = title;
    audit.emit({ actorUserId: req.user.id, action: "meeting.title_edited", meetingId: m.id });
    return { meeting: m };
  });

  app.post("/meetings/:id/consent", async (req, reply) => {
    const m = getMeeting(req, reply, (req.params as { id: string }).id);
    const body = z
      .object({
        mechanism: z.enum([
          "verbal_announcement_attested",
          "audible_tone",
          "invite_disclosure",
          "participant_ack",
          "teams_banner",
        ]),
        detail: z.string().max(500).optional(),
      })
      .parse(req.body);
    m.consent.push({
      mechanism: body.mechanism as ConsentMechanism,
      actorUserId: req.user.id,
      at: new Date().toISOString(),
      detail: body.detail,
    });
    audit.emit({ actorUserId: req.user.id, action: "consent.recorded", meetingId: m.id, detail: body.mechanism });
    return { meeting: m };
  });

  app.post("/meetings/:id/start", async (req, reply) => {
    const m = getMeeting(req, reply, (req.params as { id: string }).id);
    if (m.ownerUserId !== req.user.id) return fail(reply, 403, "owner only");
    if (m.status !== "draft") return fail(reply, 409, "already started");
    if (!consentSatisfied(db, m)) {
      reply.code(409);
      return { error: "consent_required", missing: missingConsent(db, m) };
    }
    m.status = "recording";
    m.startedAt = new Date().toISOString();
    audit.emit({ actorUserId: req.user.id, action: "capture.start", meetingId: m.id });
    return { meeting: m };
  });

  app.post("/meetings/:id/chunks", async (req, reply) => {
    const m = getMeeting(req, reply, (req.params as { id: string }).id);
    if (m.ownerUserId !== req.user.id) return fail(reply, 403, "owner only");
    if (m.status !== "recording") return fail(reply, 409, "not recording");
    const { seq, dataBase64 } = z.object({ seq: z.number().int(), dataBase64: z.string() }).parse(req.body);
    audioStore.append(m.id, Buffer.from(dataBase64, "base64"));
    m.audioChunks += 1;
    liveCaptionOnChunk(pipeline, m, seq);
    return { received: m.audioChunks };
  });

  app.get("/meetings/:id/live", async (req, reply) => {
    const m = getMeeting(req, reply, (req.params as { id: string }).id);
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...corsHeaders(req.headers.origin), // raw writeHead bypasses the hook's reply headers
    });
    const sink = (event: string, data: unknown) =>
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    // liveCaptions: the mock engine scripts them locally; real vendors need
    // the streaming relay to be configured AND §6.6 egress to allow it.
    sink("status", {
      status: m.status,
      liveCaptions: deps.transcriber.name === "mock" || relay.available(m),
    });
    // Names already assigned this session, so a (re)joining client renders them.
    const names = liveSpeakerNames(db, m.id);
    if (Object.keys(names).length > 0) sink("speakers", names);
    const unsub = hub.subscribe(m.id, sink);
    req.raw.on("close", unsub);
    return reply; // stream held open
  });

  app.post("/meetings/:id/live/speaker", async (req, reply) => {
    // In-session speaker naming: fix "Speaker 2" (or a wrong guess) while the
    // meeting is still running. Applies to the live captions immediately and
    // becomes manual attribution evidence when the transcript is built.
    const m = getMeeting(req, reply, (req.params as { id: string }).id);
    if (m.ownerUserId !== req.user.id) return fail(reply, 403, "owner only");
    if (m.status !== "recording") return fail(reply, 409, "not recording");
    const body = z
      .object({
        cluster: z.string().min(1).max(40),
        userId: z.string().optional(),
        guestLabel: z.string().max(80).optional(),
      })
      .refine((b) => !!b.userId !== !!b.guestLabel, "exactly one of userId | guestLabel")
      .parse(req.body);
    if (body.userId && !db.users.has(body.userId)) return fail(reply, 400, "unknown user");
    const map = db.liveSpeakers.get(m.id) ?? {};
    map[body.cluster] = body.userId ? { userId: body.userId } : { guestLabel: body.guestLabel };
    db.liveSpeakers.set(m.id, map);
    audit.emit({
      actorUserId: req.user.id,
      action: "live.speaker_named",
      meetingId: m.id,
      detail: `${body.cluster} → ${body.userId ?? `guest:${body.guestLabel}`}`,
    });
    const speakers = liveSpeakerNames(db, m.id);
    hub.emit(m.id, "speakers", speakers);
    return { speakers };
  });

  app.post("/meetings/:id/flags", async (req, reply) => {
    // Facilitator flags a moment during capture — a timeline marker that renders
    // as a divider in the transcript. Not content, just a timestamp + label.
    const m = getMeeting(req, reply, (req.params as { id: string }).id);
    if (m.ownerUserId !== req.user.id) return fail(reply, 403, "owner only");
    if (m.status !== "recording") return fail(reply, 409, "not recording");
    const body = z
      .object({ atMs: z.number().int().min(0), label: z.string().max(80).optional() })
      .parse(req.body);
    const flag = {
      id: `f_${randomBytes(6).toString("hex")}`,
      atMs: body.atMs,
      label: body.label?.trim() || undefined,
      byUserId: req.user.id,
      at: new Date().toISOString(),
    };
    (m.flags ??= []).push(flag);
    audit.emit({ actorUserId: req.user.id, action: "meeting.flagged", meetingId: m.id, detail: `t=${flag.atMs}` });
    return { flag, meeting: m };
  });

  app.post("/meetings/:id/stop", async (req, reply) => {
    const m = getMeeting(req, reply, (req.params as { id: string }).id);
    if (m.ownerUserId !== req.user.id) return fail(reply, 403, "owner only");
    if (m.status !== "recording") return fail(reply, 409, "not recording");
    audit.emit({ actorUserId: req.user.id, action: "capture.stop", meetingId: m.id });
    void runPostMeetingPipeline(pipeline, m, req.user);
    return { meeting: m };
  });

  app.post("/meetings/:id/reprocess", async (req, reply) => {
    // Re-run transcription/attribution from preserved audio — e.g. after the
    // BAA registry changes or a vendor outage (§6.6; backlog SUM-4).
    const m = getMeeting(req, reply, (req.params as { id: string }).id);
    if (m.ownerUserId !== req.user.id) return fail(reply, 403, "owner only");
    if (m.status !== "ready") return fail(reply, 409, "not reprocessable");
    if (m.audioChunks === 0) return fail(reply, 409, "no preserved audio");
    audit.emit({ actorUserId: req.user.id, action: "pipeline.reprocess", meetingId: m.id });
    void runPostMeetingPipeline(pipeline, m, req.user);
    return { meeting: m };
  });

  app.post("/meetings/:id/objection", async (req, reply) => {
    // Objection path (spec §2.6.2): stop, delete audio, keep the caller's notes.
    const m = getMeeting(req, reply, (req.params as { id: string }).id);
    if (m.ownerUserId !== req.user.id) return fail(reply, 403, "owner only");
    m.status = "ready";
    m.endedAt = new Date().toISOString();
    audioStore.delete(m.id);
    m.audioChunks = 0;
    db.utterances.delete(m.id);
    db.liveSpeakers.delete(m.id);
    db.liveTurns.delete(m.id);
    if (!m.title) m.title = "Meeting (recording declined)";
    m.notice = "A participant objected — audio and transcript were not kept. Your typed notes are preserved.";
    audit.emit({ actorUserId: req.user.id, action: "consent.objection_honored", meetingId: m.id });
    return { meeting: m };
  });

  /* ---------------------------- transcript ----------------------------- */

  app.get("/meetings/:id/transcript", async (req, reply) => {
    const m = getMeeting(req, reply, (req.params as { id: string }).id);
    if (!can(db, req.user, "read", m, "transcript")) return fail(reply, 403, "no transcript access");
    audit.emit({ actorUserId: req.user.id, action: "transcript.read", meetingId: m.id, layer: "transcript" });
    const utts = db.utterances.get(m.id) ?? [];
    const name = speakerNameFn(db, utts);
    return { utterances: utts.map((u) => ({ ...u, speakerName: name(u) })) };
  });

  app.post("/meetings/:id/utterances/:uid/speaker", async (req, reply) => {
    const m = getMeeting(req, reply, (req.params as { id: string }).id);
    if (!can(db, req.user, "read", m, "transcript")) return fail(reply, 403, "no transcript access");
    const { uid } = req.params as { uid: string };
    const body = z
      .object({
        userId: z.string().optional(),
        guestLabel: z.string().max(80).optional(),
        scope: z.enum(["line", "voice"]),
      })
      .refine((b) => !!b.userId !== !!b.guestLabel, "exactly one of userId | guestLabel")
      .parse(req.body);
    if (body.userId && !db.users.has(body.userId)) return fail(reply, 400, "unknown user");
    const updated = correct(db.utterances.get(m.id) ?? [], uid, body, body.scope);
    db.utterances.set(m.id, updated);
    audit.emit({
      actorUserId: req.user.id,
      action: "transcript.speaker_corrected",
      meetingId: m.id,
      detail: `${uid} → ${body.userId ?? `guest:${body.guestLabel}`} (${body.scope})`,
    });
    const name = speakerNameFn(db, updated);
    return { utterances: updated.map((u) => ({ ...u, speakerName: name(u) })) };
  });

  app.put("/meetings/:id/phi-flag", async (req, reply) => {
    const m = getMeeting(req, reply, (req.params as { id: string }).id);
    if (m.ownerUserId !== req.user.id) return fail(reply, 403, "owner only");
    const { flagged } = z.object({ flagged: z.boolean().nullable() }).parse(req.body);
    m.phiFlag = flagged;
    audit.emit({ actorUserId: req.user.id, action: "phi_flag.set", meetingId: m.id, detail: String(flagged) });
    return { meeting: m };
  });

  /* ------------------------------- notes ------------------------------- */

  app.get("/meetings/:id/notes", async (req, reply) => {
    const m = getMeeting(req, reply, (req.params as { id: string }).id);
    const note = db.notes.get(`${m.id}:${req.user.id}`) ?? null;
    return { note };
  });

  app.put("/meetings/:id/notes", async (req, reply) => {
    const m = getMeeting(req, reply, (req.params as { id: string }).id);
    const { body } = z.object({ body: z.string().max(100_000) }).parse(req.body);
    const note: Note = { meetingId: m.id, authorUserId: req.user.id, body, updatedAt: new Date().toISOString() };
    db.notes.set(`${m.id}:${req.user.id}`, note);
    return { note };
  });

  /* ------------------------------- audio ------------------------------- */

  app.get("/meetings/:id/audio", async (req, reply) => {
    const m = getMeeting(req, reply, (req.params as { id: string }).id);
    if (!can(db, req.user, "read", m, "audio")) return fail(reply, 403, "no audio access");
    audit.emit({ actorUserId: req.user.id, action: "audio.play", meetingId: m.id, layer: "audio" });
    reply.header("content-type", "audio/webm");
    return reply.send(audioStore.read(m.id));
  });

  /* ------------------------------ sharing ------------------------------ */

  app.post("/meetings/:id/shares", async (req, reply) => {
    const m = getMeeting(req, reply, (req.params as { id: string }).id);
    if (m.ownerUserId !== req.user.id) return fail(reply, 403, "owner only");
    const body = z
      .object({
        layer: z.enum(["summary", "notes", "transcript", "audio"]),
        granteeUserId: z.string(),
        permission: z.enum(["view", "edit"]).default("view"),
      })
      .parse(req.body);
    if (!db.users.has(body.granteeUserId)) return fail(reply, 400, "unknown grantee");
    if (body.permission === "edit" && body.layer !== "summary") return fail(reply, 400, "edit applies to summary only");
    // Audio is most-restricted (spec §2.7.2): stream-only, and grantable only
    // to individual named users — enforced here as view-only.
    if (body.layer === "audio" && body.permission !== "view") return fail(reply, 400, "audio is view-only");
    const share: ShareGrant = {
      id: newId("shr"),
      meetingId: m.id,
      layer: body.layer as ShareLayer,
      granteeUserId: body.granteeUserId,
      permission: body.permission,
      grantedBy: req.user.id,
      grantedAt: new Date().toISOString(),
    };
    db.shares.set(share.id, share);
    audit.emit({
      actorUserId: req.user.id,
      action: "share.grant",
      meetingId: m.id,
      layer: share.layer,
      detail: `→ ${body.granteeUserId} (${body.permission})`,
    });
    return { share };
  });

  app.get("/meetings/:id/shares", async (req, reply) => {
    const m = getMeeting(req, reply, (req.params as { id: string }).id);
    if (m.ownerUserId !== req.user.id && !canReadAudit(req.user)) return fail(reply, 403, "owner only");
    return { shares: [...db.shares.values()].filter((s) => s.meetingId === m.id) };
  });

  app.delete("/shares/:shareId", async (req, reply) => {
    const { shareId } = req.params as { shareId: string };
    const share = db.shares.get(shareId);
    if (!share) return fail(reply, 404, "not found");
    const m = db.meetings.get(share.meetingId);
    if (!m || m.ownerUserId !== req.user.id) return fail(reply, 403, "owner only");
    db.shares.delete(shareId);
    audit.emit({
      actorUserId: req.user.id,
      action: "share.revoke",
      meetingId: share.meetingId,
      layer: share.layer,
      detail: `→ ${share.granteeUserId}`,
    });
    return { ok: true };
  });

  /* ------------------------- memos & search ---------------------------- */

  app.post("/memos", async (req) => {
    const { dataBase64 } = z.object({ dataBase64: z.string() }).parse(req.body);
    const text = await deps.transcriber.transcribeMemoSync(Buffer.from(dataBase64, "base64"));
    audit.emit({ actorUserId: req.user.id, action: "memo.transcribed", detail: `${deps.transcriber.name}` });
    return { text };
  });

  app.get("/search", async (req) => {
    const { q = "" } = req.query as { q?: string };
    const hits = search(db, req.user, q);
    audit.emit({ actorUserId: req.user.id, action: "search.query", detail: `"${q}" → ${hits.length} hits` });
    return { hits };
  });

  /* ------------------------------ admin -------------------------------- */

  app.get("/audit", async (req, reply) => {
    if (!canReadAudit(req.user)) return fail(reply, 403, "auditor only");
    const { meetingId, actor } = req.query as { meetingId?: string; actor?: string };
    return { events: audit.query({ meetingId, actorUserId: actor }) };
  });

  const adminOnly = (req: FastifyRequest, reply: FastifyReply) => {
    if (!isAdmin(req.user)) fail(reply, 403, "admin only");
  };

  app.put("/admin/users/:id/role", async (req, reply) => {
    adminOnly(req, reply);
    const { id } = req.params as { id: string };
    const { role } = z
      .object({ role: z.enum(["org_admin", "entity_admin", "compliance_auditor", "member", "guest_viewer"]) })
      .parse(req.body);
    if (id === req.user.id) return fail(reply, 400, "cannot change your own role");
    const target = db.users.get(id);
    if (!target) return fail(reply, 404, "unknown user");
    target.role = role;
    audit.emit({ actorUserId: req.user.id, action: "admin.role_changed", detail: `${id} → ${role}` });
    return { user: target };
  });

  /* -------- MCP OAuth client allowlist (org_admin; spec §6.4) --------- */

  app.post("/admin/oauth-clients", async (req, reply) => {
    adminOnly(req, reply);
    if (!oauth) return fail(reply, 404, "oauth not configured");
    const body = z
      .object({
        name: z.string().min(1).max(120),
        redirectUris: z.array(z.string().url()).min(1).max(10),
      })
      .parse(req.body);
    const { client, clientSecret } = oauth.registerClient(body, req.user.id);
    // clientSecret is returned once and never stored in the clear.
    return {
      client: { clientId: client.clientId, name: client.name, redirectUris: client.redirectUris, createdAt: client.createdAt },
      clientSecret,
    };
  });

  app.get("/admin/oauth-clients", async (req, reply) => {
    adminOnly(req, reply);
    return { clients: oauth ? oauth.listClients() : [] };
  });

  app.delete("/admin/oauth-clients/:clientId", async (req, reply) => {
    adminOnly(req, reply);
    if (!oauth) return fail(reply, 404, "oauth not configured");
    const { clientId } = req.params as { clientId: string };
    if (!oauth.revokeClient(clientId, req.user.id)) return fail(reply, 404, "unknown client");
    return { ok: true };
  });

  app.get("/admin/baa-registry", async (req, reply) => (adminOnly(req, reply), { baa: db.baa }));
  app.put("/admin/baa-registry", async (req, reply) => {
    adminOnly(req, reply);
    db.baa = z
      .object({
        assemblyai: z.boolean(),
        claudeWorkspace: z.boolean(),
        microsoft: z.boolean(),
        voice: z.boolean(),
      })
      .parse(req.body);
    audit.emit({ actorUserId: req.user.id, action: "admin.baa_registry_updated", detail: JSON.stringify(db.baa) });
    return { baa: db.baa };
  });

  app.get("/admin/consent-policy", async (req, reply) => (adminOnly(req, reply), { policy: db.consentPolicy }));
  app.put("/admin/consent-policy", async (req, reply) => {
    adminOnly(req, reply);
    db.consentPolicy = z
      .object({
        requiredMechanisms: z.array(
          z.enum(["verbal_announcement_attested", "audible_tone", "invite_disclosure", "participant_ack", "teams_banner"]),
        ),
        phiFailSafe: z.boolean(),
      })
      .parse(req.body);
    audit.emit({ actorUserId: req.user.id, action: "admin.consent_policy_updated" });
    return { policy: db.consentPolicy };
  });

  app.get("/admin/retention", async (req, reply) => (adminOnly(req, reply), { retention: db.retention }));
  app.put("/admin/retention", async (req, reply) => {
    adminOnly(req, reply);
    db.retention = z
      .object({
        audioDays: z.number().int().min(1),
        transcriptDays: z.number().int().min(1),
        auditDays: z.number().int().min(365 * 6),
      })
      .parse(req.body);
    audit.emit({ actorUserId: req.user.id, action: "admin.retention_updated", detail: JSON.stringify(db.retention) });
    return { retention: db.retention };
  });

  // Live PCM streaming for real-vendor captions (relay.ts, backlog IN-2).
  void app.register(websocket);
  void app.register(async (scope) => {
    scope.get("/meetings/:id/stream", { websocket: true }, (connection, req) => {
      // @fastify/websocket v10 hands a stream wrapper with .socket; be
      // tolerant of the v11 bare-socket signature too.
      const socket = ((connection as { socket?: WebSocket }).socket ?? connection) as WebSocket;
      const m = db.meetings.get((req.params as { id: string }).id);
      if (!m || m.ownerUserId !== req.user.id || m.status !== "recording") {
        socket.close(1008, "not streamable");
        return;
      }
      const rate = Math.min(Math.max(Number((req.query as { rate?: string }).rate ?? 16000) || 16000, 8000), 48000);
      relay.attach(socket, m, rate);
    });
  });

  registerMcp(app, deps);

  // Single-origin serving (deploy topology): the API above plus the built web
  // app on the same host, so one HTTPS URL covers the UI, the API, MCP, and
  // the OAuth consent flow — no cross-origin CORS, and the OAuth redirect
  // lands back on the same origin. Dev/tests leave webDir unset and run the
  // web app from Vite instead.
  if (deps.webDir && existsSync(join(deps.webDir, "index.html"))) {
    const webDir = deps.webDir;
    const indexHtml = readFileSync(join(webDir, "index.html"), "utf8");
    void app.register(fastifyStatic, { root: webDir, wildcard: false });
    // Client-side routes have no file on disk; serve the SPA shell for browser
    // navigations (Accept: text/html). Everything else 404s as JSON.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && String(req.headers.accept ?? "").includes("text/html")) {
        return reply.type("text/html").send(indexHtml);
      }
      return reply.code(404).send({ error: "not found" });
    });
  }

  return app;
}
