import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit.js";
import { buildApp } from "../src/http.js";
import { MockInsight } from "../src/adapters/insight.js";
import { MockTranscriber } from "../src/adapters/transcriber.js";
import { OAuthProvider } from "../src/oauth.js";
import { createDb, seedUsers } from "../src/store.js";

/** A minimal built-web fixture (index.html + one hashed asset). */
function fixtureWebDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "collective-web-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Collective</title><div id=root>SPA_SHELL</div>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log('app')");
  return dir;
}

function makeCtx() {
  const db = createDb();
  seedUsers(db);
  const audit = new AuditLog();
  const oauth = new OAuthProvider(db, audit, {
    issuer: "http://localhost:4000",
    resource: "http://localhost:4000/mcp",
    webOrigin: "http://localhost:4000",
  });
  const app = buildApp({
    db,
    audit,
    transcriber: new MockTranscriber(),
    insight: new MockInsight(),
    oauth,
    webDir: fixtureWebDir(),
    webOrigin: "http://localhost:4000",
  });
  return { app };
}

const html = { accept: "text/html,application/xhtml+xml" };
const jsonHdr = { accept: "application/json" };

describe("single-origin web serving (deploy topology)", () => {
  it("serves the SPA shell at the root and for client-side routes", async () => {
    const { app } = makeCtx();
    for (const url of ["/", "/login", "/connect", "/settings", "/m/mtg_1"]) {
      const res = await app.inject({ method: "GET", url, headers: html });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body, url).toContain("SPA_SHELL");
    }
  });

  it("serves hashed static assets without auth", async () => {
    const { app } = makeCtx();
    const res = await app.inject({ method: "GET", url: "/assets/app-abc123.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("console.log");
  });

  it("serves the SPA page at /admin but still guards the admin API", async () => {
    const { app } = makeCtx();
    const page = await app.inject({ method: "GET", url: "/admin", headers: html });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("SPA_SHELL");

    const api = await app.inject({ method: "GET", url: "/admin/baa-registry", headers: jsonHdr });
    expect(api.statusCode).toBe(401); // no bearer → still denied
  });

  it("keeps the API and discovery reachable on the same origin", async () => {
    const { app } = makeCtx();
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/meetings", headers: jsonHdr })).statusCode).toBe(401);
    const disc = await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource" });
    expect(disc.statusCode).toBe(200);
    expect(disc.json().resource).toBe("http://localhost:4000/mcp");
  });

  it("404s unknown non-HTML requests as JSON (not the SPA)", async () => {
    const { app } = makeCtx();
    const res = await app.inject({ method: "GET", url: "/nope.json", headers: jsonHdr });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
  });
});
