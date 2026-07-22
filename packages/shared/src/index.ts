/**
 * @collective/shared — domain types shared by server, web, and desktop.
 * The design authority for these shapes is docs/design-spec.md (§2.4, §2.6, §2.7, §6).
 */

export type Role =
  | "org_admin"
  | "entity_admin"
  | "compliance_auditor"
  | "member"
  | "guest_viewer";

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  entityId: string;
  /** Deterministic speaker hue index 1..8, assigned at first attribution (spec §7.2.3). */
  speakerHue: number;
  /**
   * Personal chat-bubble color the user picked (§7.3 redesign). 0 = the app
   * accent (default); 1..8 = an index into the speaker ramp. A swatch pick,
   * never a free hex, so it stays token-resolved + contrast-audited. Absent =
   * fall back to `speakerHue`. Exposed via GET /users so other viewers see it.
   */
  bubbleHue?: number;
  deactivated?: boolean;
}

export type MeetingMode = "virtual_desktop" | "in_person" | "mobile_speakerphone";

export type MeetingStatus =
  | "draft" // created, consent not yet satisfied
  | "recording"
  | "processing" // stopped; transcription/insight running
  | "ready"
  | "deleted";

/** Per-meeting PHI flag (spec §6.6). null = unanswered. */
export type PhiFlag = boolean | null;

export type ShareLayer = "summary" | "notes" | "transcript" | "audio";
export type SharePermission = "view" | "edit";

export interface ShareGrant {
  id: string;
  meetingId: string;
  layer: ShareLayer;
  granteeUserId: string;
  permission: SharePermission;
  grantedBy: string;
  grantedAt: string; // ISO
  expiresAt?: string;
}

export type ConsentMechanism =
  | "verbal_announcement_attested"
  | "audible_tone"
  | "invite_disclosure"
  | "participant_ack"
  | "teams_banner";

export interface ConsentArtifact {
  mechanism: ConsentMechanism;
  actorUserId: string;
  at: string; // ISO
  detail?: string;
}

export interface AttributionEvidence {
  source: "channel" | "graph" | "voice_profile" | "roster_cue" | "manual";
  score: number; // 0..1
  detail?: string;
}

export interface Utterance {
  id: string;
  meetingId: string;
  /** Diarization cluster label from the transcriber ("A", "B", ...). */
  cluster: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
  /** Resolved attribution. Exactly one of userId | guestLabel set when attributed. */
  speakerUserId?: string;
  guestLabel?: string; // meeting-scoped label, never a directory link (spec §2.3.4)
  evidence?: AttributionEvidence;
}

export interface Meeting {
  id: string;
  entityId: string;
  ownerUserId: string;
  title: string;
  mode: MeetingMode;
  status: MeetingStatus;
  startedAt?: string;
  endedAt?: string;
  attendeeUserIds: string[];
  phiFlag: PhiFlag;
  consent: ConsentArtifact[];
  audioChunks: number;
  createdAt: string;
  /** Title/attendees were pre-filled from the owner's calendar feed. */
  namedFromCalendar?: boolean;
  /**
   * Honest degraded-state note shown on the record (spec §7.5) — e.g. an
   * objection deleted the audio, or the PHI gate blocked transcription.
   * Summaries themselves are connector-territory (D10): users ask Claude.
   */
  notice?: string;
}

export interface Note {
  meetingId: string;
  authorUserId: string;
  /** Markdown-ish text; lines may carry [t=ms] anchors linking to the transcript. */
  body: string;
  updatedAt: string;
}

export interface AuditEvent {
  seq: number;
  at: string;
  actorUserId: string;
  action: string; // e.g. "meeting.read", "transcript.read", "audio.play", "share.grant", "mcp.search_meetings"
  meetingId?: string;
  layer?: ShareLayer | "record";
  detail?: string;
  /** SHA-256 over (prevHash + canonical event) — tamper-evident chain (spec §3.3). */
  hash: string;
  prevHash: string;
}

export interface BaaRegistry {
  assemblyai: boolean;
  /** HIPAA-ready Claude workspace BAA — gates PHI-flagged meetings on the MCP/connector surface (spec §6.6). */
  claudeWorkspace: boolean;
  microsoft: boolean;
}

export interface ConsentPolicy {
  /** Mechanisms required before capture can start (WA-strict default per Q6). */
  requiredMechanisms: ConsentMechanism[];
  /** §6.6 fail-safe: treat unanswered PHI flag as flagged for external egress. */
  phiFailSafe: boolean;
}

export interface RetentionPolicy {
  audioDays: number;
  transcriptDays: number;
  auditDays: number;
}

/** Speaker hue ramp indices are stable per person org-wide (spec §7.2.3). */
export const SPEAKER_HUE_COUNT = 8;

export function speakerHueForId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % SPEAKER_HUE_COUNT) + 1;
}
