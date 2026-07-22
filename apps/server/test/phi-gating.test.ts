import { describe, expect, it } from "vitest";
import { mcpGetMeeting, mcpListMeetings, mcpSearchMeetings } from "../src/mcp.js";
import { auth, login, makeCtx, recordMeeting } from "./helpers.js";

describe("§6.6 — per-meeting PHI flag with BAA-aware egress gating", () => {
  it("fail-safe: an UNANSWERED flag keeps a meeting out of MCP without the workspace BAA", async () => {
    const ctx = makeCtx();
    // Defaults: phiFailSafe=true, registry all false → unanswered == PHI-effective.
    const t = await login(ctx, "dana@collective.dev");
    const id = await recordMeeting(ctx, t);
    const dana = ctx.db.users.get("u_dana")!;
    expect(mcpListMeetings(ctx.db, dana).map((m) => m.id)).not.toContain(id);

    // Sponsor model: fail-safe off → unanswered is treated as non-PHI.
    ctx.db.consentPolicy = { ...ctx.db.consentPolicy, phiFailSafe: false };
    expect(mcpListMeetings(ctx.db, dana).map((m) => m.id)).toContain(id);
  });

  it("MCP excludes PHI-flagged meetings without the Claude workspace BAA and serves them once it's on file", async () => {
    const ctx = makeCtx();
    ctx.db.baa = { assemblyai: true, claudeWorkspace: false, microsoft: true };
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
    expect(mcpGetMeeting(ctx.db, dana, id)?.title).toBeTruthy();

    // Unflagged meetings are fetchable even without the BAA (sponsor model).
    ctx.db.baa = { ...ctx.db.baa, claudeWorkspace: false };
    await ctx.app.inject({ method: "PUT", url: `/meetings/${id}/phi-flag`, headers: auth(t), payload: { flagged: false } });
    expect(mcpListMeetings(ctx.db, dana).map((m) => m.id)).toContain(id);
  });

  it("MCP results are ACL-filtered per caller — no cross-user leakage", async () => {
    const ctx = makeCtx();
    ctx.db.baa = { assemblyai: true, claudeWorkspace: true, microsoft: true };
    const t = await login(ctx, "dana@collective.dev");
    const id = await recordMeeting(ctx, t, { attendees: [] });
    await ctx.app.inject({ method: "PUT", url: `/meetings/${id}/phi-flag`, headers: auth(t), payload: { flagged: false } });
    const omar = ctx.db.users.get("u_omar")!;
    expect(mcpListMeetings(ctx.db, omar).map((m) => m.id)).not.toContain(id);
    expect(mcpGetMeeting(ctx.db, omar, id)).toBeUndefined();
  });
});
