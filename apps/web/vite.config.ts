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
    proxy: Object.fromEntries(apiPaths.map((p) => [p, { target: API, changeOrigin: true }])),
  },
});
