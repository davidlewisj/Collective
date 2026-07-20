/**
 * Meeting lifecycle pipeline (design-spec §3.2): stop → transcribe →
 * attribute → insight (with the §6.6 BAA gate) → ready. Also the SSE hub for
 * live captions during capture.
 */
import { AiOutputs, Meeting, User, Utterance } from "@collective/shared";
import { attribute } from "./attribution.js";
import { AuditLog } from "./audit.js";
import { Insight, MockInsight } from "./adapters/insight.js";
import { MockTranscriber, Transcriber } from "./adapters/transcriber.js";
import { insightEgressAllowed } from "./policy.js";
import { Db } from "./store.js";

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

export interface PipelineDeps {
  db: Db;
  audit: AuditLog;
  transcriber: Transcriber;
  insight: Insight;
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

    const attributed = attribute(db, meeting, raw);
    db.utterances.set(meeting.id, attributed);

    meeting.ai = await generateInsight(deps, meeting, attributed, actor);
    meeting.status = "ready";
    if (!meeting.title && meeting.ai) meeting.title = meeting.ai.title;
    hub.emit(meeting.id, "status", { status: "ready" });
  } catch (err) {
    // Honest failure surface (spec §7.5): keep the record, mark ready with a
    // heuristic title; audio is preserved for reprocessing.
    meeting.status = "ready";
    meeting.ai = {
      title: meeting.title || "Untitled meeting",
      summary: "",
      actionItems: [],
      model: "none",
      generatedAt: new Date().toISOString(),
      skippedReason: `pipeline_error: ${(err as Error).message}`,
    };
    hub.emit(meeting.id, "status", { status: "ready", degraded: true });
    audit.emit({ actorUserId: actor.id, action: "pipeline.error", meetingId: meeting.id, detail: String(err) });
  }
}

export async function generateInsight(
  deps: PipelineDeps,
  meeting: Meeting,
  utts: Utterance[],
  actor: User,
): Promise<AiOutputs> {
  const { db, audit } = deps;
  const attendees = [meeting.ownerUserId, ...meeting.attendeeUserIds]
    .map((id) => db.users.get(id))
    .filter((u): u is User => !!u);
  const speakerName = speakerNameFn(db, utts);

  // §6.6 gate: PHI-effective meeting with no Bedrock BAA on file → the Claude
  // job is skipped and a local heuristic fills in.
  if (!insightEgressAllowed(db, meeting)) {
    audit.emit({
      actorUserId: actor.id,
      action: "insight.skipped_phi_gate",
      meetingId: meeting.id,
      detail: "PHI-flagged (or fail-safe) and no AWS/Bedrock BAA in the registry",
    });
    return {
      title: meeting.title || `Meeting ${new Date().toLocaleDateString("en-US")}`,
      summary: "",
      actionItems: [],
      model: "none",
      generatedAt: new Date().toISOString(),
      skippedReason: "AI summary unavailable — flagged as patient info (no BAA on file)",
    };
  }

  const note = db.notes.get(`${meeting.id}:${actor.id}`);
  const engine = deps.insight;
  const payloadManifest = `layers=[transcript${note ? ",author_notes" : ""}] engine=${engine.name}`;
  audit.emit({ actorUserId: actor.id, action: "insight.sent", meetingId: meeting.id, detail: payloadManifest });
  try {
    return await engine.generate({ meeting, utterances: utts, authorNotes: note?.body, attendees, speakerName });
  } catch (err) {
    // Vendor failure → local fallback (backlog SUM-4).
    audit.emit({ actorUserId: actor.id, action: "insight.fallback", meetingId: meeting.id, detail: String(err) });
    const fallback = await new MockInsight().generate({
      meeting,
      utterances: utts,
      authorNotes: note?.body,
      attendees,
      speakerName,
    });
    return { ...fallback, skippedReason: "AI summary temporarily unavailable — heuristic summary shown" };
  }
}

export function liveCaptionOnChunk(deps: PipelineDeps, meeting: Meeting, seq: number): void {
  // Dev-slice live captions: the mock transcriber scripts one line per chunk.
  // Production: streaming relay to AssemblyAI v3 WebSocket (backlog IN-2).
  if (deps.transcriber instanceof MockTranscriber) {
    const line = deps.transcriber.liveCaptionForChunk(seq);
    if (line) {
      deps.hub.emit(meeting.id, "caption", {
        cluster: line.cluster,
        text: line.text,
        interim: false,
        seq,
      });
    }
  }
}
