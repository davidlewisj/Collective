/**
 * HTTP client for the Collective API (docs/api.md). All calls carry the dev
 * bearer token; 401 anywhere signs the session out.
 */
import type {
  AuditEvent,
  BaaRegistry,
  ConsentMechanism,
  ConsentPolicy,
  Meeting,
  MeetingFlag,
  MeetingMode,
  Note,
  RetentionPolicy,
  ShareGrant,
  ShareLayer,
  SharePermission,
  User,
  Utterance,
} from "@collective/shared";

const AUTH_KEY = "collective.auth";

export interface AuthSession {
  token: string;
  user: User;
}

export function loadSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthSession;
    if (!parsed.token || !parsed.user) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(session: AuthSession | null): void {
  if (session) localStorage.setItem(AUTH_KEY, JSON.stringify(session));
  else localStorage.removeItem(AUTH_KEY);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ApiError";
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

/**
 * API origin override. Browsers use same-origin paths (vite dev proxy /
 * reverse proxy in production). The packaged desktop shell sets
 * window.__COLLECTIVE_API__ to the server origin before the app loads.
 */
export function apiUrl(path: string): string {
  const base = (globalThis as unknown as { __COLLECTIVE_API__?: string }).__COLLECTIVE_API__ ?? "";
  return base.replace(/\/+$/, "") + path;
}

/**
 * WebSocket URL for the live-caption stream. Browser WebSockets cannot carry
 * an Authorization header, so the bearer token rides as a query parameter
 * (accepted by the server for this route only).
 */
export function wsUrl(path: string): string {
  const base = (globalThis as unknown as { __COLLECTIVE_API__?: string }).__COLLECTIVE_API__;
  const origin = base ? base.replace(/\/+$/, "") : `${location.protocol}//${location.host}`;
  const token = loadSession()?.token ?? "";
  const sep = path.includes("?") ? "&" : "?";
  return `${origin.replace(/^http/, "ws")}${path}${sep}token=${encodeURIComponent(token)}`;
}

export function authHeaders(): Record<string, string> {
  const session = loadSession();
  return session ? { Authorization: `Bearer ${session.token}` } : {};
}

async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: opts.method ?? "GET",
    headers: {
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...authHeaders(),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !path.startsWith("/auth/")) onUnauthorized?.();
  if (!res.ok) {
    let code = `http_${res.status}`;
    let message: string | undefined;
    try {
      const parsed = (await res.json()) as Record<string, unknown>;
      const raw = parsed.error ?? parsed.code;
      if (typeof raw === "string") code = raw;
      else if (raw && typeof raw === "object") {
        const inner = raw as Record<string, unknown>;
        if (typeof inner.code === "string") code = inner.code;
        if (typeof inner.message === "string") message = inner.message;
      }
      if (typeof parsed.message === "string") message = parsed.message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, code, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/* -------------------------------- auth --------------------------------- */

export function devLogin(email: string): Promise<AuthSession> {
  return api<AuthSession>("/auth/dev-login", { method: "POST", body: { email } });
}

/* -------------------------------- users -------------------------------- */

let usersPromise: Promise<User[]> | null = null;

export function fetchUsers(): Promise<User[]> {
  usersPromise ??= api<{ users: User[] }>("/users").then((r) => r.users);
  return usersPromise;
}

export function resetCaches(): void {
  usersPromise = null;
}

/* ------------------------------- meetings ------------------------------ */

export function listMeetings(q?: string): Promise<Meeting[]> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : "";
  return api<{ meetings: Meeting[] }>(`/meetings${qs}`).then((r) => r.meetings);
}

export function createMeeting(input: {
  title?: string;
  mode: MeetingMode;
  attendeeUserIds?: string[];
}): Promise<Meeting> {
  return api<{ meeting: Meeting }>("/meetings", { method: "POST", body: input }).then(
    (r) => r.meeting,
  );
}

export interface MeetingDetailResponse {
  meeting: Meeting;
  myLayers: ShareLayer[];
}

export function getMeeting(id: string): Promise<MeetingDetailResponse> {
  return api<MeetingDetailResponse>(`/meetings/${id}`);
}

/**
 * Title edits: the UI spec calls for editable titles but docs/api.md defines
 * no update endpoint. Attempt a conventional PATCH and tolerate its absence
 * so the edit stays local-optimistic against a dev server without it.
 */
export async function patchMeetingTitle(id: string, title: string): Promise<Meeting | null> {
  try {
    const r = await api<{ meeting: Meeting }>(`/meetings/${id}`, {
      method: "PATCH",
      body: { title },
    });
    return r.meeting;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 405)) return null;
    throw err;
  }
}

