/**
 * Policy decision point — deny by default (design-spec §2.6.1; backlog ID-2).
 * Every service consults can()/readableLayers(); nothing does ad-hoc checks.
 *
 * Model (most-restricted defaults, spec §2.7.2):
 * - Owner: full access to their meeting, including audio.
 * - Compliance auditor: read access to all layers + the audit log; no edits.
 * - Share grantees: exactly the granted layer/permission, until revoked/expired.
 * - Attendees: may see the meeting exists and their OWN notes — content layers
 *   require an explicit share. Notes are only ever readable by their author.
 * - org_admin: administers policies; gets NO implicit content access
 *   (minimum necessary is a rule for admins too).
 */
import { Meeting, ShareLayer, User } from "@collective/shared";
import { Db } from "./store.js";

export type Action = "read" | "edit";
const LAYERS: ShareLayer[] = ["summary", "notes", "transcript", "audio"];

function activeGrant(db: Db, meeting: Meeting, user: User, layer: ShareLayer, action: Action) {
  const now = Date.now();
  for (const g of db.shares.values()) {
    if (g.meetingId !== meeting.id || g.granteeUserId !== user.id || g.layer !== layer) continue;
    if (g.expiresAt && Date.parse(g.expiresAt) < now) continue;
    if (action === "edit" && g.permission !== "edit") continue;
    return g;
  }
  return undefined;
}

export function can(db: Db, user: User, action: Action, meeting: Meeting, layer: ShareLayer): boolean {
  if (user.deactivated || meeting.status === "deleted") return false;
  // Notes are author-private regardless of role or grant (spec §2.4/§2.7.2):
  // the "notes" layer here refers to grants on the owner's shared notes; a
  // caller's own note is handled by the notes service directly.
  if (meeting.ownerUserId === user.id) return true;
  if (user.role === "compliance_auditor") return action === "read";
  if (activeGrant(db, meeting, user, layer, action)) return true;
  return false; // deny by default — attendees, admins, everyone else
}

export function canSeeRecord(db: Db, user: User, meeting: Meeting): boolean {
  if (meeting.status === "deleted") return false;
  if (meeting.ownerUserId === user.id) return true;
  if (user.role === "compliance_auditor") return true;
  if (meeting.attendeeUserIds.includes(user.id)) return true; // existence + own notes only
  return LAYERS.some((l) => can(db, user, "read", meeting, l));
}

export function readableLayers(db: Db, user: User, meeting: Meeting): ShareLayer[] {
  return LAYERS.filter((l) => can(db, user, "read", meeting, l));
}

export function isAdmin(user: User): boolean {
  return user.role === "org_admin";
}

export function canReadAudit(user: User): boolean {
  return user.role === "org_admin" || user.role === "compliance_auditor";
}
