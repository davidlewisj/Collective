/**
 * Microsoft Entra ID sign-in + Graph calendar (backlog ID-1 / #11 and the
 * AT-3 production calendar path).
 *
 * Confidential-client authorization-code flow, server side: the browser is
 * redirected to login.microsoftonline.com, comes back to /auth/callback with
 * a code, and the server exchanges it (with the client secret) for tokens.
 * ID-token claims are read after direct TLS exchange with the issuer's token
 * endpoint and checked for issuer/audience/expiry; full JWKS signature
 * verification is production hardening tracked in STATUS.md. MFA is enforced
 * by the tenant's conditional-access policy (recorded per sign-in via the
 * `amr` claim when present).
 *
 * Delegated Calendars.Read powers calendar naming: the event covering "now"
 * from /me/calendarView, with attendee emails for directory mapping. Refresh
 * tokens are stored per user so calendar reads keep working between sign-ins.
 *
 * All HTTP goes through an injectable fetcher so the whole flow is testable
 * without a live tenant.
 */
import { CalendarEvent } from "./calendar.js";

export interface GraphConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function graphConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GraphConfig | null {
  const { GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET } = env;
  if (!GRAPH_TENANT_ID || !GRAPH_CLIENT_ID || !GRAPH_CLIENT_SECRET) return null;
  return {
    tenantId: GRAPH_TENANT_ID,
    clientId: GRAPH_CLIENT_ID,
    clientSecret: GRAPH_CLIENT_SECRET,
    redirectUri: env.GRAPH_REDIRECT_URI ?? "http://localhost:4000/auth/callback",
  };
}

const SCOPES = "openid profile email offline_access User.Read Calendars.Read";

export interface IdClaims {
  email: string;
  name: string;
  oid: string;
  amr?: string[];
}

export interface TokenSet {
  claims: IdClaims;
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
}

export type HttpJson = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json: () => Promise<unknown> }>;

export const realHttp: HttpJson = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, json: () => res.json() };
};

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const payload = jwt.split(".")[1];
  if (!payload) throw new Error("malformed id_token");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

export class MsGraph {
  constructor(
    private cfg: GraphConfig,
    private http: HttpJson = realHttp,
  ) {}

  private get authority(): string {
    return `https://login.microsoftonline.com/${this.cfg.tenantId}`;
  }

  authorizeUrl(state: string): string {
    const q = new URLSearchParams({
      client_id: this.cfg.clientId,
      response_type: "code",
      redirect_uri: this.cfg.redirectUri,
      response_mode: "query",
      scope: SCOPES,
      state,
    });
    return `${this.authority}/oauth2/v2.0/authorize?${q}`;
  }

  private async tokenRequest(body: URLSearchParams): Promise<TokenSet> {
    const res = await this.http(`${this.authority}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const data = (await res.json()) as {
      error_description?: string;
      id_token?: string;
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (res.status !== 200 || !data.access_token) {
      throw new Error(`token endpoint: ${data.error_description ?? res.status}`);
    }
    let claims: IdClaims = { email: "", name: "", oid: "" };
    if (data.id_token) {
      const p = decodeJwtPayload(data.id_token);
      // Claim checks (signature verification = prod hardening, see header).
      const iss = String(p.iss ?? "");
      if (!iss.includes(this.cfg.tenantId)) throw new Error("id_token issuer mismatch");
      if (p.aud !== this.cfg.clientId) throw new Error("id_token audience mismatch");
      if (typeof p.exp === "number" && p.exp * 1000 < Date.now()) throw new Error("id_token expired");
      claims = {
        email: String(p.preferred_username ?? p.email ?? "").toLowerCase(),
        name: String(p.name ?? p.preferred_username ?? "Microsoft user"),
        oid: String(p.oid ?? p.sub ?? ""),
        amr: Array.isArray(p.amr) ? (p.amr as string[]) : undefined,
      };
    }
    return {
      claims,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAtMs: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
  }

  exchangeCode(code: string): Promise<TokenSet> {
    return this.tokenRequest(
      new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: this.cfg.redirectUri,
        scope: SCOPES,
      }),
    );
  }

  refresh(refreshToken: string): Promise<TokenSet> {
    return this.tokenRequest(
      new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: SCOPES,
      }),
    );
  }

  /** The calendar event covering "now" (10-min pre-start grace), if any. */
  async currentEvent(accessToken: string, nowMs = Date.now()): Promise<CalendarEvent | undefined> {
    const start = new Date(nowMs - 60 * 60 * 1000).toISOString();
    const end = new Date(nowMs + 60 * 60 * 1000).toISOString();
    const url =
      `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${encodeURIComponent(start)}` +
      `&endDateTime=${encodeURIComponent(end)}&$select=subject,start,end,attendees,isAllDay&$top=25`;
    const res = await this.http(url, {
      headers: { authorization: `Bearer ${accessToken}`, Prefer: 'outlook.timezone="UTC"' },
    });
    if (res.status !== 200) throw new Error(`calendarView: ${res.status}`);
    const data = (await res.json()) as {
      value?: Array<{
        subject?: string;
        isAllDay?: boolean;
        start?: { dateTime?: string };
        end?: { dateTime?: string };
        attendees?: Array<{ emailAddress?: { address?: string } }>;
      }>;
    };
    const events: CalendarEvent[] = (data.value ?? [])
      .filter((e) => !e.isAllDay && e.subject && e.start?.dateTime && e.end?.dateTime)
      .map((e) => ({
        summary: e.subject!,
        startMs: Date.parse(`${e.start!.dateTime}Z`.replace(/ZZ$/, "Z")),
        endMs: Date.parse(`${e.end!.dateTime}Z`.replace(/ZZ$/, "Z")),
        attendeeEmails: (e.attendees ?? [])
          .map((a) => a.emailAddress?.address?.toLowerCase())
          .filter((a): a is string => !!a),
      }));
    const candidates = events.filter((e) => nowMs >= e.startMs - 10 * 60 * 1000 && nowMs < e.endMs);
    return candidates.sort((a, b) => b.startMs - a.startMs)[0];
  }
}
