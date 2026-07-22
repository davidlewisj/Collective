/**
 * Meeting lifecycle pipeline (design-spec §3.2): stop → transcribe →
 * attribute (incl. names assigned live during capture) → ready. Also the SSE
 * hub for live captions during capture.
 *
 * There is no backend summary job (decision D10): summaries, action items,
 * and Q&A happen in the user's own Claude through the MCP connector, so the
 * only Claude-bound egress left in this codebase is the connector itself
 * (§6.6-gated in mcp.ts). Untitled meetings get a local heuristic title.
 */
import { Meeting, User, Utterance } from "@collective/shared";
import { applyLiveAssignments, attribute } from "./attribution.js";
import { AuditLog } from "./audit.js";
import { MockTranscriber, Transcriber } from "./adapters/transcriber.js";
import { VoiceEngine, VoiceMatch } from "./adapters/voice.js";
import { transcriptionEgressAllowed, voiceMatchAllowed } from "./policy.js";
import { Db, recordLiveTurn } from "./store.js";

type SseSink = (event: string, data: unknown) => void;

export class LiveHub {
  private sinks = new Map<string, Set<SseSink>>();

  subscribe(meetingId: string, sink: SseSink): () => void {
    const set = this.sinks.get(meetingId) ?? new Set();
    set.add(sink);
    this.sinks.set(meetingId, set);
    return () => set.delete(sink);
  }

  emit(meetingId: string, event: string, data: unknown): void {
    for (const sink of this.sinks.get(meetingId) ?? []) sink(event, data);
  }
}

export function speakerNameFn(db: Db, utts: Utterance[]): (u: Utterance) => string {
  // Stable "Unknown speaker n" numbering by first appearance (spec §2.3.4).
  const unknownOrder: string[] = [];
  for (const u of utts) {
    if (!u.speakerUserId && !u.guestLabel && !unknownOrder.includes(u.cluster)) unknownOrder.push(u.cluster);
  }
  return (u) => {
    if (u.speakerUserId) return db.users.get(u.speakerUserId)?.displayName ?? "Former user";
    if (u.guestLabel) return u.guestLabel;
    return `Unknown speaker ${unknownOrder.indexOf(u.cluster) + 1}`;
  };
}

/** Resolve the live speaker map for SSE ("speakers" events): cluster → who. */
export function liveSpeakerNames(
  db: Db,
  meetingId: string,
): Record<string, { name: string; userId: string | null }> {
  const out: Record<string, { name: string; userId: string | null }> = {};
  for (const [cluster, a] of Object.entries(db.liveSpeakers.get(meetingId) ?? {})) {
    const name = a.userId ? db.users.get(a.userId)?.displayName : a.guestLabel;
    if (name) out[cluster] = { name, userId: a.userId ?? null };
  }
  return out;
}

/** Local heuristic title for untitled meetings — no vendor involved. */
function deriveTitle(utterances: Utterance[]): string {
  const first = utterances.find((u) => u.text.trim().length > 0);
  return first ? first.text.slice(0, 56) : "Untitled meeting";
}

export interface PipelineDeps {
  db: Db;
  audit: AuditLog;
  transcriber: Transcriber;
  voiceEngine: VoiceEngine;
  hub: LiveHub;
  /** Raw audio for the meeting, assembled from chunks (dev slice: in memory). */
  audioFor: (meetingId: string) => Buffer;
}

