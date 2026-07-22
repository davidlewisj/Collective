import { describe, expect, it } from "vitest";
import { auth, login, makeCtx } from "./helpers.js";

describe("personal bubble color (PUT /me/appearance)", () => {
  it("sets the caller's bubbleHue and exposes it via /users to other viewers", async () => {
    const ctx = makeCtx();
    const dana = await login(ctx, "dana@collective.dev");

    const res = await ctx.app.inject({
      method: "PUT",
      url: "/me/appearance",
      headers: auth(dana),
      payload: { bubbleHue: 3 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.bubbleHue).toBe(3);

    // Another user reading the directory sees it (needed to color bubbles).
    const omar = await login(ctx, "omar@collective.dev");
    const users = (await ctx.app.inject({ method: "GET", url: "/users", headers: auth(omar) })).json().users;
    const danaRow = users.find((u: { id: string }) => u.id === "u_dana");
    expect(danaRow.bubbleHue).toBe(3);

    expect(ctx.audit.query({}).some((e) => e.action === "appearance.updated")).toBe(true);
  });

  it("accepts 0 (accent default) and rejects out-of-range values", async () => {
    const ctx = makeCtx();
    const dana = await login(ctx, "dana@collective.dev");
    expect(
      (await ctx.app.inject({ method: "PUT", url: "/me/appearance", headers: auth(dana), payload: { bubbleHue: 0 } }))
        .statusCode,
    ).toBe(200);
    for (const bad of [-1, 9, 1.5]) {
      const r = await ctx.app.inject({ method: "PUT", url: "/me/appearance", headers: auth(dana), payload: { bubbleHue: bad } });
      expect(r.statusCode, `bubbleHue=${bad}`).toBe(400);
    }
  });
});
