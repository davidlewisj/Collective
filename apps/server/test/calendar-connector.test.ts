import { describe, expect, it } from "vitest";
import { eventCovering, parseIcs } from "../src/calendar.js";
import { AuditLog } from "../src/audit.js";
import { buildApp } from "../src/http.js";
import { MockTranscriber } from "../src/adapters/transcriber.js";
import { createDb, seedUsers } from "../src/store.js";
import { auth, login } from "./helpers.js";

const dt = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
};

function icsAroundNow(): string {
  const now = Date.now();
  return [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    `DTSTART:${dt(now - 5 * 60 * 1000)}`,
    `DTEND:${dt(now + 25 * 60 * 1000)}`,
    "SUMMARY:Front desk huddle\\, Monday",
    "ORGANIZER;CN=Dana:mailto:dana@collective.dev",
    "ATTENDEE;CN=Priya Natarajan;RSVP=TRUE:mailto:PRIYA@collective.dev",
    "ATTENDEE;CN=Guest:mailto:guest@elsewhere.org",
    "END:VEVENT",
    "BEGIN:VEVENT",
    `DTSTART:${dt(now + 3 * 3600 * 1000)}`,
    `DTEND:${dt(now + 4 * 3600 * 1000)}`,
    "SUMMARY:Later meeting",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

describe("ICS parsing & matching", () => {
  it("parses folded lines, escapes, and attendee mailtos", () => {
    const events = parseIcs(
      "BEGIN:VEVENT\r\nDTSTART:20260720T170000Z\r\nDTEND:20260720T173000Z\r\nSUMMARY:Split\r\n  across lines\r\nATTENDEE:mailto:a@b.co\r\nEND:VEVENT",
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toBe("Split across lines");
    expect(events[0]!.attendeeEmails).toEqual(["a@b.co"]);
  });

  it("matches the event covering now, preferring the most recent start", () => {
    const now = Date.parse("2026-07-20T17:15:00Z");
    const events = parseIcs(
      [
        "BEGIN:VEVENT",
        "DTSTART:20260720T160000Z\nDTEND:20260720T180000Z\nSUMMARY:Long block",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "DTSTART:20260720T170000Z\nDTEND:20260720T173000Z\nSUMMARY:Standup",
        "END:VEVENT",
      ].join("\n"),
    );
    expect(eventCovering(events, now)?.summary).toBe("Standup");
    // 10-minute pre-start grace window.
    expect(eventCovering(events, Date.parse("2026-07-20T15:55:00Z"))?.summary).toBe("Long block");
    expect(eventCovering(events, Date.parse("2026-07-20T19:00:00Z"))).toBeUndefined();
  });
});

describe("calendar naming on capture create", () => {
  it("names untitled meetings from the current event and maps attendee emails to directory users", async () => {
    const db = createDb();
    seedUsers(db);
    const audit = new AuditLog();
    const app = buildApp({
      db,
      audit,
      transcriber: new MockTranscriber(),
      icsFetcher: async () => icsAroundNow(),
    });
    const ctx = { app, db, audit };
    const t = await login(ctx, "dana@collective.dev");
    db.userSettings.set("u_dana", { calendarIcsUrl: "https://calendar.example/secret.ics" });

    const res = (
      await app.inject({ method: "POST", url: "/meetings", headers: auth(t), payload: { mode: "virtual_desktop" } })
    ).json();
    expect(res.meeting.title).toBe("Front desk huddle, Monday");
    expect(res.meeting.namedFromCalendar).toBe(true);
    expect(res.meeting.attendeeUserIds).toContain("u_priya"); // matched by email, case-insensitive
    expect(res.meeting.attendeeUserIds).not.toContain("u_dana"); // owner never self-listed

    // An explicit title always wins over the calendar.
    const titled = (
      await app.inject({
        method: "POST",
        url: "/meetings",
        headers: auth(t),
        payload: { mode: "in_person", title: "My own name" },
      })
    ).json();
    expect(titled.meeting.title).toBe("My own name");
    expect(titled.meeting.namedFromCalendar).toBeUndefined();
  });

  it("never blocks capture when the feed is broken", async () => {
    const db = createDb();
    seedUsers(db);
    const app = buildApp({
      db,
      audit: new AuditLog(),
      transcriber: new MockTranscriber(),
      icsFetcher: async () => {
        throw new Error("feed down");
      },
    });
    const t = await login({ app, db, audit: new AuditLog() }, "dana@collective.dev");
    db.userSettings.set("u_dana", { calendarIcsUrl: "https://calendar.example/broken.ics" });
    const res = await app.inject({ method: "POST", url: "/meetings", headers: auth(t), payload: { mode: "in_person" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().meeting.title).toBe("");
  });
});

describe("Claude connector tokens", () => {
  it("mints a token that works on /mcp only, and revocation kills it", async () => {
    const db = createDb();
    seedUsers(db);
    db.baa = { assemblyai: true, claudeWorkspace: true, microsoft: true, voice: true };
    const app = buildApp({ db, audit: new AuditLog(), transcriber: new MockTranscriber() });
    const ctx = { app, db, audit: new AuditLog() };
    const t = await login(ctx, "dana@collective.dev");

    const mint = (await app.inject({ method: "POST", url: "/me/connector-token", headers: auth(t) })).json();
    expect(mint.token).toMatch(/^mcp_/);

    const mcpBody = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    };
    const headers = {
      authorization: `Bearer ${mint.token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };
    const ok = await app.inject({ method: "POST", url: "/mcp", headers, payload: mcpBody });
    expect(ok.statusCode).toBe(200);

    // The same token is worthless anywhere else.
    const other = await app.inject({ method: "GET", url: "/meetings", headers: { authorization: `Bearer ${mint.token}` } });
    expect(other.statusCode).toBe(401);

    await app.inject({ method: "DELETE", url: "/me/connector-token", headers: auth(t) });
    const dead = await app.inject({ method: "POST", url: "/mcp", headers, payload: mcpBody });
    expect(dead.statusCode).toBe(401);
  });
});
