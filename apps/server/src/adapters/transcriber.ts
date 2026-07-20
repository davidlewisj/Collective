/**
 * Transcription adapters (design-spec §2.2).
 * - AssemblyAiTranscriber: real Pre-recorded API calls (upload → transcript
 *   with speaker_labels → poll → EAGER DELETE per backlog TO-3). Active when
 *   ASSEMBLYAI_API_KEY is set — and per §2.6.5 only ship PHI through it once
 *   the BAA (CP-1/#6) is executed.
 * - MockTranscriber: deterministic diarized output so the whole product runs
 *   end-to-end with zero vendor coupling (dev/test default).
 * The Sync API memo path (≤120 s) follows the same pattern.
 */
import { Meeting, Utterance } from "@collective/shared";
import { newId } from "../store.js";

export interface Transcriber {
  readonly name: string;
  transcribe(meeting: Meeting, audio: Buffer, opts: { speakersExpected?: number }): Promise<Utterance[]>;
  transcribeMemoSync(audio: Buffer): Promise<string>;
}

/* ------------------------------- mock ---------------------------------- */

const SCRIPT: Array<{ cluster: string; text: string }> = [
  { cluster: "MIC", text: "Okay, quick note: I'm recording this meeting for notes — any objection?" },
  { cluster: "A", text: "No objection here. This is Priya, by the way, for the front desk side." },
  { cluster: "MIC", text: "Great. Agenda is the referral backlog and the new intake forms." },
  { cluster: "A", text: "The backlog is down to twelve. Two need insurance re-verification before Friday." },
  { cluster: "B", text: "I can take the re-verification calls tomorrow morning." },
  { cluster: "MIC", text: "Thanks. Omar, can you also send the updated intake form to the printers?" },
  { cluster: "B", text: "Yes — I will send the intake form out by end of day." },
  { cluster: "A", text: "One more thing: the Tuesday huddle moves to nine thirty next week." },
  { cluster: "MIC", text: "Noted. Action items: re-verification calls, intake forms, and the huddle time change." },
];

export class MockTranscriber implements Transcriber {
  readonly name = "mock";

  async transcribe(meeting: Meeting, _audio: Buffer): Promise<Utterance[]> {
    let t = 0;
    return SCRIPT.map((line) => {
      const dur = 2200 + line.text.length * 45;
      const u: Utterance = {
        id: newId("utt"),
        meetingId: meeting.id,
        cluster: line.cluster,
        startMs: t,
        endMs: t + dur,
        text: line.text,
        confidence: 0.94,
      };
      t += dur + 400;
      return u;
    });
  }

  async transcribeMemoSync(audio: Buffer): Promise<string> {
    return `[mock memo transcript — ${audio.length} bytes of audio]`;
  }

  /** Live-caption feed for the SSE dev slice: one scripted line per chunk. */
  liveCaptionForChunk(seq: number): { cluster: string; text: string } | undefined {
    return SCRIPT[seq % SCRIPT.length];
  }
}

/* ----------------------------- AssemblyAI ------------------------------ */

const AAI = "https://api.assemblyai.com/v2";
const AAI_SYNC = "https://sync.assemblyai.com/transcribe";

export class AssemblyAiTranscriber implements Transcriber {
  readonly name = "assemblyai";
  constructor(private apiKey: string) {}

  private headers(): Record<string, string> {
    return { authorization: this.apiKey };
  }

  async transcribe(meeting: Meeting, audio: Buffer, opts: { speakersExpected?: number }): Promise<Utterance[]> {
    const body = new Uint8Array(audio); // copy into a plain ArrayBuffer for fetch's BodyInit typing
    const up = await fetch(`${AAI}/upload`, { method: "POST", headers: this.headers(), body });
    if (!up.ok) throw new Error(`assemblyai upload failed: ${up.status}`);
    const { upload_url } = (await up.json()) as { upload_url: string };

    const create = await fetch(`${AAI}/transcript`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify({
        audio_url: upload_url,
        speaker_labels: true,
        ...(opts.speakersExpected ? { speakers_expected: opts.speakersExpected } : {}),
      }),
    });
    if (!create.ok) throw new Error(`assemblyai create failed: ${create.status}`);
    const { id } = (await create.json()) as { id: string };

    try {
      for (;;) {
        await new Promise((r) => setTimeout(r, 3000));
        const poll = await fetch(`${AAI}/transcript/${id}`, { headers: this.headers() });
        const body = (await poll.json()) as {
          status: string;
          error?: string;
          utterances?: Array<{ speaker: string; text: string; start: number; end: number; confidence: number }>;
        };
        if (body.status === "error") throw new Error(`assemblyai: ${body.error}`);
        if (body.status === "completed") {
          return (body.utterances ?? []).map((u) => ({
            id: newId("utt"),
            meetingId: meeting.id,
            cluster: u.speaker,
            startMs: u.start,
            endMs: u.end,
            text: u.text,
            confidence: u.confidence,
          }));
        }
      }
    } finally {
      // Eager vendor-side deletion (backlog TO-3, spec §2.2) — best effort,
      // alarmed in production.
      await fetch(`${AAI}/transcript/${id}`, { method: "DELETE", headers: this.headers() }).catch(() => {});
    }
  }

  async transcribeMemoSync(audio: Buffer): Promise<string> {
    // Sync API: WAV/PCM16 ≤120 s / 40 MB, transcript in the HTTP response.
    const res = await fetch(AAI_SYNC, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/octet-stream" },
      body: new Uint8Array(audio),
    });
    if (!res.ok) throw new Error(`assemblyai sync failed: ${res.status}`);
    const body = (await res.json()) as { text: string };
    return body.text;
  }
}

export function makeTranscriber(): Transcriber {
  const key = process.env.ASSEMBLYAI_API_KEY;
  return key ? new AssemblyAiTranscriber(key) : new MockTranscriber();
}
