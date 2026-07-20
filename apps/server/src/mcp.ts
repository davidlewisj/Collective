/**
 * MCP server (design-spec §6.2–6.4): the Claude.ai custom-connector surface.
 * Streamable HTTP, stateless (a fresh server+transport per request), same
 * bearer auth as the rest of the API — every tool call executes under the
 * CALLER's identity and is audit-logged. Tool results are ACL-filtered and
 * PHI-flag-gated per the BAA registry (§6.6). Deliberately absent: audio,
 * cross-user notes, writes.
 *
 * Production adds the full OAuth 2.1 resource-server behavior (RFC 9728
 * discovery, RFC 8707 audience binding) in front of this — spec §6.4.
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
  const summaryOk = can(db, user, "read", m, "summary");
  return {
    id: m.id,
    title: m.title,
    createdAt: m.createdAt,
    status: m.status,
    summary: summaryOk ? m.ai?.summary : undefined,
    actionItems: summaryOk ? m.ai?.actionItems : undefined,
  };
}

export function mcpGetTranscript(db: Db, user: User, id: string) {
  const m = db.meetings.get(id);
  if (!m || !visibleViaMcp(db, user, m) || !can(db, user, "read", m, "transcript")) return undefined;
  const utts = db.utterances.get(id) ?? [];
  const name = speakerNameFn(db, utts);
  return utts.map((u) => ({ at: u.startMs, speaker: name(u), text: u.text }));
}

export function mcpGetActionItems(db: Db, user: User) {
  const out: Array<{ meetingId: string; title: string; text: string; assignee?: string; done: boolean }> = [];
  for (const m of db.meetings.values()) {
    if (!visibleViaMcp(db, user, m) || !can(db, user, "read", m, "summary")) continue;
    for (const a of m.ai?.actionItems ?? []) {
      out.push({
        meetingId: m.id,
        title: m.title,
        text: a.text,
        assignee: a.assigneeUserId ? db.users.get(a.assigneeUserId)?.displayName : undefined,
        done: a.done,
      });
    }
  }
  return out;
}

/* -------------------------- transport wiring --------------------------- */

function buildMcpServer(db: Db, audit: AuditLog, user: User): McpServer {
  const server = new McpServer({ name: "collective", version: "0.1.0" });
  const log = (tool: string, detail?: string) =>
    audit.emit({ actorUserId: user.id, action: `mcp.${tool}`, detail });
  const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

  server.tool(
    "search_meetings",
    "Search the caller's accessible meeting archive (titles, summaries, transcripts, own notes). Returns ranked hits with snippets.",
    { query: z.string() },
    async ({ query }) => (log("search_meetings", query), json(mcpSearchMeetings(db, user, query))),
  );
  server.tool(
    "list_meetings",
    "List accessible meetings (titles and dates only).",
    {},
    async () => (log("list_meetings"), json(mcpListMeetings(db, user))),
  );
  server.tool(
    "get_meeting",
    "Fetch one meeting's metadata, summary, and action items — the cheapest sufficient payload.",
    { meetingId: z.string() },
    async ({ meetingId }) => {
      log("get_meeting", meetingId);
      const m = mcpGetMeeting(db, user, meetingId);
      return m ? json(m) : json({ error: "not found or not accessible" });
    },
  );
  server.tool(
    "get_transcript",
    "Fetch a meeting's attributed transcript. Requires transcript access.",
    { meetingId: z.string() },
    async ({ meetingId }) => {
      log("get_transcript", meetingId);
      const t = mcpGetTranscript(db, user, meetingId);
      return t ? json(t) : json({ error: "not found or not accessible" });
    },
  );
  server.tool(
    "get_action_items",
    "List action items across the caller's accessible meetings.",
    {},
    async () => (log("get_action_items"), json(mcpGetActionItems(db, user))),
  );
  return server;
}

export function registerMcp(app: FastifyInstance, deps: AppDeps): void {
  app.post("/mcp", async (req, reply) => {
    // Stateless Streamable HTTP: fresh server + transport per request.
    const server = buildMcpServer(deps.db, deps.audit, req.user);
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
