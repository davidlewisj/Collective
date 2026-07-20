import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const API = "http://localhost:4000";
const apiPaths = [
  "/auth",
  "/users",
  "/meetings",
  "/search",
  "/admin",
  "/audit",
  "/memos",
  "/shares",
  "/mcp",
  "/me",
];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@collective/shared": fileURLToPath(
        new URL("../../packages/shared/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    proxy: Object.fromEntries(
      apiPaths.map((p) => [
        p,
        {
          target: API,
          changeOrigin: true,
          ws: true, // live-caption PCM stream (/meetings/:id/stream)
          // Only proxy API calls, never browser page navigations: /admin is
          // both a UI route and an API prefix, and without this bypass a
          // reload on /admin serves the API's JSON as the page. EXCEPTION:
          // the Microsoft OAuth endpoints are real top-level navigations that
          // must reach the server (the sign-in redirect), never the SPA.
          bypass: (req: { url?: string; headers: Record<string, string | string[] | undefined> }) => {
            const path = (req.url ?? "").split("?")[0];
            if (path === "/auth/microsoft" || path === "/auth/callback") return undefined;
            const accept = String(req.headers.accept ?? "");
            if (accept.includes("text/html")) return "/index.html";
            return undefined;
          },
        },
      ]),
    ),
  },
});
