import { describe, expect, it } from "vitest";
import { auth, login, makeCtx, type Ctx } from "./helpers.js";

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

describe("meeting flags (POST /meetings/:id/flags)", () => {
  it("owner flags a moment; it lands on the meeting and is audited", async () => {
    const ctx = makeCtx();
    const dana = await login(ctx, "dana@collective.dev");
    const id = await startRecording(ctx, dana);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/meetings/${id}/flags`,
      headers: auth(dana),
      payload: { atMs: 12000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().flag.atMs).toBe(12000);
    expect(res.json().flag.byUserId).toBe("u_dana");
    expect(res.json().meeting.flags).toHaveLength(1);

    // Visible on the record projection for later transcript rendering.
    const got = await ctx.app.inject({ method: "GET", url: `/meetings/${id}`, headers: auth(dana) });
    expect(got.json().meeting.flags[0].atMs).toBe(12000);
    expect(ctx.audit.query({ meetingId: id }).some((e) => e.action === "meeting.flagged")).toBe(true);
  });

  it("accepts an optional label and keeps flags in order", async () => {
    const ctx = makeCtx();
    const dana = await login(ctx, "dana@collective.dev");
    const id = await startRecording(ctx, dana);
    await ctx.app.inject({ method: "POST", url: `/meetings/${id}/flags`, headers: auth(dana), payload: { atMs: 5000 } });
    await ctx.app.inject({
      method: "POST",
      url: `/meetings/${id}/flags`,
      headers: auth(dana),
      payload: { atMs: 30000, label: "Decision" },
    });
    const flags = (await ctx.app.inject({ method: "GET", url: `/meetings/${id}`, headers: auth(dana) })).json().meeting
      .flags;
    expect(flags.map((f: { atMs: number }) => f.atMs)).toEqual([5000, 30000]);
    expect(flags[1].label).toBe("Decision");
  });

  it("is owner-only and recording-only", async () => {
    const ctx = makeCtx();
    const dana = await login(ctx, "dana@collective.dev");
    const priya = await login(ctx, "priya@collective.dev");
    const id = await startRecording(ctx, dana);

    const notOwner = await ctx.app.inject({
      method: "POST",
      url: `/meetings/${id}/flags`,
      headers: auth(priya),
      payload: { atMs: 1000 },
    });
    expect(notOwner.statusCode).toBe(403);

    await ctx.app.inject({ method: "POST", url: `/meetings/${id}/stop`, headers: auth(dana) });
    const afterStop = await ctx.app.inject({
      method: "POST",
      url: `/meetings/${id}/flags`,
      headers: auth(dana),
      payload: { atMs: 1000 },
    });
    expect(afterStop.statusCode).toBe(409);
  });
});
