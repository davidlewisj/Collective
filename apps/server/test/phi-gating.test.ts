import { describe, expect, it } from "vitest";
import { mcpGetMeeting, mcpListMeetings, mcpSearchMeetings } from "../src/mcp.js";
import { auth, login, makeCtx, recordMeeting } from "./helpers.js";

describe("§6.6 — per-meeting PHI flag with BAA-aware egress gating", () => {
  it("insight job is skipped when PHI-effective and no Bedrock BAA on file", async () => {
    const ctx = makeCtx();
    // Defaults: phiFailSafe=true, all BAAs false → unanswered flag == PHI-effective.
    const t = await login(ctx, "dana@collective.dev");
    const id = await recordMeeting(ctx, t);
    const m = (await ctx.app.inject({ method: "GET", url: `/meetings/${id}`, headers: auth(t) })).json();
    expect(m.meeting.ai.skippedReason).toContain("patient info");
    expect(m.meeting.ai.summary).toBe("");
    expect(ctx.audit.query({ meetingId: id }).some((e) => e.action === "insight.skipped_phi_gate")).toBe(true);
  });

  it("explicit non-PHI flag lets insight run without any BAA (sponsor model)", async () => {
    const ctx = makeCtx();
    const t = await login(ctx, "dana@collective.dev");
    // fail-safe on, but the facilitator answers "No" → not PHI-effective.
    const create = await ctx.app.inject({
      method: "POST",
      url: "/meetings",
      headers: auth(t),
      payload: { mode: "virtual_desktop", attendeeUserIds: ["u_priya", "u_omar"] },
    });
    const id = create.json().meeting.id;
    await ctx.app.inject({ method: "PUT", url: `/meetings/${id}/phi-flag`, headers: auth(t), payload: { flagged: false } });
    await ctx.app.inject({
      method: "POST",
      url: `/meetings/${id}/consent`,
      headers: auth(t),
      payload: { mechanism: "verbal_announcement_attested" },
    });
    await ctx.app.inject({ method: "POST", url: `/meetings/${id}/start`, headers: auth(t) });
    await ctx.app.inject({
      method: "POST",
      url: `/meetings/${id}/chunks`,
      headers: auth(t),
      payload: { seq: 0, dataBase64: Buffer.from("a").toString("base64") },
    });
    await ctx.app.inject({ method: "POST", url: `/meetings/${id}/stop`, headers: auth(t) });
    for (let i = 0; i < 100; i++) {
      const m = await ctx.app.inject({ method: "GET", url: `/meetings/${id}`, headers: auth(t) });
      if (m.json().meeting.status === "ready") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const m = (await ctx.app.inject({ method: "GET", url: `/meetings/${id}`, headers: auth(t) })).json();
    expect(m.meeting.ai.skippedReason).toBeUndefined();
    expect(m.meeting.ai.summary).not.toBe("");
  });

  it("MCP excludes PHI-flagged meetings without the Claude workspace BAA and serves them once it's on file", async () => {
    const ctx = makeCtx();
    ctx.db.baa = { assemblyai: true, awsBedrock: true, claudeWorkspace: false, microsoft: true };
    const t = await login(ctx, "dana@collective.dev");
    const id = await recordMeeting(ctx, t);
    const dana = ctx.db.users.get("u_dana")!;

    // Flag as PHI → excluded from every MCP surface.
    await ctx.app.inject({ method: "PUT", url: `/meetings/${id}/phi-flag`, headers: auth(t), payload: { flagged: true } });
    expect(mcpListMeetings(ctx.db, dana).map((m) => m.id)).not.toContain(id);
    expect(mcpSearchMeetings(ctx.db, dana, "referral").map((h) => h.meetingId)).not.toContain(id);
    expect(mcpGetMeeting(ctx.db, dana, id)).toBeUndefined();

    // Workspace BAA lands → same meeting is served (registry flip, no code change).
    ctx.db.baa = { ...ctx.db.baa, claudeWorkspace: true };
    expect(mcpListMeetings(ctx.db, dana).map((m) => m.id)).toContain(id);
    expect(mcpGetMeeting(ctx.db, dana, id)?.summary).toBeDefined();

    // Unflagged meetings are fetchable even without the BAA (sponsor model).
    ctx.db.baa = { ...ctx.db.baa, claudeWorkspace: false };
    await ctx.app.inject({ method: "PUT", url: `/meetings/${id}/phi-flag`, headers: auth(t), payload: { flagged: false } });
    expect(mcpListMeetings(ctx.db, dana).map((m) => m.id)).toContain(id);
  });

  it("MCP results are ACL-filtered per caller — no cross-user leakage", async () => {
    const ctx = makeCtx();
    ctx.db.baa = { assemblyai: true, awsBedrock: true, claudeWorkspace: true, microsoft: true };
    const t = await login(ctx, "dana@collective.dev");
    const id = await recordMeeting(ctx, t, { attendees: [] });
    await ctx.app.inject({ method: "PUT", url: `/meetings/${id}/phi-flag`, headers: auth(t), payload: { flagged: false } });
    const omar = ctx.db.users.get("u_omar")!;
    expect(mcpListMeetings(ctx.db, omar).map((m) => m.id)).not.toContain(id);
    expect(mcpGetMeeting(ctx.db, omar, id)).toBeUndefined();
  });
});
