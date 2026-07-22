/**
 * MCP server (design-spec §6.2–6.4): the Claude.ai custom-connector surface,
 * and — since D10 removed the backend summary job — the ONLY way summaries,
 * action items, and archive Q&A happen: the user asks their own Claude, which
 * reads the transcript and the caller's own notes through these tools.
 *
 * Streamable HTTP, stateless (a fresh server+transport per request). Every
 * tool call executes under the CALLER's identity and is audit-logged. Tool
 * results are ACL-filtered and PHI-flag-gated per the BAA registry (§6.6).
 * Deliberately absent: audio, cross-user notes, writes.
 *
 * Auth: OAuth 2.1 resource server (oauth.ts) / connector token / session.
 */
import { FastifyInstance } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { Meeting, User } from "@collective/shared";
import { AuditLog } from "./audit.js";
import { can, canSeeRecord } from "./rbac.js";
import { mcpEgressAllowed } from "./policy.js";
import { speakerNameFn } from "./pipeline.js";
import { search } from "./search.js";
import { Db } from "./store.js";
import type { AppDeps } from "./http.js";

/* ---------- tool logic (plain functions so tests hit them directly) ---- */

function visibleViaMcp(db: Db, user: User, m: Meeting): boolean {
  return m.status !== "deleted" && canSeeRecord(db, user, m) && mcpEgressAllowed(db, m);
}

export function mcpListMeetings(db: Db, user: User) {
  return [...db.meetings.values()]
    .filter((m) => visibleViaMcp(db, user, m))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((m) => ({ id: m.id, title: m.title || "Untitled", createdAt: m.createdAt, status: m.status }));
}

export function mcpSearchMeetings(db: Db, user: User, q: string) {
  return search(db, user, q).filter((h) => {
    const m = db.meetings.get(h.meetingId);
    return m && mcpEgressAllowed(db, m);
  });
}

export function mcpGetMeeting(db: Db, user: User, id: string) {
  const m = db.meetings.get(id);
  if (!m || !visibleViaMcp(db, user, m)) return undefined;
  const names = (ids: string[]) =>
    ids.map((uid) => db.users.get(uid)?.displayName).filter((n): n is string => !!n);
  return {
    id: m.id,
    title: m.title,
    createdAt: m.createdAt,
    startedAt: m.startedAt,
    endedAt: m.endedAt,
    status: m.status,
    owner: names([m.ownerUserId])[0],
    attendees: names(m.attendeeUserIds),
    notice: m.notice,
  };
}

export function mcpGetTranscript(db: Db, user: User, id: string) {
  const m = db.meetings.get(id);
  if (!m || !visibleViaMcp(db, user, m) || !can(db, user, "read", m, "transcript")) return undefined;
  const utts = db.utterances.get(id) ?? [];
  const name = speakerNameFn(db, utts);
  return utts.map((u) => ({ at: u.startMs, speaker: name(u), text: u.text }));
}

/** The CALLER's own note for a meeting — never anyone else's (spec §2.4). */
export function mcpGetNote(db: Db, user: User, id: string) {
  const m = db.meetings.get(id);
  if (!m || !visibleViaMcp(db, user, m)) return undefined;
  const note = db.notes.get(`${id}:${user.id}`);
  return note ? { body: note.body, updatedAt: note.updatedAt } : { body: "", updatedAt: null };
}

/* -------------------------- transport wiring --------------------------- */

/** Read tier each tool requires, mapped to an OAuth scope (spec §6.4). */
export const TOOL_SCOPE: Record<string, string> = {
  search_meetings: "meetings.search",
  list_meetings: "meetings.read",
  get_meeting: "meetings.read",
  get_transcript: "transcripts.read",
  get_notes: "meetings.read",
};

/** Whether a granted scope set permits a given MCP tool. */
export function hasToolScope(scopes: string[], tool: string): boolean {
  const required = TOOL_SCOPE[tool];
  return required ? scopes.includes(required) : false;
}

function buildMcpServer(db: Db, audit: AuditLog, user: User, scopes: string[]): McpServer {
  const server = new McpServer({ name: "collective", version: "0.1.0" });
  const log = (tool: string, detail?: string) =>
    audit.emit({ actorUserId: user.id, action: `mcp.${tool}`, detail });
  const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
  // Scope check is defense-in-depth in front of the per-caller ACL — a token
  // granted only meetings.search can never reach transcript text, even for
  // meetings the user could otherwise open.
  const denied = (tool: string) =>
    json({ error: "insufficient_scope", required: TOOL_SCOPE[tool] });
  const has = (tool: string) => hasToolScope(scopes, tool);

  server.tool(
    "search_meetings",
    "Search the caller's accessible meeting archive (titles, summaries, transcripts, own notes). Returns ranked hits with snippets.",
    { query: z.string() },
    async ({ query }) => {
      if (!has("search_meetings")) return denied("search_meetings");
      return log("search_meetings", query), json(mcpSearchMeetings(db, user, query));
    },
  );
  server.tool(
    "list_meetings",
    "List accessible meetings (titles and dates only).",
    {},
    async () => {
      if (!has("list_meetings")) return denied("list_meetings");
      return log("list_meetings"), json(mcpListMeetings(db, user));
    },
  );
  server.tool(
    "get_meeting",
    "Fetch one meeting's metadata: title, times, owner, attendees. Use get_transcript + get_notes for content to summarize.",
    { meetingId: z.string() },
    async ({ meetingId }) => {
      if (!has("get_meeting")) return denied("get_meeting");
      log("get_meeting", meetingId);
      const m = mcpGetMeeting(db, user, meetingId);
      return m ? json(m) : json({ error: "not found or not accessible" });
    },
  );
  server.tool(
    "get_transcript",
    "Fetch a meeting's speaker-attributed transcript — the primary source for summaries, action items, and answers. Requires transcript access.",
    { meetingId: z.string() },
    async ({ meetingId }) => {
      if (!has("get_transcript")) return denied("get_transcript");
      log("get_transcript", meetingId);
      const t = mcpGetTranscript(db, user, meetingId);
      return t ? json(t) : json({ error: "not found or not accessible" });
    },
  );
  server.tool(
    "get_notes",
    "Fetch the caller's OWN typed notes for a meeting (never anyone else's). Combine with the transcript when summarizing.",
    { meetingId: z.string() },
    async ({ meetingId }) => {
      if (!has("get_notes")) return denied("get_notes");
      log("get_notes", meetingId);
      const n = mcpGetNote(db, user, meetingId);
      return n ? json(n) : json({ error: "not found or not accessible" });
    },
  );
  return server;
}

export function registerMcp(app: FastifyInstance, deps: AppDeps): void {
  app.post("/mcp", async (req, reply) => {
    // Stateless Streamable HTTP: fresh server + transport per request.
    const scopes = req.mcpScopes ?? [];
    const server = buildMcpServer(deps.db, deps.audit, req.user, scopes);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    req.raw.on("close", () => void transport.close());
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  const notAllowed = async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.code(405).send({ error: "stateless MCP: POST only" });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
}
