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

/** May this meeting's AUDIO be sent to AssemblyAI for transcription? */
export function transcriptionEgressAllowed(db: Db, meeting: Meeting): boolean {
  return !phiEffective(db, meeting) || db.baa.assemblyai;
}

/** May this meeting appear in Claude.ai connector (MCP) results? */
export function mcpEgressAllowed(db: Db, meeting: Meeting): boolean {
  return !phiEffective(db, meeting) || db.baa.claudeWorkspace;
}

/**
 * May a voice sample be sent to the voice-embedding vendor? Biometric data
 * (spec §2.6.3): a real vendor needs the `voice` BAA. The local mock engine
 * never leaves the box, so it isn't gated (mirrors the transcription rule).
 */
export function voiceVendorAllowed(db: Db, engineName: string): boolean {
  return engineName === "mock" || db.baa.voice;
}

/**
 * May this meeting's audio be matched against enrolled voiceprints? The mock
 * engine is local; a real engine sends audio to the voice vendor, so it needs
 * the `voice` BAA regardless of the PHI flag (the sample itself is biometric).
 */
export function voiceMatchAllowed(db: Db, _meeting: Meeting, engineName: string): boolean {
  return engineName === "mock" || db.baa.voice;
}
