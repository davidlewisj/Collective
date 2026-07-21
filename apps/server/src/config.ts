/**
 * Public-origin resolution, shared by the OAuth issuer, the MCP resource URL,
 * the consent-page redirect, and the Microsoft callback.
 *
 * Precedence: an explicit COLLECTIVE_PUBLIC_URL always wins; otherwise, on a
 * host that advertises its own external URL (Render sets RENDER_EXTERNAL_URL),
 * use that — so a container deploy is zero-config; otherwise fall back to
 * localhost for dev. Keeping this in one place means the whole app agrees on
 * "what is my public origin" without the operator setting the same URL three
 * times.
 */
const strip = (s: string): string => s.replace(/\/+$/, "");

/** This server's public origin — the OAuth issuer and MCP resource host. */
export function publicOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return strip(env.COLLECTIVE_PUBLIC_URL ?? env.RENDER_EXTERNAL_URL ?? `http://localhost:${env.PORT ?? 4000}`);
}

/**
 * Where the browser-facing web app lives. In single-origin deploys this equals
 * publicOrigin; in local dev (nothing set) it's the Vite dev server. An
 * explicit WEB_ORIGIN overrides.
 */
export function webOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return strip(
    env.WEB_ORIGIN ?? env.COLLECTIVE_PUBLIC_URL ?? env.RENDER_EXTERNAL_URL ?? "http://localhost:5173",
  );
}
