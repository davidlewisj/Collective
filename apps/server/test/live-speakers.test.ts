import { describe, expect, it } from "vitest";
import { applyLiveAssignments } from "../src/attribution.js";
import type { Utterance } from "@collective/shared";
import { auth, login, makeCtx, type Ctx } from "./helpers.js";

/** Start a recording (consent + start), returning the meeting id. */
async function startRecording(ctx: Ctx, token: string): Promise<string> {
  const create = await ctx.app.inject({
    method: "POST",
    url: "/meetings",
    headers: auth(token),
    payload: { mode: "in_person", attendeeUserIds: ["u_priya", "u_omar"] },
  });
  const id = create.json().meeting.id as string;
  await ctx.app.inject({
    method: "POST",
    url: `/meetings/${id}/consent`,
    headers: auth(token),
    payload: { mechanism: "verbal_announcement_attested" },
  });
  await ctx.app.inject({ method: "POST", url: `/meetings/${id}/start`, headers: auth(token) });
  return id;
}

async function postChunks(ctx: Ctx, token: string, id: string, n: number): Promise<void> {
  for (let seq = 0; seq < n; seq++) {
    await ctx.app.inject({
      method: "POST",
      url: `/meetings/${id}/chunks`,
      headers: auth(token),
      payload: { seq, dataBase64: Buffer.from("audio").toString("base64") },
    });
  }
}

async function stopAndWaitReady(ctx: Ctx, token: string, id: string): Promise<void> {
  await ctx.app.inject({ method: "POST", url: `/meetings/${id}/stop`, headers: auth(token) });
  for (let i = 0; i < 100; i++) {
    const m = await ctx.app.inject({ method: "GET", url: `/meetings/${id}`, headers: auth(token) });
    if (m.json().meeting.status === "ready") return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("never ready");
}

describe("in-session speaker naming (live capture)", () => {
  it("owner names a live cluster; the name lands on the final transcript as manual evidence", async () => {
    const ctx = makeCtx();
    const t = await login(ctx, "dana@collective.dev");
    const id = await startRecording(ctx, t);
    await postChunks(ctx, t, id, 9); // full mock script → live turns recorded per cluster

    // Mid-meeting: the mock script's cluster "B" has no self-introduction cue,
    // so it would end up "Unknown speaker" — name it live instead.
    const res = await ctx.app.inject({
      method: "POST",
      url: `/meetings/${id}/live/speaker`,
      headers: auth(t),
      payload: { cluster: "B", userId: "u_omar" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().speakers).toEqual({ B: "Omar Reyes" });
    expect(ctx.audit.query({ meetingId: id }).some((e) => e.action === "live.speaker_named")).toBe(true);

    await stopAndWaitReady(ctx, t, id);
    const tr = (await ctx.app.inject({ method: "GET", url: `/meetings/${id}/transcript`, headers: auth(t) })).json();
    const bLines = tr.utterances.filter((u: { cluster: string }) => u.cluster === "B");
    expect(bLines.length).toBeGreaterThan(0);
    for (const u of bLines) expect(u.speakerName).toBe("Omar Reyes");
    expect(bLines[0].evidence?.source).toBe("manual");
    expect(ctx.audit.query({ meetingId: id }).some((e) => e.action === "attribution.live_names_applied")).toBe(true);

    // Session-scoped state is cleaned up after the pipeline.
    expect(ctx.db.liveSpeakers.has(id)).toBe(false);
    expect(ctx.db.liveTurns.has(id)).toBe(false);
  });

  it("guest labels work and beat automatic attribution (manual always wins)", async () => {
    const ctx = makeCtx();
    const t = await login(ctx, "dana@collective.dev");
    const id = await startRecording(ctx, t);
    await postChunks(ctx, t, id, 9);
    // Cluster "A" WOULD be auto-attributed to Priya by the "This is Priya"
    // cue — but the facilitator says it's actually a visiting specialist.
    await ctx.app.inject({
      method: "POST",
      url: `/meetings/${id}/live/speaker`,
      headers: auth(t),
      payload: { cluster: "A", guestLabel: "Visiting specialist" },
    });
    await stopAndWaitReady(ctx, t, id);
    const tr = (await ctx.app.inject({ method: "GET", url: `/meetings/${id}/transcript`, headers: auth(t) })).json();
    const aLines = tr.utterances.filter((u: { cluster: string }) => u.cluster === "A");
    for (const u of aLines) expect(u.speakerName).toBe("Visiting specialist");
  });

  it("owner-only, recording-only, and known-user validation", async () => {
    const ctx = makeCtx();
    const dana = await login(ctx, "dana@collective.dev");
    const priya = await login(ctx, "priya@collective.dev");
    const id = await startRecording(ctx, dana);

    const notOwner = await ctx.app.inject({
      method: "POST",
      url: `/meetings/${id}/live/speaker`,
      headers: auth(priya),
      payload: { cluster: "A", userId: "u_omar" },
    });
    expect(notOwner.statusCode).toBe(403);

    const unknownUser = await ctx.app.inject({
      method: "POST",
      url: `/meetings/${id}/live/speaker`,
      headers: auth(dana),
      payload: { cluster: "A", userId: "u_nobody" },
    });
    expect(unknownUser.statusCode).toBe(400);

    await postChunks(ctx, dana, id, 1);
    await stopAndWaitReady(ctx, dana, id);
    const afterStop = await ctx.app.inject({
      method: "POST",
      url: `/meetings/${id}/live/speaker`,
      headers: auth(dana),
      payload: { cluster: "A", userId: "u_omar" },
    });
    expect(afterStop.statusCode).toBe(409); // post-meeting corrections use the transcript endpoint
  });
});

describe("applyLiveAssignments — cluster matching across diarization runs", () => {
  const utt = (cluster: string, text: string, i: number): Utterance => ({
    id: `u${i}`,
    meetingId: "m",
    cluster,
    startMs: i * 1000,
    endMs: i * 1000 + 900,
    text,
    confidence: 0.9,
  });

  it("matches by text overlap when live labels differ from batch labels", async () => {
    // Live diarization called the voice "A"; the batch run called it "S2".
    const batch = [
      utt("S1", "Good morning everyone, welcome to the huddle.", 0),
      utt("S2", "The referral backlog is down to twelve this week.", 1),
      utt("S1", "Great, let's move to intake forms.", 2),
    ];
    const liveTurns = [{ cluster: "A", text: "The referral backlog is down to twelve this week." }];
    const { utterances, appliedClusters } = applyLiveAssignments(batch, { A: { userId: "u_omar" } }, liveTurns);
    expect(appliedClusters).toEqual(["S2"]);
    expect(utterances[1]!.speakerUserId).toBe("u_omar");
    expect(utterances[0]!.speakerUserId).toBeUndefined();
  });

  it("falls back to identical labels when no live turns were recorded", async () => {
    const batch = [utt("B", "Something short.", 0)];
    const { utterances } = applyLiveAssignments(batch, { B: { guestLabel: "Guest" } }, []);
    expect(utterances[0]!.guestLabel).toBe("Guest");
  });

  it("leaves ambiguous matches unknown rather than guessing", async () => {
    // The named live cluster's text appears in NO batch cluster.
    const batch = [utt("X", "Totally different content here.", 0)];
    const liveTurns = [{ cluster: "A", text: "This text matches nothing in the batch run at all." }];
    const { utterances, appliedClusters } = applyLiveAssignments(batch, { A: { userId: "u_omar" } }, liveTurns);
    expect(appliedClusters).toEqual([]);
    expect(utterances[0]!.speakerUserId).toBeUndefined();
  });
});
