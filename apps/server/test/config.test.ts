import { describe, expect, it } from "vitest";
import { devLoginAllowed, publicOrigin, webOrigin } from "../src/config.js";
import { oauthConfigFromEnv } from "../src/oauth.js";
import { graphConfigFromEnv } from "../src/msgraph.js";

describe("public-origin resolution", () => {
  it("defaults to localhost in dev", () => {
    expect(publicOrigin({})).toBe("http://localhost:4000");
    expect(webOrigin({})).toBe("http://localhost:5173"); // Vite dev server
  });

  it("auto-detects the host's external URL (e.g. Render) and strips slashes", () => {
    const env = { RENDER_EXTERNAL_URL: "https://collective-xyz.onrender.com/" };
    expect(publicOrigin(env)).toBe("https://collective-xyz.onrender.com");
    // Single-origin: the web app is served from the same place.
    expect(webOrigin(env)).toBe("https://collective-xyz.onrender.com");
  });

  it("lets an explicit COLLECTIVE_PUBLIC_URL win over the host default", () => {
    const env = { COLLECTIVE_PUBLIC_URL: "https://c.example.com", RENDER_EXTERNAL_URL: "https://ignored.onrender.com" };
    expect(publicOrigin(env)).toBe("https://c.example.com");
    expect(webOrigin(env)).toBe("https://c.example.com");
  });

  it("flows into the OAuth issuer/resource and the Graph redirect URI", () => {
    const env = { RENDER_EXTERNAL_URL: "https://c.onrender.com" };
    const oauth = oauthConfigFromEnv(env);
    expect(oauth.issuer).toBe("https://c.onrender.com");
    expect(oauth.resource).toBe("https://c.onrender.com/mcp");
    expect(oauth.webOrigin).toBe("https://c.onrender.com");

    const graph = graphConfigFromEnv({
      ...env,
      GRAPH_TENANT_ID: "t",
      GRAPH_CLIENT_ID: "c",
      GRAPH_CLIENT_SECRET: "s",
    });
    expect(graph?.redirectUri).toBe("https://c.onrender.com/auth/callback");
  });
});

describe("dev-login gate", () => {
  it("is ON in local dev (nothing configured)", () => {
    expect(devLoginAllowed({})).toBe(true);
  });

  it("is OFF on a public deploy (public origin or NODE_ENV=production)", () => {
    expect(devLoginAllowed({ RENDER_EXTERNAL_URL: "https://c.onrender.com" })).toBe(false);
    expect(devLoginAllowed({ COLLECTIVE_PUBLIC_URL: "https://c.example.com" })).toBe(false);
    expect(devLoginAllowed({ NODE_ENV: "production" })).toBe(false);
  });

  it("honors the explicit override either way", () => {
    // Force ON for a test-data staging box that hasn't wired real sign-in yet.
    expect(devLoginAllowed({ RENDER_EXTERNAL_URL: "https://c.onrender.com", COLLECTIVE_ALLOW_DEV_LOGIN: "1" })).toBe(true);
    // Force OFF even in local dev.
    expect(devLoginAllowed({ COLLECTIVE_ALLOW_DEV_LOGIN: "0" })).toBe(false);
  });
});
