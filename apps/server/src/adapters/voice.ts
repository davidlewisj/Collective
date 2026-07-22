/**
 * Voice-recognition adapters (design-spec §2.3.3 voice profiles / §2.6.3
 * biometric consent). Enrollment stores an opaque embedding per person; at
 * attribution time the engine matches a meeting's diarization clusters to
 * enrolled people, producing `voice_profile` hypotheses for attribution.ts.
 *
 * - MockVoiceEngine: deterministic, zero-vendor, so the whole flow runs in
 *   dev/test. Its "acoustic" knowledge is scripted — exactly like the mock
 *   transcriber's fixed transcript — mapping the script's non-owner clusters
 *   to their known speakers. It stores NO real biometric data.
 * - RealVoiceEngine: the seam for a real voice-embedding vendor. It requires
 *   both an API key (env) AND the `voice` BAA on the registry before any audio
 *   leaves the box (gated in policy.ts). Per-cluster acoustic embeddings aren't
 *   wired yet, so it enrolls but returns no matches — never a wrong guess.
 */
import { Utterance } from "@collective/shared";

export interface VoiceMatch {
  cluster: string;
  userId: string;
  score: number; // 0..1
}

export interface VoiceEngine {
  readonly name: string;
  /** Produce an enrollment embedding from a voice sample. */
  enroll(userId: string, audio: Buffer): number[];
  /** Match diarization clusters to enrolled people (best-effort, may be empty). */
  match(utterances: Utterance[], enrolled: Array<{ userId: string; embedding: number[] }>): VoiceMatch[];
}

/* ------------------------------- shared -------------------------------- */

const DIMS = 16;

/** Deterministic unit-ish vector from a seed string (a stand-in embedding). */
function signature(seed: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    v[i % DIMS] = (v[i % DIMS]! + ((c * 2654435761) % 97)) % 97;
  }
  return v;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const MATCH_THRESHOLD = 0.9;
const MATCH_SCORE = 0.88; // sits below channel identity (0.99), above roster cues

/* -------------------------------- mock --------------------------------- */

/**
 * The mock transcriber's SCRIPT (adapters/transcriber.ts) uses fixed clusters:
 * "A" is Priya (self-introduces) and "B" is Omar (addressed by name). The mock
 * voice engine knows this the same way the mock transcript does, so enrolling
 * one of them makes their cluster auto-attribute by voice in later meetings.
 * "MIC" stays owner-attributed by channel identity, so it isn't listed here.
 */
const MOCK_CLUSTER_VOICE: Record<string, string> = {
  A: "u_priya",
  B: "u_omar",
};

export class MockVoiceEngine implements VoiceEngine {
  readonly name = "mock";

  enroll(userId: string, _audio: Buffer): number[] {
    return signature(userId);
  }

  match(utterances: Utterance[], enrolled: Array<{ userId: string; embedding: number[] }>): VoiceMatch[] {
    const clusters = [...new Set(utterances.map((u) => u.cluster))];
    const out: VoiceMatch[] = [];
    for (const cluster of clusters) {
      // The mock's scripted acoustic identity for this cluster (like its fixed
      // transcript). Only that person's own enrolled print can match it, so two
      // users' signatures can never be confused.
      const voiceUser = MOCK_CLUSTER_VOICE[cluster];
      if (!voiceUser) continue;
      const enrolledSelf = enrolled.find((e) => e.userId === voiceUser);
      if (!enrolledSelf) continue;
      if (cosine(signature(voiceUser), enrolledSelf.embedding) >= MATCH_THRESHOLD) {
        out.push({ cluster, userId: voiceUser, score: MATCH_SCORE });
      }
    }
    return out;
  }
}

/* ------------------------------- real ---------------------------------- */

export class RealVoiceEngine implements VoiceEngine {
  readonly name = "voice-vendor";
  constructor(private apiKey: string) {}

  enroll(_userId: string, _audio: Buffer): number[] {
    // A real integration uploads the sample and stores the vendor embedding.
    // Left as the seam; enrollment through this engine is gated on the `voice`
    // BAA in policy.ts, so it never runs until procurement is complete.
    throw new Error("real voice enrollment not yet implemented");
  }

  match(): VoiceMatch[] {
    // Per-cluster acoustic embeddings aren't wired to the transcript pipeline
    // yet, so the real engine makes no guesses (better silent than wrong).
    return [];
  }
}

export function makeVoiceEngine(): VoiceEngine {
  const key = process.env.VOICE_API_KEY;
  return key ? new RealVoiceEngine(key) : new MockVoiceEngine();
}