export async function runPostMeetingPipeline(deps: PipelineDeps, meeting: Meeting, actor: User): Promise<void> {
  const { db, audit, hub } = deps;
  meeting.status = "processing";
  meeting.endedAt = new Date().toISOString();
  hub.emit(meeting.id, "status", { status: "processing" });

  try {
    // §6.6 / CP-1 invariant: audio goes to a REAL transcription vendor only
    // when permitted — PHI-effective meetings need the AssemblyAI BAA on the
    // registry. The mock engine is local, so no gate applies to it. Audio is
    // preserved; flip the registry and POST /meetings/:id/reprocess.
    if (deps.transcriber.name !== "mock" && !transcriptionEgressAllowed(db, meeting)) {
      audit.emit({
        actorUserId: actor.id,
        action: "transcription.skipped_phi_gate",
        meetingId: meeting.id,
        detail: "PHI-flagged (or fail-safe) and no AssemblyAI BAA in the registry",
      });
      db.utterances.set(meeting.id, []);
      if (!meeting.title) meeting.title = `Meeting ${new Date().toLocaleDateString("en-US")}`;
      meeting.notice =
        "Transcript unavailable — flagged as patient info and no AssemblyAI BAA on file. Audio is preserved; an admin can record the BAA in Admin → BAA registry, then reprocess this meeting.";
      meeting.status = "ready";
      hub.emit(meeting.id, "status", { status: "ready", degraded: true });
      return;
    }

    const attendeeCount = meeting.attendeeUserIds.length + 1;
    const raw = await deps.transcriber.transcribe(meeting, deps.audioFor(meeting.id), {
      speakersExpected: Math.min(Math.max(attendeeCount, 2), 10),
    });
    audit.emit({
      actorUserId: actor.id,
      action: "pipeline.transcribed",
      meetingId: meeting.id,
      detail: `${deps.transcriber.name}: ${raw.length} utterances`,
    });

    // Voice-profile matching (spec §2.3.3): match diarization clusters to
    // enrolled voiceprints. Local mock is ungated; a real vendor needs the
    // `voice` BAA (biometric egress). Enrolled people consented at enrollment.
    let voiceMatches: VoiceMatch[] = [];
    const enrolled = [...db.voiceprints.values()].map((v) => ({ userId: v.userId, embedding: v.embedding }));
    if (enrolled.length > 0 && voiceMatchAllowed(db, meeting, deps.voiceEngine.name)) {
      voiceMatches = deps.voiceEngine.match(raw, enrolled);
      if (voiceMatches.length > 0) {
        audit.emit({
          actorUserId: actor.id,
          action: "attribution.voice_matched",
          meetingId: meeting.id,
          detail: voiceMatches.map((m) => `${m.cluster}→${m.userId}`).join(", "),
        });
      }
    }

    let attributed = attribute(db, meeting, raw, voiceMatches);

    // Names assigned live during capture are manual evidence — they always
    // win. Live and batch diarization are separate runs, so clusters are
    // matched by transcript-text overlap (label identity as fallback).
    const liveAssignments = db.liveSpeakers.get(meeting.id);
    if (liveAssignments && Object.keys(liveAssignments).length > 0) {
      const applied = applyLiveAssignments(attributed, liveAssignments, db.liveTurns.get(meeting.id) ?? []);
      attributed = applied.utterances;
      if (applied.appliedClusters.length > 0) {
        audit.emit({
          actorUserId: actor.id,
          action: "attribution.live_names_applied",
          meetingId: meeting.id,
          detail: `clusters: ${applied.appliedClusters.join(", ")}`,
        });
      }
    }
    db.liveSpeakers.delete(meeting.id);
    db.liveTurns.delete(meeting.id);

    db.utterances.set(meeting.id, attributed);

    if (!meeting.title) meeting.title = deriveTitle(attributed);
    meeting.notice = undefined; // clean run — clear any stale degraded note
    meeting.status = "ready";
    hub.emit(meeting.id, "status", { status: "ready" });
  } catch (err) {
    // Honest failure surface (spec §7.5): keep the record, mark ready with a
    // note; audio is preserved for reprocessing.
    meeting.status = "ready";
    if (!meeting.title) meeting.title = "Untitled meeting";
    meeting.notice = `Processing hit an error (${(err as Error).message}). Audio is preserved — try reprocessing from the meeting page.`;
    hub.emit(meeting.id, "status", { status: "ready", degraded: true });
    audit.emit({ actorUserId: actor.id, action: "pipeline.error", meetingId: meeting.id, detail: String(err) });
  }
}

export function liveCaptionOnChunk(deps: PipelineDeps, meeting: Meeting, seq: number): void {
  // Dev-slice live captions: the mock transcriber scripts one line per chunk.
  // Production: streaming relay to AssemblyAI v3 WebSocket (relay.ts).
  if (deps.transcriber instanceof MockTranscriber) {
    const line = deps.transcriber.liveCaptionForChunk(seq);
    if (line) {
      recordLiveTurn(deps.db, meeting.id, line.cluster, line.text);
      deps.hub.emit(meeting.id, "caption", {
        cluster: line.cluster,
        text: line.text,
        interim: false,
        seq,
      });
    }
  }
}
