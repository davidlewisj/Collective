import { describe, expect, it } from "vitest";
import { buildApp } from "../src/http.js";
import { AuditLog } from "../src/audit.js";
import { MockTranscriber } from "../src/adapters/transcriber.js";
import { createDb, seedUsers } from "../src/store.js";

/** Build an app with a temporary env patch (restored by the returned fn). */
function appWith(patch: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(patch)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const db = createDb();
  seedUsers(db);
  const app = buildApp({ db, audit: new AuditLog(), transcriber: new MockTranscriber() });
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return { app, restore };
}

describe("dev-login lockdown", () => {
  it("disables dev-login on a public deploy and advertises it via /auth/config", async () => {
    const { app, restore } = appWith({ COLLECTIVE_PUBLIC_URL: "https://c.example.com" });
    try {
      expect((await app.inject({ method: "GET", url: "/auth/config" })).json().devLogin).toBe(false);
      const res = await app.inject({
        method: "POST",
        url: "/auth/dev-login",
        payload: { email: "dana@collective.dev" },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      restore();
    }
  });

  it("keeps dev-login working in local dev (nothing configured)", async () => {
    const { app, restore } = appWith({
      COLLECTIVE_PUBLIC_URL: undefined,
      RENDER_EXTERNAL_URL: undefined,
      COLLECTIVE_ALLOW_DEV_LOGIN: undefined,
    });
    try {
      expect((await app.inject({ method: "GET", url: "/auth/config" })).json().devLogin).toBe(true);
      const res = await app.inject({
        method: "POST",
        url: "/auth/dev-login",
        payload: { email: "dana@collective.dev" },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      restore();
    }
  });

  it("re-enables dev-login on a public deploy when explicitly allowed", async () => {
    const { app, restore } = appWith({
      COLLECTIVE_PUBLIC_URL: "https://c.example.com",
      COLLECTIVE_ALLOW_DEV_LOGIN: "1",
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/auth/dev-login",
        payload: { email: "dana@collective.dev" },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      restore();
    }
  });
});
