import { describe, expect, it } from "vitest";
import { auth, login, makeCtx } from "./helpers.js";

const DESKTOP_ORIGIN = "http://127.0.0.1:39241"; // packaged shell's loopback origin

describe("CORS for the packaged desktop shell", () => {
  it("answers preflight for loopback origins without auth", async () => {
    const ctx = makeCtx();
    const res = await ctx.app.inject({
      method: "OPTIONS",
      url: "/meetings",
      headers: {
        origin: DESKTOP_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(DESKTOP_ORIGIN);
    expect(String(res.headers["access-control-allow-headers"])).toContain("authorization");
  });

  it("echoes CORS headers on authenticated cross-origin requests", async () => {
    const ctx = makeCtx();
    const t = await login(ctx, "dana@collective.dev");
    const res = await ctx.app.inject({
      method: "GET",
      url: "/me",
      headers: { ...auth(t), origin: "http://localhost:5173" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("grants nothing to non-loopback origins", async () => {
    const ctx = makeCtx();
    const t = await login(ctx, "dana@collective.dev");
    const res = await ctx.app.inject({
      method: "GET",
      url: "/me",
      headers: { ...auth(t), origin: "https://evil.example.com" },
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
