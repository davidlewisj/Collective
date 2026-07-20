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

export interface Db {
  users: Map<string, User>;
  meetings: Map<string, Meeting>;
  utterances: Map<string, Utterance[]>; // meetingId -> ordered utterances
  notes: Map<string, Note>; // `${meetingId}:${userId}`
  shares: Map<string, ShareGrant>;
  sessions: Map<string, Session>;
  userSettings: Map<string, UserSettings>;
  connectorTokens: Map<string, ConnectorToken>;
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
    userSettings: new Map(),
    connectorTokens: new Map(),
    baa: { assemblyai: false, awsBedrock: false, claudeWorkspace: false, microsoft: false },
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
    return { id, email, displayName, role, entityId: ENTITY, speakerHue: speakerHueForId(id) };
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

export function userByEmail(db: Db, email: string): User | undefined {
  for (const u of db.users.values()) if (u.email === email) return u;
  return undefined;
}

/**
 * Environment-driven policy seeds, so a .env file survives restarts of the
 * in-memory dev store (persistence proper is backlog PF-3):
 * - COLLECTIVE_BAA: comma list of registry entries to mark executed
 *   (assemblyai, awsBedrock, claudeWorkspace, microsoft). Only set these
 *   after the corresponding BAA is actually signed (docs/procurement-baa-runbook.md).
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
  for (const k of ["assemblyai", "awsBedrock", "claudeWorkspace", "microsoft"] as const) {
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
