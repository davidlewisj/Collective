/**
 * Live-caption streaming relay (design-spec §2.2, backlog IN-2).
 *
 * Browser mic PCM → this relay → AssemblyAI v3 streaming WebSocket
 * (`speaker_labels` on) → Turn events → the meeting's SSE hub, where the
 * capture screen already renders/upserts caption lines by `seq`.
 *
 * Properties that matter:
 * - The vendor key never reaches the client; all vendor traffic is
 *   server-side (spec §3.2).
 * - §6.6 gating applies to LIVE egress exactly like the batch path: a
 *   PHI-effective meeting with no AssemblyAI BAA on the registry gets no
 *   vendor streaming (the UI quietly says captions arrive after the meeting).
 * - Captions are an enhancement: any relay/vendor failure kills captions,
 *   never the recording (the archival webm + async transcript are separate).
 * - Cost guard (IN-3): sessions are billed by duration, so the upstream
 *   socket closes on client disconnect, on stop, and after 60 s without
 *   audio frames.
 *
 * The upstream socket is injectable so tests (and the fake-vendor e2e) can
 * exercise the full relay without AssemblyAI credentials. Override the
 * endpoint with ASSEMBLYAI_STREAMING_URL for local fakes.
 */
import { Meeting } from "@collective/shared";
import WebSocket from "ws";
import { AuditLog } from "./audit.js";
import { LiveHub } from "./pipeline.js";
import { transcriptionEgressAllowed } from "./policy.js";
import { Db } from "./store.js";

/* ------------------------------- upstream ------------------------------ */

export interface Upstream {
  send(data: Buffer | string): void;
  close(): void;
  onMessage(cb: (text: string) => void): void;
  onDown(cb: () => void): void; // error or close
}

export type UpstreamFactory = (params: { sampleRate: number }) => Upstream;

export function makeAssemblyAiUpstream(apiKey: string): UpstreamFactory {
  const base = process.env.ASSEMBLYAI_STREAMING_URL ?? "wss://streaming.assemblyai.com/v3/ws";
  return ({ sampleRate }) => {
    const url = `${base}?sample_rate=${sampleRate}&encoding=pcm_s16le&format_turns=true&speaker_labels=true`;
    const ws = new WebSocket(url, { headers: { authorization: apiKey } });
    const pending: Array<Buffer | string> = [];
    ws.on("open", () => {
      for (const p of pending.splice(0)) ws.send(p);
    });
    return {
      send: (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
        else if (ws.readyState === WebSocket.CONNECTING) pending.push(data);
      },
      close: () => {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "Terminate" }));
        } catch {
          /* closing anyway */
        }
        ws.close();
      },
      onMessage: (cb) => ws.on("message", (d) => cb(d.toString())),
      onDown: (cb) => {
        ws.on("error", cb);
        ws.on("close", cb);
      },
    };
  };
}

/* -------------------------------- relay -------------------------------- */

interface TurnMessage {
  type?: string;
  turn_order?: number;
  transcript?: string;
  end_of_turn?: boolean;
  turn_is_formatted?: boolean;
  speaker_label?: string;
  words?: Array<{ speaker?: string }>;
}

function clusterOf(turn: TurnMessage): string {
  if (turn.speaker_label) return turn.speaker_label;
  const counts = new Map<string, number>();
  for (const w of turn.words ?? []) {
    if (w.speaker) counts.set(w.speaker, (counts.get(w.speaker) ?? 0) + 1);
  }
  let best = "A";
  let bestN = 0;
  for (const [s, n] of counts) if (n > bestN) [best, bestN] = [s, n];
  return best;
}

const IDLE_MS = 60_000;

export class StreamingRelay {
  constructor(
    private db: Db,
    private hub: LiveHub,
    private audit: AuditLog,
    private makeUpstream: UpstreamFactory | null,
  ) {}

  /** Live vendor captions possible for this meeting right now? */
  available(meeting: Meeting): boolean {
    return !!this.makeUpstream && transcriptionEgressAllowed(this.db, meeting);
  }

  /**
   * Bridge one client socket to one vendor session. Returns a detach
   * function; safe to call more than once.
   */
  attach(client: WebSocket, meeting: Meeting, sampleRate: number): () => void {
    if (!this.available(meeting) || !this.makeUpstream) {
      client.close(1008, "live captions unavailable");
      return () => {};
    }

    const upstream = this.makeUpstream({ sampleRate });
    this.audit.emit({
      actorUserId: meeting.ownerUserId,
      action: "live_stream.started",
      meetingId: meeting.id,
      detail: `sample_rate=${sampleRate}`,
    });

    let closed = false;
    let idleTimer: NodeJS.Timeout | null = null;
    const detach = () => {
      if (closed) return;
      closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      upstream.close();
      try {
        client.close();
      } catch {
        /* already closed */
      }
      this.audit.emit({ actorUserId: meeting.ownerUserId, action: "live_stream.ended", meetingId: meeting.id });
    };
    const bumpIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(detach, IDLE_MS);
      idleTimer.unref?.();
    };
    bumpIdle();

    client.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary || closed) return; // audio frames only; no client JSON is trusted
      bumpIdle();
      upstream.send(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
    });
    client.on("close", detach);
    client.on("error", detach);

    upstream.onMessage((text) => {
      let msg: TurnMessage;
      try {
        msg = JSON.parse(text) as TurnMessage;
      } catch {
        return;
      }
      if (msg.type !== "Turn" || typeof msg.transcript !== "string" || msg.transcript.length === 0) return;
      this.hub.emit(meeting.id, "caption", {
        cluster: clusterOf(msg),
        text: msg.transcript,
        interim: !(msg.end_of_turn && msg.turn_is_formatted !== false),
        seq: msg.turn_order ?? 0,
      });
    });
    upstream.onDown(detach);

    return detach;
  }
}

export function makeRelayFactory(): UpstreamFactory | null {
  const key = process.env.ASSEMBLYAI_API_KEY;
  return key ? makeAssemblyAiUpstream(key) : null;
}
