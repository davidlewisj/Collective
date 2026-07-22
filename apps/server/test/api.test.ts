import { describe, expect, it } from "vitest";
import { auth, login, makeCtx, recordMeeting } from "./helpers.js";

describe("capture lifecycle", () => {
  it("blocks start until the consent policy is satisfied (WA-strict)", async () => {
    const ctx = makeCtx();
    const t = await login(ctx, "dana@collective.dev");
    const create = await ctx.app.inject({
      method: "POST",
      url: "/meetings",
      headers: auth(t),
      payload: { mode: "in_person" },
    });
    const id = create.json().meeting.id;

    const early = await ctx.app.inject({ method: "POST", url: `/meetings/${id}/start`, headers: auth(t) });
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toBe("consent_required");
    expect(early.json().missing).toContain("verbal_announcement_attested");

    await ctx.app.inject({
      method: "POST",
      url: `/meetings/${id}/consent`,
      headers: auth(t),
      payload: { mechanism: "verbal_announcement_attested" },
    });
    const ok = await ctx.app.inject({ method: "POST", url: `/meetings/${id}/start`, headers: auth(t) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().meeting.status).toBe("recording");
  });

  it("runs the full pipeline: transcript, attribution, heuristic title", async () => {
    const ctx = makeCtx();
    ctx.db.baa = { assemblyai: true, claudeWorkspace: true, microsoft: true, voice: true };
    const t = await login(ctx, "dana@collective.dev");
    const id = await recordMeeting(ctx, t);

    const m = (await ctx.app.inject({ method: "GET", url: `/meetings/${id}`, headers: auth(t) })).json();
    expect(m.meeting.title).toBeTruthy(); // untitled → local heuristic (no AI job; D10)
    expect(m.meeting.notice).toBeUndefined();
    expect(m.myLayers).toEqual(["summary", "notes", "transcript", "audio"]);

    const tr = (await ctx.app.inject({ method: "GET", url: `/meetings/${id}/transcript`, headers: auth(t) })).json();
    const bySpeaker = new Map<string, string[]>();
    for (const u of tr.utterances) {
      bySpeaker.set(u.speakerName, [...(bySpeaker.get(u.speakerName) ?? []), u.cluster]);
    }
    // Mic channel is authoritatively the owner (spec §2.3.1 rule 1).
    expect(new Set(bySpeaker.get("Dana Whitfield"))).toEqual(new Set(["MIC"]));
    // "This is Priya" self-introduction cue names cluster A (rule: roster cues).
    expect(new Set(bySpeaker.get("Priya Natarajan"))).toEqual(new Set(["A"]));
    // Cluster B has no self-cue → honest unknown (spec §2.3.4).
    expect(bySpeaker.has("Unknown speaker 1")).toBe(true);
  });

  it("manual correction re-labels a whole voice and is audit-logged", async () => {
    const ctx = makeCtx();
    ctx.db.baa = { assemblyai: true, claudeWorkspace: true, microsoft: true, voice: true };
    const t = await login(ctx, "dana@collective.dev");
    const id = await recordMeeting(ctx, t);
    const tr = (await ctx.app.inject({ method: "GET", url: `/meetings/${id}/transcript`, headers: auth(t) })).json();
    const unknown = tr.utterances.find((u: { speakerName: string }) => u.speakerName.startsWith("Unknown"));

    const fixed = (
      await ctx.app.inject({
        method: "POST",
        url: `/meetings/${id}/utterances/${unknown.id}/speaker`,
        headers: auth(t),
        payload: { userId: "u_omar", scope: "voice" },
      })
    ).json();
    const stillUnknown = fixed.utterances.filter((u: { cluster: string; speakerName: string }) => u.cluster === unknown.cluster && u.speakerName.startsWith("Unknown"));
    expect(stillUnknown).toHaveLength(0);
    expect(ctx.audit.query({ meetingId: id }).some((e) => e.action === "transcript.speaker_corrected")).toBe(true);
  });

  it("objection path deletes audio and transcript but keeps my notes", async () => {
    const ctx = makeCtx();
    const t = await login(ctx, "dana@collective.dev");
    const create = await ctx.app.inject({
      method: "POST",
      url: "/meetings",
      headers: auth(t),
      payload: { mode: "in_person" },
    });
    const id = create.json().meeting.id;
    await ctx.app.inject({
      method: "POST",
      url: `/meetings/${id}/consent`,
      headers: auth(t),
      payload: { mechanism: "verbal_announcement_attested" },
    });
    await ctx.app.inject({ method: "POST", url: `/meetings/${id}/start`, headers: auth(t) });
    await ctx.app.inject({
      method: "PUT",
      url: `/meetings/${id}/notes`,
      headers: auth(t),
      payload: { body: "my typed notes" },
    });

    const res = await ctx.app.inject({ method: "POST", url: `/meetings/${id}/objection`, headers: auth(t) });
    expect(res.json().meeting.audioChunks).toBe(0);
    const note = (await ctx.app.inject({ method: "GET", url: `/meetings/${id}/notes`, headers: auth(t) })).json();
    expect(note.note.body).toBe("my typed notes");
  });
});

describe("sessions", () => {
  it("expires idle sessions (automatic logoff, §164.312(a)(2)(iii))", async () => {
    const ctx = makeCtx();
    const t = await login(ctx, "dana@collective.dev");
    ctx.db.idleMinutes = 0; // immediate idle expiry
    await new Promise((r) => setTimeout(r, 5));
    const res = await ctx.app.inject({ method: "GET", url: "/me", headers: auth(t) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("session_expired");
  });
});
