/**
 * HTTP API (docs/api.md). Compliance rules enforced here and in the services:
 * bearer auth with idle timeout (§2.6.1), consent gate before capture
 * (§2.6.2), per-layer ACL on every read (§2.7.2), audit event on every
 * content access (§2.6.1), PHI flag semantics (§6.6).
 */
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
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
import { consentSatisfied, missingConsent } from "./policy.js";
import {
  LiveHub,
  PipelineDeps,
  liveCaptionOnChunk,
  runPostMeetingPipeline,
  speakerNameFn,
} from "./pipeline.js";
import { search } from "./search.js";
import { Db, newId, userByEmail } from "./store.js";
import { Insight } from "./adapters/insight.js";
import { Transcriber } from "./adapters/transcriber.js";
import { registerMcp } from "./mcp.js";

export interface AppDeps {
  db: Db;
  audit: AuditLog;
  transcriber: Transcriber;
  insight: Insight;
}

declare module "fastify" {
  interface FastifyRequest {
    user: User;
  }
}

function fail(reply: FastifyReply, code: number, error: string): never {
  reply.code(code);
  throw Object.assign(new Error(error), { statusCode: code, handled: true });
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { db, audit } = deps;
  const hub = new LiveHub();
  const audioChunks = new Map<string, Buffer[]>();
  const pipeline: PipelineDeps = {
    ...deps,
    hub,
    audioFor: (id) => Buffer.concat(audioChunks.get(id) ?? []),
  };

  const app = Fastify({ bodyLimit: 25 * 1024 * 1024 });

  app.setErrorHandler((err, _req, reply) => {
    const code = (err as { statusCode?: number }).statusCode ?? 500;
    reply.code(code).send({ error: err.message });
  });

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

  const PUBLIC = new Set(["/auth/dev-login", "/health"]);
  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    if (PUBLIC.has(req.url.split("?")[0]!)) return;
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
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
  app.get("/users", async () => ({
    users: [...db.users.values()].map(({ id, displayName, role, speakerHue }) => ({ id, displayName, role, speakerHue })),
  }));

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
    db.meetings.set(meeting.id, meeting);
    audit.emit({ actorUserId: req.user.id, action: "meeting.create", meetingId: meeting.id });
    return { meeting };
  });

  app.get("/meetings/:id", async (req, reply) => {
    const m = getMeeting(req, reply, (req.params as { id: string }).id);
    audit.emit({ actorUserId: req.user.id, action: "meeting.read", meetingId: m.id, layer: "record" });
    const myLayers = readableLayers(db, req.user, m);
    const view = { ...m };
    if (!myLayers.includes("summary")) view.ai = undefined;
    return { meeting: view, myLayers };
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
    const buf = Buffer.from(dataBase64, "base64");
    const arr = audioChunks.get(m.id) ?? [];
    arr.push(buf);
    audioChunks.set(m.id, arr);
    m.audioChunks = arr.length;
    liveCaptionOnChunk(pipeline, m, seq);
    return { received: arr.length };
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
    // liveCaptions: real vendors transcribe after the meeting (the streaming
    // relay is backlog IN-2); only the mock engine captions live today.
    sink("status", { status: m.status, liveCaptions: deps.transcriber.name === "mock" });
    const unsub = hub.subscribe(m.id, sink);
    req.raw.on("close", unsub);
    return reply; // stream held open
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
    // Re-run transcription + insight from preserved audio — e.g. after the
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
    audioChunks.delete(m.id);
    m.audioChunks = 0;
    db.utterances.delete(m.id);
    m.ai = {
      title: m.title || "Meeting (recording declined)",
      summary: "",
      actionItems: [],
      model: "none",
      generatedAt: new Date().toISOString(),
      skippedReason: "A participant objected — audio and transcript were not kept. Your typed notes are preserved.",
    };
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
    const buf = Buffer.concat(audioChunks.get(m.id) ?? []);
    reply.header("content-type", "audio/webm");
    return reply.send(buf);
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

  app.get("/admin/baa-registry", async (req, reply) => (adminOnly(req, reply), { baa: db.baa }));
  app.put("/admin/baa-registry", async (req, reply) => {
    adminOnly(req, reply);
    db.baa = z
      .object({
        assemblyai: z.boolean(),
        awsBedrock: z.boolean(),
        claudeWorkspace: z.boolean(),
        microsoft: z.boolean(),
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

  registerMcp(app, deps);
  return app;
}
