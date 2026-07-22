import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { auth, login, makeCtx, recordMeeting, type Ctx } from "./helpers.js";

const sample = { audioBase64: Buffer.from("voice-sample").toString("base64"), consent: true as const };

function enroll(ctx: Ctx, token: string, body: Record<string, unknown> = sample): Promise<LightMyRequestResponse> {
  return ctx.app.inject({ method: "POST", url: "/me/voiceprint", headers: auth(token), payload: body });
}

/** Cluster "B" in the mock transcript script is Omar (addressed by name). */
function clusterBUtterances(tr: { utterances: Array<{ cluster: string; speakerUserId?: string; evidence?: { source: string } }> }) {
  return tr.utterances.filter((u) => u.cluster === "B");
}

describe("voiceprint enrollment", () => {
  it("requires explicit consent + a sample, then reports enrolled and audits it", async () => {
    const ctx = makeCtx();
    const omar = await login(ctx, "omar@collective.dev");

    expect((await enroll(ctx, omar, { audioBase64: "x" })).statusCode).toBe(400); // no consent
    expect((await enroll(ctx, omar, { consent: true })).statusCode).toBe(400); // no sample

    const res = await enroll(ctx, omar);
    expect(res.statusCode).toBe(200);
    expect(res.json().enrolled).toBe(true);

    const status = await ctx.app.inject({ method: "GET", url: "/me/voiceprint", headers: auth(omar) });
    expect(status.json().enrolled).toBe(true);

    const ev = ctx.audit.query({}).find((e) => e.action === "voiceprint.enrolled");
    expect(ev).toBeTruthy();
    // The embedding is biometric — never in the audit trail.
    expect(ev?.detail).toBe("vendor=mock");
  });

  it("lets the caller delete their voiceprint (biometric right-to-delete)", async () => {
    const ctx = makeCtx();
    const omar = await login(ctx, "omar@collective.dev");
    await enroll(ctx, omar);
    const del = await ctx.app.inject({ method: "DELETE", url: "/me/voiceprint", headers: auth(omar) });
    expect(del.json().enrolled).toBe(false);
    expect(ctx.audit.query({}).some((e) => e.action === "voiceprint.deleted")).toBe(true);
  });
});

describe("voiceprint attribution (cross-meeting)", () => {
  it("attributes a voice to the enrolled user in a later meeting", async () => {
    const ctx = makeCtx();
    const dana = await login(ctx, "dana@collective.dev");
    const omar = await login(ctx, "omar@collective.dev");

    // Omar enrolls once...
    await enroll(ctx, omar);

    // ...then Dana runs a (separate) meeting; the mock's cluster "B" is Omar.
    const id = await recordMeeting(ctx, dana, { attendees: ["u_priya", "u_omar"] });
    const tr = (await ctx.app.inject({ method: "GET", url: `/meetings/${id}/transcript`, headers: auth(dana) })).json();

    const bLines = clusterBUtterances(tr);
    expect(bLines.length).toBeGreaterThan(0);
    for (const u of bLines) {
      expect(u.speakerUserId).toBe("u_omar");
      expect(u.evidence?.source).toBe("voice_profile");
    }
    expect(ctx.audit.query({ meetingId: id }).some((e) => e.action === "attribution.voice_matched")).toBe(true);
  });

  it("leaves the voice unknown when nobody is enrolled (no false positives)", async () => {
    const ctx = makeCtx();
    const dana = await login(ctx, "dana@collective.dev");
    const id = await recordMeeting(ctx, dana, { attendees: ["u_priya", "u_omar"] });
    const tr = (await ctx.app.inject({ method: "GET", url: `/meetings/${id}/transcript`, headers: auth(dana) })).json();
    for (const u of clusterBUtterances(tr)) {
      expect(u.speakerUserId).toBeUndefined();
    }
  });
});
