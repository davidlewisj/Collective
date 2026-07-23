/**
 * In-memory store with a deliberate repository seam.
 *
 * Production target is Aurora PostgreSQL with row-level security and
 * per-entity keys (design-spec §3.3, backlog PF-3). This dev-slice store keeps
 * the same shapes and access goes exclusively through service functions that
 * enforce RBAC + audit, so swapping the persistence layer does not touch the
 * compliance logic.
 */
import {
  BaaRegistry,
  ConsentPolicy,
  Meeting,
  Note,
  RetentionPolicy,
  ShareGrant,
  User,
  Utterance,
  Voiceprint,
  speakerHueForId,
} from "@collective/shared";

export interface Session {
  token: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  deviceId?: string;
}

export interface UserSettings {
  /** Secret ICS feed URL (Outlook "publish calendar" / Google "secret address"). */
  calendarIcsUrl?: string;
}

/** Long-lived token for the Claude connector (MCP surface ONLY, revocable). */
export interface ConnectorToken {
  token: string;
  userId: string;
  createdAt: string;
}

/**
 * OAuth 2.1 client allowlist entry (spec §6.4: dynamic registration is
 * disabled in favor of an org-approved client set). An org_admin mints one
 * per Claude surface (e.g. claude.ai) and enters the id/secret there.
 */
export interface OAuthClient {
  clientId: string;
  /** SHA-256 hex of the client secret; the secret itself is shown once. */
  clientSecretHash: string;
  name: string;
  redirectUris: string[];
  createdAt: string;
  createdBy: string;
}

/** Bearer access token for the MCP resource, audience-bound (RFC 8707). */
export interface OAuthAccessToken {
  token: string;
  clientId: string;
  userId: string;
  /** Space-delimited granted scopes. */
  scope: string;
  /** Audience — must equal the MCP resource URL at use time. */
  resource: string;
  expiresAtMs: number;
}

/** Refresh token so a connected Claude surface survives access-token expiry. */
export interface OAuthRefreshToken {
  token: string;
  clientId: string;
  userId: string;
  scope: string;
  resource: string;
}

/** Per-user Microsoft Graph delegated tokens (Calendars.Read). */
export interface GraphAuth {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
}

/** In-session speaker naming (live capture); ephemeral like sessions. */
export interface LiveSpeakerAssignment {
  userId?: string;
  guestLabel?: string;
}

export interface Db {
  users: Map<string, User>;
  meetings: Map<string, Meeting>;
  utterances: Map<string, Utterance[]>; // meetingId -> ordered utterances
  notes: Map<string, Note>; // `${meetingId}:${userId}`
  shares: Map<string, ShareGrant>;
  sessions: Map<string, Session>;
  /** meetingId -> live cluster -> name assigned during capture (not persisted). */
  liveSpeakers: Map<string, Record<string, LiveSpeakerAssignment>>;
  /** meetingId -> finalized live caption turns, for cluster matching at stop. */
  liveTurns: Map<string, Array<{ cluster: string; text: string }>>;
  userSettings: Map<string, UserSettings>;
  connectorTokens: Map<string, ConnectorToken>;
  oauthClients: Map<string, OAuthClient>; // clientId -> client
  oauthAccessTokens: Map<string, OAuthAccessToken>; // token -> grant
  oauthRefreshTokens: Map<string, OAuthRefreshToken>; // token -> grant
  graphAuth: Map<string, GraphAuth>;
  /** userId -> enrolled voice signature (biometric; consent- + BAA-gated). */
  voiceprints: Map<string, Voiceprint>;
  baa: BaaRegistry;
  consentPolicy: ConsentPolicy;
  retention: RetentionPolicy;
  /** Idle session timeout, minutes (spec §2.6.1; default 15). */
  idleMinutes: number;
}

