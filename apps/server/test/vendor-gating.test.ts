import { describe, expect, it } from "vitest";
import { Meeting, Utterance } from "@collective/shared";
import { Transcriber } from "../src/adapters/transcriber.js";
import { auth, login, makeCtx } from "./helpers.js";

/** Stands in for the real AssemblyAI adapter: counts calls, returns one line. */
class FakeVendorTranscriber implements Transcriber {
  readonly name = "assemblyai";
  calls = 0;

  async transcribe(meeting: Meeting): Promise<Utterance[]> {
    this.calls++;
    return [
      {
        id: `utt_fake_${this.calls}`,
        meetingId: meeting.id,
        cluster: "MIC",
        startMs: 0,
        endMs: 2000,
        text: "Real vendor transcription line.",
        confidence: 0.95,
      },
    ];
  }

  async transcribeMemoSync(): Promise<string> {
    return "memo";
  }
}

async function captureToReady(ctx: ReturnType<typeof makeCtx>, token: string): Promise<string> {
  const create = await ctx.app.inject({
    method: "POST",
    url: "/meetings",
    headers: auth(token),
    payload: { mode: "virtual_desktop", attendeeUserIds: [] },
  });
  const id = create.json().meeting.id as string;
  await ctx.app.inject({
    method: "POST",
    url: `/meetings/${id}/consent`,
    headers: auth(token),
    payload: { mechanism: "verbal_announcement_attested" },
  });
  await ctx.app.inject({ method: "POST", url: `/meetings/${id}/start`, headers: auth(token) });
  await ctx.app.inject({
    method: "POST",
    url: `/meetings/${id}/chunks`,
    headers: auth(token),
    payload: { seq: 0, dataBase64: Buffer.from("audio").toString("base64") },
  });
  await ctx.app.inject({ method: "POST", url: `/meetings/${id}/stop`, headers: auth(token) });
  for (let i = 0; i < 100; i++) {
    const m = await ctx.app.inject({ method: "GET", url: `/meetings/${id}`, headers: auth(token) });
    if (m.json().meeting.status === "ready") return id;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("never ready");
}

describe("transcription vendor gating (§6.6 / CP-1 invariant)", () => {
  it("blocks a real vendor for PHI-effective meetings without the AssemblyAI BAA, then reprocesses after the registry flips", async () => {
    const vendor = new FakeVendorTranscriber();
    const ctx = makeCtx({ transcriber: vendor });
    // Defaults: phiFailSafe on, registry all false → unanswered = PHI-effective.
    const t = await login(ctx, "dana@collective.dev");
    const id = await captureToReady(ctx, t);

    // Audio never left the building.
    expect(vendor.calls).toBe(0);
    const view = (await ctx.app.inject({ method: "GET", url: `/meetings/${id}`, headers: auth(t) })).json();
    expect(view.meeting.ai.skippedReason).toContain("no AssemblyAI BAA");
    expect(view.meeting.audioChunks).toBeGreaterThan(0); // preserved for reprocessing
    expect(ctx.audit.query({ meetingId: id }).some((e) => e.action === "transcription.skipped_phi_gate")).toBe(true);

    // BAA recorded in the registry → reprocess → vendor runs, transcript lands.
    ctx.db.baa = { assemblyai: true, awsBedrock: true, claudeWorkspace: true, microsoft: true };
    await ctx.app.inject({ method: "POST", url: `/meetings/${id}/reprocess`, headers: auth(t) });
    for (let i = 0; i < 100; i++) {
      const m = await ctx.app.inject({ method: "GET", url: `/meetings/${id}`, headers: auth(t) });
      if (m.json().meeting.status === "ready" && !m.json().meeting.ai?.skippedReason) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(vendor.calls).toBe(1);
    const tr = (await ctx.app.inject({ method: "GET", url: `/meetings/${id}/transcript`, headers: auth(t) })).json();
    expect(tr.utterances).toHaveLength(1);
    expect(tr.utterances[0].speakerName).toBe("Dana Whitfield"); // MIC channel attribution survives reprocess
  });

  it("lets a real vendor transcribe explicitly non-PHI meetings without any BAA (sponsor model)", async () => {
    const vendor = new FakeVendorTranscriber();
    const ctx = makeCtx({ transcriber: vendor });
    const t = await login(ctx, "dana@collective.dev");
    const create = await ctx.app.inject({
      method: "POST",
      url: "/meetings",
      headers: auth(t),
      payload: { mode: "virtual_desktop", attendeeUserIds: [] },
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
    expect(vendor.calls).toBe(1);
  });

  it("reprocess is owner-only and requires preserved audio", async () => {
    const ctx = makeCtx();
    ctx.db.baa = { assemblyai: true, awsBedrock: true, claudeWorkspace: true, microsoft: true };
    const dana = await login(ctx, "dana@collective.dev");
    const id = await captureToReady(ctx, dana);
    const omar = await login(ctx, "omar@collective.dev");
    const res = await ctx.app.inject({ method: "POST", url: `/meetings/${id}/reprocess`, headers: auth(omar) });
    expect([403, 404]).toContain(res.statusCode);
  });
});
