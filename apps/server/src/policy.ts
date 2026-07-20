/**
 * Consent gating (design-spec §2.6.2, WA-strict per Q6) and the per-meeting
 * PHI flag with BAA-aware egress gating (design-spec §6.6).
 */
import { ConsentMechanism, Meeting } from "@collective/shared";
import { Db } from "./store.js";

export function consentSatisfied(db: Db, meeting: Meeting): boolean {
  const have = new Set<ConsentMechanism>(meeting.consent.map((c) => c.mechanism));
  return db.consentPolicy.requiredMechanisms.every((m) => have.has(m));
}

export function missingConsent(db: Db, meeting: Meeting): ConsentMechanism[] {
  const have = new Set<ConsentMechanism>(meeting.consent.map((c) => c.mechanism));
  return db.consentPolicy.requiredMechanisms.filter((m) => !have.has(m));
}

/**
 * §6.6: a meeting is treated as PHI when flagged true, or when unanswered and
 * the entity's fail-safe policy is on.
 */
export function phiEffective(db: Db, meeting: Meeting): boolean {
  if (meeting.phiFlag === true) return true;
  if (meeting.phiFlag === null && db.consentPolicy.phiFailSafe) return true;
  return false;
}

/** May this meeting's text be sent to Claude (Bedrock) for insight jobs? */
export function insightEgressAllowed(db: Db, meeting: Meeting): boolean {
  return !phiEffective(db, meeting) || db.baa.awsBedrock;
}

/** May this meeting's AUDIO be sent to AssemblyAI for transcription? */
export function transcriptionEgressAllowed(db: Db, meeting: Meeting): boolean {
  return !phiEffective(db, meeting) || db.baa.assemblyai;
}

/** May this meeting appear in Claude.ai connector (MCP) results? */
export function mcpEgressAllowed(db: Db, meeting: Meeting): boolean {
  return !phiEffective(db, meeting) || db.baa.claudeWorkspace;
}