let seq = 0;
export function newId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`;
}

export function createDb(): Db {
  return {
    users: new Map(),
    meetings: new Map(),
    utterances: new Map(),
    notes: new Map(),
    shares: new Map(),
    sessions: new Map(),
    liveSpeakers: new Map(),
    liveTurns: new Map(),
    userSettings: new Map(),
    connectorTokens: new Map(),
    oauthClients: new Map(),
    oauthAccessTokens: new Map(),
    oauthRefreshTokens: new Map(),
    graphAuth: new Map(),
    voiceprints: new Map(),
    baa: { assemblyai: false, claudeWorkspace: false, microsoft: false, voice: false },
    // WA-strict default (Q6): attestation mandatory before capture starts.
    consentPolicy: {
      requiredMechanisms: ["verbal_announcement_attested"],
      phiFailSafe: true,
    },
    retention: { audioDays: 90, transcriptDays: 365 * 7, auditDays: 365 * 6 },
    idleMinutes: 15,
  };
}

const ENTITY = "entity_main"; // single-entity deployment per resolved Q1

export function seedUsers(db: Db): void {
  const mk = (email: string, displayName: string, role: User["role"]): User => {
    const id = `u_${email.split("@")[0]}`;
    return { id, email, displayName, role, entityId: ENTITY, speakerHue: speakerHueForId(id), status: "active" };
  };
  for (const u of [
    mk("dana@collective.dev", "Dana Whitfield", "org_admin"),
    mk("omar@collective.dev", "Omar Reyes", "member"),
    mk("priya@collective.dev", "Priya Natarajan", "member"),
    mk("casey@collective.dev", "Casey Lin", "compliance_auditor"),
  ]) {
    db.users.set(u.id, u);
  }
}

const LIVE_TURNS_CAP = 2000; // plenty for hours of turns; bounds memory

/** Record a finalized live caption turn (for cluster matching at stop). */
export function recordLiveTurn(db: Db, meetingId: string, cluster: string, text: string): void {
  const arr = db.liveTurns.get(meetingId) ?? [];
  if (arr.length >= LIVE_TURNS_CAP) return;
  arr.push({ cluster, text });
  db.liveTurns.set(meetingId, arr);
}

export function userByEmail(db: Db, email: string): User | undefined {
  const needle = email.toLowerCase();
  for (const u of db.users.values()) if (u.email.toLowerCase() === needle) return u;
  return undefined;
}

/**
 * Microsoft sign-in user mapping into the single org (Q1). The bootstrap-admin
 * email is provisioned (or promoted, if it already exists) to an active
 * `org_admin` — otherwise a fresh production directory would have no admin to
 * approve anyone. Every other new account joins as a **pending** member and
 * stays out of all content until an org admin approves it.
 */
export function linkOrProvisionUser(
  db: Db,
  claims: { email: string; name: string; oid: string },
  opts: { bootstrapAdminEmail?: string } = {},
): User {
  const isBootstrapAdmin =
    !!opts.bootstrapAdminEmail && claims.email.toLowerCase() === opts.bootstrapAdminEmail.toLowerCase();
  const existing = userByEmail(db, claims.email);
  if (existing) {
    // Idempotent bootstrap: guarantee the named admin is an active org_admin,
    // even if they signed in (or were seeded) before the env was set.
    if (isBootstrapAdmin && (existing.role !== "org_admin" || existing.status === "pending")) {
      existing.role = "org_admin";
      existing.status = "active";
    }
    return existing;
  }
  const id = `u_ms_${claims.oid.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || Date.now().toString(36)}`;
  const user: User = {
    id,
    email: claims.email.toLowerCase(),
    displayName: claims.name,
    role: isBootstrapAdmin ? "org_admin" : "member",
    entityId: ENTITY,
    speakerHue: speakerHueForId(id),
    status: isBootstrapAdmin ? "active" : "pending",
  };
  db.users.set(id, user);
  return user;
}

/**
 * Environment-driven policy seeds, so a .env file survives restarts of the
 * in-memory dev store (persistence proper is backlog PF-3):
 * - COLLECTIVE_BAA: comma list of registry entries to mark executed
 *   (assemblyai, claudeWorkspace, microsoft, voice). Only set these after the
 *   corresponding BAA is actually signed (docs/procurement-baa-runbook.md).
 * - COLLECTIVE_PHI_FAILSAFE=0: treat unanswered PHI flags as non-PHI
 *   (sponsor model); default stays fail-safe.
 */
export function applyEnvOverrides(db: Db, env: NodeJS.ProcessEnv = process.env): string[] {
  const applied: string[] = [];
  const keys = new Set(
    (env.COLLECTIVE_BAA ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const k of ["assemblyai", "claudeWorkspace", "microsoft", "voice"] as const) {
    if (keys.has(k)) {
      db.baa[k] = true;
      applied.push(`baa.${k}=true`);
    }
  }
  if (env.COLLECTIVE_PHI_FAILSAFE === "0") {
    db.consentPolicy.phiFailSafe = false;
    applied.push("phiFailSafe=false");
  }
  return applied;
}
