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

/**
 * Dev-login (`POST /auth/dev-login`) is a passwordless "sign in as any known
 * user" shortcut for local dev and tests. It must never be reachable on a
 * public deployment. Default: ON in local dev, OFF whenever the deploy looks
 * public (a public origin is configured, or NODE_ENV=production). An explicit
 * `COLLECTIVE_ALLOW_DEV_LOGIN` forces it either way — set `=1` to keep it on a
 * test-data-only staging box that hasn't wired up real sign-in yet.
 */
export function devLoginAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env.COLLECTIVE_ALLOW_DEV_LOGIN?.trim().toLowerCase();
  if (explicit === "1" || explicit === "true") return true;
  if (explicit === "0" || explicit === "false") return false;
  const looksPublic =
    !!(env.COLLECTIVE_PUBLIC_URL || env.RENDER_EXTERNAL_URL) || env.NODE_ENV === "production";
  return !looksPublic;
}

/**
 * The email that bootstraps the org's first admin. The matching Microsoft
 * sign-in is provisioned (or promoted) to an active `org_admin`; without it a
 * fresh production directory would have no admin to approve anyone. Normalized
 * to lowercase; empty/unset → no bootstrap.
 */
export function bootstrapAdminEmail(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const email = env.COLLECTIVE_BOOTSTRAP_ADMIN?.trim().toLowerCase();
  return email || undefined;
}
