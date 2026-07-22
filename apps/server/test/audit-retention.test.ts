import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit.js";
import { runRetentionSweep } from "../src/retention.js";
import { auth, login, makeCtx, recordMeeting } from "./helpers.js";

describe("audit log (spec §2.6.1, §3.3)", () => {
  it("hash chain verifies clean and detects tampering", () => {
    const log = new AuditLog();
    for (let i = 0; i < 5; i++) log.emit({ actorUserId: "u", action: `a${i}` });
    expect(log.verifyChain()).toBe(-1);
    log._unsafeMutate(2, { detail: "tampered" });
    expect(log.verifyChain()).toBe(2);
  });

  it("every content access emits an event; auditor can read, members cannot", async () => {
    const ctx = makeCtx();
    ctx.db.baa = { assemblyai: true, claudeWorkspace: true, microsoft: true };
    const dana = await login(ctx, "dana@collective.dev");
    const id = await recordMeeting(ctx, dana);
    await ctx.app.inject({ method: "GET", url: `/meetings/${id}/transcript`, headers: auth(dana) });
    await ctx.app.inject({ method: "GET", url: `/meetings/${id}/audio`, headers: auth(dana) });

    const casey = await login(ctx, "casey@collective.dev");
    const events = (
      await ctx.app.inject({ method: "GET", url: `/audit?meetingId=${id}`, headers: auth(casey) })
    ).json().events;
    const actions = events.map((e: { action: string }) => e.action);
    for (const expected of ["meeting.create", "consent.recorded", "capture.start", "capture.stop", "meeting.read", "transcript.read", "audio.play"]) {
      expect(actions).toContain(expected);
    }
    const omar = await login(ctx, "omar@collective.dev");
    expect((await ctx.app.inject({ method: "GET", url: "/audit", headers: auth(omar) })).statusCode).toBe(403);
    expect(ctx.audit.verifyChain()).toBe(-1);
  });
});

describe("retention & deletion (spec §2.6.4)", () => {
  it("audio purges at its clock, the record at its clock, and search visibility dies with it", async () => {
    const ctx = makeCtx();
    ctx.db.baa = { assemblyai: true, claudeWorkspace: true, microsoft: true };
    const dana = await login(ctx, "dana@collective.dev");
    const id = await recordMeeting(ctx, dana);
    const DAY = 24 * 60 * 60 * 1000;
    const ended = Date.parse(ctx.db.meetings.get(id)!.endedAt!);

    // Past the audio clock, before the transcript clock.
    let r = runRetentionSweep(ctx.db, ctx.audit, undefined, ended + (ctx.db.retention.audioDays + 1) * DAY);
    expect(r.audioPurged).toBe(1);
    expect(ctx.db.meetings.get(id)!.audioChunks).toBe(0);
    expect(ctx.db.meetings.get(id)!.status).toBe("ready");

    // Past the transcript clock → record deleted, cascade complete.
    r = runRetentionSweep(ctx.db, ctx.audit, undefined, ended + (ctx.db.retention.transcriptDays + 1) * DAY);
    expect(r.recordsDeleted).toBe(1);
    expect(ctx.db.utterances.has(id)).toBe(false);

    const list = (await ctx.app.inject({ method: "GET", url: "/meetings", headers: auth(dana) })).json();
    expect(list.meetings.map((m: { id: string }) => m.id)).not.toContain(id);
    const hits = (await ctx.app.inject({ method: "GET", url: "/search?q=referral", headers: auth(dana) })).json();
    expect(hits.hits).toHaveLength(0);
    const actions = ctx.audit.query({ meetingId: id }).map((e) => e.action);
    expect(actions).toContain("retention.audio_purged");
    expect(actions).toContain("retention.record_deleted");
  });
});
