import { describe, expect, it } from "vitest";
import { auth, login, makeCtx, recordMeeting } from "./helpers.js";

const ALL_BAA = { assemblyai: true, claudeWorkspace: true, microsoft: true, voice: true };

describe("RBAC — deny by default (spec §2.6.1, §2.7.2)", () => {
  it("attendees see the record exists but no content layers until shared", async () => {
    const ctx = makeCtx();
    ctx.db.baa = ALL_BAA;
    const dana = await login(ctx, "dana@collective.dev");
    const priya = await login(ctx, "priya@collective.dev");
    const id = await recordMeeting(ctx, dana);

    const view = (await ctx.app.inject({ method: "GET", url: `/meetings/${id}`, headers: auth(priya) })).json();
    expect(view.myLayers).toEqual([]); // no summary/transcript/audio
    expect(view.meeting.ai).toBeUndefined(); // summary stripped from payload

    const tr = await ctx.app.inject({ method: "GET", url: `/meetings/${id}/transcript`, headers: auth(priya) });
    expect(tr.statusCode).toBe(403);
    const au = await ctx.app.inject({ method: "GET", url: `/meetings/${id}/audio`, headers: auth(priya) });
    expect(au.statusCode).toBe(403);
  });

  it("non-attendees cannot even see the record", async () => {
    const ctx = makeCtx();
    ctx.db.baa = ALL_BAA;
    const dana = await login(ctx, "dana@collective.dev");
    const omar = await login(ctx, "omar@collective.dev");
    const id = await recordMeeting(ctx, dana, { attendees: ["u_priya"] });
    const res = await ctx.app.inject({ method: "GET", url: `/meetings/${id}`, headers: auth(omar) });
    expect(res.statusCode).toBe(404);
    const list = (await ctx.app.inject({ method: "GET", url: "/meetings", headers: auth(omar) })).json();
    expect(list.meetings.map((m: { id: string }) => m.id)).not.toContain(id);
  });

  it("a transcript share does NOT grant audio (audio is a distinct permission)", async () => {
    const ctx = makeCtx();
    ctx.db.baa = ALL_BAA;
    const dana = await login(ctx, "dana@collective.dev");
    const priya = await login(ctx, "priya@collective.dev");
    const id = await recordMeeting(ctx, dana);
    await ctx.app.inject({
      method: "POST",
      url: `/meetings/${id}/shares`,
      headers: auth(dana),
      payload: { layer: "transcript", granteeUserId: "u_priya", permission: "view" },
    });
    expect((await ctx.app.inject({ method: "GET", url: `/meetings/${id}/transcript`, headers: auth(priya) })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: `/meetings/${id}/audio`, headers: auth(priya) })).statusCode).toBe(403);
  });

  it("org_admin gets no implicit content access (minimum necessary)", async () => {
    const ctx = makeCtx();
    ctx.db.baa = ALL_BAA;
    const omar = await login(ctx, "omar@collective.dev");
    const id = await recordMeeting(ctx, omar, { attendees: ["u_priya"] });
    const dana = await login(ctx, "dana@collective.dev"); // org_admin, not an attendee
    const res = await ctx.app.inject({ method: "GET", url: `/meetings/${id}`, headers: auth(dana) });
    expect(res.statusCode).toBe(404);
  });

  it("compliance auditor reads everything but cannot edit", async () => {
    const ctx = makeCtx();
    ctx.db.baa = ALL_BAA;
    const omar = await login(ctx, "omar@collective.dev");
    const casey = await login(ctx, "casey@collective.dev");
    const id = await recordMeeting(ctx, omar, { attendees: [] });
    expect((await ctx.app.inject({ method: "GET", url: `/meetings/${id}/transcript`, headers: auth(casey) })).statusCode).toBe(200);
    const phi = await ctx.app.inject({
      method: "PUT",
      url: `/meetings/${id}/phi-flag`,
      headers: auth(casey),
      payload: { flagged: true },
    });
    expect(phi.statusCode).toBe(403);
  });
});

describe("sharing & revocation (spec §2.7.2)", () => {
  it("share grants exactly one layer; revocation removes visibility incl. search, immediately", async () => {
    const ctx = makeCtx();
    ctx.db.baa = ALL_BAA;
    const dana = await login(ctx, "dana@collective.dev");
    const priya = await login(ctx, "priya@collective.dev");
    const id = await recordMeeting(ctx, dana, { attendees: [] });

    const share = (
      await ctx.app.inject({
        method: "POST",
        url: `/meetings/${id}/shares`,
        headers: auth(dana),
        payload: { layer: "transcript", granteeUserId: "u_priya", permission: "view" },
      })
    ).json().share;

    const before = (await ctx.app.inject({ method: "GET", url: "/search?q=referral", headers: auth(priya) })).json();
    expect(before.hits.some((h: { meetingId: string }) => h.meetingId === id)).toBe(true);

    await ctx.app.inject({ method: "DELETE", url: `/shares/${share.id}`, headers: auth(dana) });

    const after = (await ctx.app.inject({ method: "GET", url: "/search?q=referral", headers: auth(priya) })).json();
    expect(after.hits.some((h: { meetingId: string }) => h.meetingId === id)).toBe(false);
    expect((await ctx.app.inject({ method: "GET", url: `/meetings/${id}`, headers: auth(priya) })).statusCode).toBe(404);
  });

  it("notes are never shared implicitly and never searchable by others", async () => {
    const ctx = makeCtx();
    ctx.db.baa = ALL_BAA;
    const dana = await login(ctx, "dana@collective.dev");
    const priya = await login(ctx, "priya@collective.dev");
    const id = await recordMeeting(ctx, dana); // priya is an attendee
    await ctx.app.inject({
      method: "PUT",
      url: `/meetings/${id}/notes`,
      headers: auth(priya),
      payload: { body: "private thought: zebra medication question" },
    });
    // Owner cannot read priya's note...
    const ownersView = (await ctx.app.inject({ method: "GET", url: `/meetings/${id}/notes`, headers: auth(dana) })).json();
    expect(ownersView.note?.body ?? "").not.toContain("zebra");
    // ...and owner's search never hits it.
    const hits = (await ctx.app.inject({ method: "GET", url: "/search?q=zebra", headers: auth(dana) })).json();
    expect(hits.hits).toHaveLength(0);
    // Priya's own search does.
    const own = (await ctx.app.inject({ method: "GET", url: "/search?q=zebra", headers: auth(priya) })).json();
    expect(own.hits.some((h: { layer: string }) => h.layer === "notes")).toBe(true);
  });
});