export function postConsent(
  id: string,
  mechanism: ConsentMechanism,
  detail?: string,
): Promise<Meeting> {
  return api<{ meeting: Meeting }>(`/meetings/${id}/consent`, {
    method: "POST",
    body: { mechanism, ...(detail ? { detail } : {}) },
  }).then((r) => r.meeting);
}

export function startMeeting(id: string): Promise<Meeting> {
  return api<{ meeting: Meeting }>(`/meetings/${id}/start`, { method: "POST" }).then(
    (r) => r.meeting,
  );
}

export function postChunk(id: string, seq: number, dataBase64: string): Promise<unknown> {
  return api(`/meetings/${id}/chunks`, { method: "POST", body: { seq, dataBase64 } });
}

export interface LiveSpeaker {
  name: string;
  userId: string | null;
}

/** Name a live speaker cluster mid-capture; returns the full cluster→who map. */
export function nameLiveSpeaker(
  id: string,
  body: { cluster: string; userId?: string; guestLabel?: string },
): Promise<Record<string, LiveSpeaker>> {
  return api<{ speakers: Record<string, LiveSpeaker> }>(`/meetings/${id}/live/speaker`, {
    method: "POST",
    body,
  }).then((r) => r.speakers);
}

/** Set the caller's personal bubble color (0 = accent, 1..8 = speaker ramp). */
export function putAppearance(bubbleHue: number): Promise<User> {
  return api<{ user: User }>("/me/appearance", { method: "PUT", body: { bubbleHue } }).then((r) => r.user);
}

export function stopMeeting(id: string): Promise<Meeting> {
  return api<{ meeting: Meeting }>(`/meetings/${id}/stop`, { method: "POST" }).then(
    (r) => r.meeting,
  );
}

export function postObjection(id: string): Promise<Meeting> {
  return api<{ meeting: Meeting }>(`/meetings/${id}/objection`, { method: "POST" }).then(
    (r) => r.meeting,
  );
}

/** Flag the current moment (ms from meeting start) — renders as a transcript divider. */
export function postFlag(id: string, atMs: number, label?: string): Promise<MeetingFlag> {
  return api<{ flag: MeetingFlag }>(`/meetings/${id}/flags`, {
    method: "POST",
    body: { atMs, ...(label ? { label } : {}) },
  }).then((r) => r.flag);
}

export function getTranscript(id: string): Promise<Utterance[]> {
  return api<{ utterances: Utterance[] }>(`/meetings/${id}/transcript`).then(
    (r) => r.utterances,
  );
}

export function correctSpeaker(
  meetingId: string,
  utteranceId: string,
  body: { userId?: string; guestLabel?: string; scope: "line" | "voice" },
): Promise<Utterance[]> {
  return api<{ utterances: Utterance[] }>(
    `/meetings/${meetingId}/utterances/${utteranceId}/speaker`,
    { method: "POST", body },
  ).then((r) => r.utterances);
}

export function putPhiFlag(id: string, flagged: boolean | null): Promise<Meeting> {
  return api<{ meeting: Meeting }>(`/meetings/${id}/phi-flag`, {
    method: "PUT",
    body: { flagged },
  }).then((r) => r.meeting);
}

export async function getNote(id: string): Promise<Note | null> {
  try {
    const r = await api<{ note: Note | null }>(`/meetings/${id}/notes`);
    return r.note ?? null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export function putNote(id: string, body: string): Promise<Note> {
  return api<{ note: Note }>(`/meetings/${id}/notes`, { method: "PUT", body: { body } }).then(
    (r) => r.note,
  );
}

/** Fetch the (stub) audio; the call itself is what gets audited. */
export async function fetchAudioBlob(id: string): Promise<Blob | null> {
  const res = await fetch(apiUrl(`/meetings/${id}/audio`), { headers: authHeaders() });
  if (res.status === 401) onUnauthorized?.();
  if (!res.ok) return null;
  return res.blob();
}

/* --------------------------------- auth -------------------------------- */

export function getAuthConfig(): Promise<{ microsoft: boolean }> {
  return api<{ microsoft: boolean }>("/auth/config");
}

/* ------------------------------- settings ------------------------------ */

export interface UserSettings {
  calendarIcsUrl?: string;
}

export function getSettings(): Promise<UserSettings> {
  return api<{ settings: UserSettings }>("/me/settings").then((r) => r.settings);
}

export function putSettings(body: { calendarIcsUrl: string }): Promise<UserSettings> {
  return api<{ settings: UserSettings }>("/me/settings", { method: "PUT", body }).then((r) => r.settings);
}

export function getCalendarPreview(): Promise<{ title: string; attendeeEmails: string[] } | null> {
  return api<{ event: { title: string; attendeeEmails: string[] } | null }>("/me/calendar-preview").then(
    (r) => r.event,
  );
}

export type JoinProvider = "teams" | "zoom" | "meet";

export interface UpcomingEvent {
  title: string;
  startMs: number;
  endMs: number;
  attendeeEmails: string[];
  joinUrl: string | null;
  joinProvider: JoinProvider | null;
}

export function getUpcomingEvents(): Promise<UpcomingEvent[]> {
  return api<{ events: UpcomingEvent[] }>("/me/calendar-upcoming").then((r) => r.events);
}

export function getConnectorTokenStatus(): Promise<{ exists: boolean; createdAt: string | null }> {
  return api<{ exists: boolean; createdAt: string | null }>("/me/connector-token");
}

export function mintConnectorToken(): Promise<string> {
  return api<{ token: string }>("/me/connector-token", { method: "POST" }).then((r) => r.token);
}

export function revokeConnectorToken(): Promise<void> {
  return api<{ ok: boolean }>("/me/connector-token", { method: "DELETE" }).then(() => undefined);
}

/* ---------------------------- voiceprint ------------------------------- */

export interface VoiceprintStatus {
  enrolled: boolean;
  createdAt: string | null;
  vendor: string | null;
}

export function getVoiceprint(): Promise<VoiceprintStatus> {
  return api<VoiceprintStatus>("/me/voiceprint");
}

/** Enroll the caller's own voice (biometric; requires explicit consent). */
export function enrollVoiceprint(audioBase64: string): Promise<VoiceprintStatus> {
  return api<VoiceprintStatus>("/me/voiceprint", { method: "POST", body: { audioBase64, consent: true } });
}

export function deleteVoiceprint(): Promise<VoiceprintStatus> {
  return api<VoiceprintStatus>("/me/voiceprint", { method: "DELETE" });
}

/* --------------------- MCP OAuth (claude.ai connector) ----------------- */

export interface OAuthAuthorizeInfo {
  clientName: string;
  scopes: string[];
  resource: string;
}

/** Consent-page lookup for a pending authorization request. */
export function getOAuthAuthorizeInfo(rid: string): Promise<OAuthAuthorizeInfo> {
  return api<OAuthAuthorizeInfo>(`/oauth/authorize/info?rid=${encodeURIComponent(rid)}`);
}

/** Approve or deny a pending request; returns where to send the browser next. */
export function postOAuthDecision(rid: string, approve: boolean): Promise<{ redirectTo: string }> {
  return api<{ redirectTo: string }>("/oauth/authorize/decision", {
    method: "POST",
    body: { rid, approve },
  });
}

export interface OAuthClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  createdAt: string;
}

export function listOAuthClients(): Promise<OAuthClient[]> {
  return api<{ clients: OAuthClient[] }>("/admin/oauth-clients").then((r) => r.clients);
}

export function createOAuthClient(body: {
  name: string;
  redirectUris: string[];
}): Promise<{ client: OAuthClient; clientSecret: string }> {
  return api<{ client: OAuthClient; clientSecret: string }>("/admin/oauth-clients", {
    method: "POST",
    body,
  });
}

export function deleteOAuthClient(clientId: string): Promise<void> {
  return api<{ ok: boolean }>(`/admin/oauth-clients/${encodeURIComponent(clientId)}`, {
    method: "DELETE",
  }).then(() => undefined);
}

/* -------------------------------- shares ------------------------------- */

export function postShare(
  meetingId: string,
  body: { layer: ShareLayer; granteeUserId: string; permission: SharePermission },
): Promise<ShareGrant> {
  return api<{ share: ShareGrant }>(`/meetings/${meetingId}/shares`, {
    method: "POST",
    body,
  }).then((r) => r.share);
}

export function deleteShare(shareId: string): Promise<unknown> {
  return api(`/shares/${shareId}`, { method: "DELETE" });
}

/**
 * docs/api.md defines no share-listing endpoint; try a conventional one so an
 * existing access list can render, and fall back to session-local knowledge.
 */
export async function tryListShares(meetingId: string): Promise<ShareGrant[] | null> {
  try {
    const r = await api<{ shares: ShareGrant[] }>(`/meetings/${meetingId}/shares`);
    return Array.isArray(r.shares) ? r.shares : null;
  } catch {
    return null;
  }
}

/* -------------------------------- search ------------------------------- */

export interface SearchHit {
  meetingId: string;
  title: string;
  snippet: string;
  layer: ShareLayer | string;
}

export function search(q: string): Promise<SearchHit[]> {
  return api<{ hits: SearchHit[] }>(`/search?q=${encodeURIComponent(q)}`).then((r) => r.hits);
}

/* --------------------------------- audit ------------------------------- */

export function getAudit(params?: { meetingId?: string; actor?: string }): Promise<AuditEvent[]> {
  const qs = new URLSearchParams();
  if (params?.meetingId) qs.set("meetingId", params.meetingId);
  if (params?.actor) qs.set("actor", params.actor);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return api<{ events: AuditEvent[] }>(`/audit${suffix}`).then((r) => r.events);
}

/* --------------------------------- admin ------------------------------- */

export function getBaaRegistry(): Promise<BaaRegistry> {
  return api<{ baa: BaaRegistry }>("/admin/baa-registry").then((r) => r.baa);
}

export function putBaaRegistry(body: BaaRegistry): Promise<BaaRegistry> {
  return api<{ baa: BaaRegistry }>("/admin/baa-registry", { method: "PUT", body }).then((r) => r.baa);
}

export function getConsentPolicy(): Promise<ConsentPolicy> {
  return api<{ policy: ConsentPolicy }>("/admin/consent-policy").then((r) => r.policy);
}

export function putConsentPolicy(body: ConsentPolicy): Promise<ConsentPolicy> {
  return api<{ policy: ConsentPolicy }>("/admin/consent-policy", { method: "PUT", body }).then((r) => r.policy);
}

export function getRetention(): Promise<RetentionPolicy> {
  return api<{ retention: RetentionPolicy }>("/admin/retention").then((r) => r.retention);
}

export function putRetention(body: RetentionPolicy): Promise<RetentionPolicy> {
  return api<{ retention: RetentionPolicy }>("/admin/retention", { method: "PUT", body }).then((r) => r.retention);
}
