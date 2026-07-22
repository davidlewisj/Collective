/**
 * Attribution engine v1 (design-spec §2.3.1; backlog AT-1..6).
 * Evidence sources implemented in this slice, in descending authority:
 *   1. channel identity — the mic channel is the signed-in user (virtual desktop)
 *   2. voice profiles (§2.3.3) — a cluster matched to an enrolled voiceprint
 *   3. roster name cues — "This is Priya", "Thanks, Omar", "Priya, can you…"
 *   4. manual correction (scope: line | voice), which always wins
 * Teams/Graph (§2.3.2) is a Phase 2 source and plugs into the same model.
 */
import { AttributionEvidence, Meeting, User, Utterance } from "@collective/shared";
import { VoiceMatch } from "./adapters/voice.js";
import { Db } from "./store.js";

const MARGIN = 0.15;

interface Hypothesis {
  userId: string;
  score: number;
  source: AttributionEvidence["source"];
  detail: string;
}

function nameCues(text: string, attendees: User[]): Hypothesis[] {
  const hits: Hypothesis[] = [];
  for (const u of attendees) {
    const first = u.displayName.split(" ")[0]!;
    const pats = [
      { re: new RegExp(`\\bthis is ${first}\\b`, "i"), score: 0.85, self: true },
      { re: new RegExp(`\\b${first} here\\b`, "i"), score: 0.8, self: true },
      { re: new RegExp(`\\bthanks,? ${first}\\b`, "i"), score: 0.6, self: false },
      { re: new RegExp(`\\b${first}, can you\\b`, "i"), score: 0.6, self: false },
    ];
    for (const p of pats) {
      if (p.re.test(text)) {
        hits.push({
          userId: u.id,
          score: p.score,
          source: "roster_cue",
          detail: p.self
            ? `self-introduction cue for ${u.displayName}`
            : `addressed-by-name cue implicating the previous/next speaker`,
        });
      }
    }
  }
  return hits;
}

export function attribute(
  db: Db,
  meeting: Meeting,
  utterances: Utterance[],
  voiceMatches: VoiceMatch[] = [],
): Utterance[] {
  const attendees = [meeting.ownerUserId, ...meeting.attendeeUserIds]
    .map((id) => db.users.get(id))
    .filter((u): u is User => !!u);

  // Accumulate cluster-level hypotheses.
  const byCluster = new Map<string, Hypothesis[]>();
  const push = (cluster: string, h: Hypothesis) => {
    const arr = byCluster.get(cluster) ?? [];
    arr.push(h);
    byCluster.set(cluster, arr);
  };

  // Voice-profile hypotheses: a diarization cluster matched to an enrolled
  // voiceprint. Authoritative below the mic channel, above spoken name cues.
  for (const m of voiceMatches) {
    if (!db.users.has(m.userId)) continue;
    push(m.cluster, {
      userId: m.userId,
      score: m.score,
      source: "voice_profile",
      detail: `voice match for ${db.users.get(m.userId)?.displayName ?? m.userId}`,
    });
  }

  for (const u of utterances) {
    // 1. Channel identity: the capture engine tags the mic channel's cluster
    //    "MIC" (virtual desktop, spec §2.1.1). Authoritative.
    if (u.cluster === "MIC") {
      push(u.cluster, {
        userId: meeting.ownerUserId,
        score: 0.99,
        source: "channel",
        detail: "microphone channel is the signed-in user",
      });
    }
    // 2. Self-introduction cues attach to the speaking cluster.
    for (const h of nameCues(u.text, attendees)) {
      if (h.detail.startsWith("self-introduction")) push(u.cluster, h);
    }
  }

  // Resolve each cluster: best hypothesis must clear a margin over runner-up
  // from a DIFFERENT candidate (spec §2.3.1); otherwise stay unknown.
  const resolved = new Map<string, Hypothesis>();
  for (const [cluster, hyps] of byCluster) {
    const byUser = new Map<string, Hypothesis>();
    for (const h of hyps) {
      const cur = byUser.get(h.userId);
      if (!cur || h.score > cur.score) byUser.set(h.userId, h);
    }
    const ranked = [...byUser.values()].sort((a, b) => b.score - a.score);
    const top = ranked[0];
    if (!top) continue;
    const runnerUp = ranked[1];
    if (!runnerUp || top.score - runnerUp.score >= MARGIN) resolved.set(cluster, top);
  }

  // A user can only own one cluster automatically; keep the highest-scored.
  const bestClusterForUser = new Map<string, { cluster: string; score: number }>();
  for (const [cluster, h] of resolved) {
    const cur = bestClusterForUser.get(h.userId);
    if (!cur || h.score > cur.score) bestClusterForUser.set(h.userId, { cluster, score: h.score });
  }
  for (const [cluster, h] of [...resolved]) {
    if (bestClusterForUser.get(h.userId)!.cluster !== cluster) resolved.delete(cluster);
  }

  return utterances.map((u) => {
    const hit = resolved.get(u.cluster);
    if (!hit) return u; // renders as "Unknown speaker n" (spec §2.3.4)
    return {
      ...u,
      speakerUserId: hit.userId,
      guestLabel: undefined,
      evidence: { source: hit.source, score: hit.score, detail: hit.detail },
    };
  });
}

/* --------------------- live (in-session) speaker names ------------------- */

export interface LiveAssignment {
  userId?: string;
  guestLabel?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
const MIN_MATCH_CHARS = 12; // ignore trivial fragments when matching turns

/**
 * Apply names assigned live during capture to the batch transcript.
 *
 * Live captions and the batch transcript come from SEPARATE diarization runs,
 * so "A" live is not necessarily "A" in the batch. Each named live cluster is
 * matched to the batch cluster whose text best contains that cluster's live
 * turns; a clear winner gets the name as manual evidence (always wins). With
 * no recorded turns (captions off), identical labels are trusted as fallback.
 * Ambiguous clusters stay unknown — post-meeting correction remains available.
 */
export function applyLiveAssignments(
  utterances: Utterance[],
  assignments: Record<string, LiveAssignment>,
  liveTurns: Array<{ cluster: string; text: string }>,
): { utterances: Utterance[]; appliedClusters: string[] } {
  const batchClusters = [...new Set(utterances.map((u) => u.cluster))];
  const textByBatchCluster = new Map<string, string>(
    batchClusters.map((c) => [c, norm(utterances.filter((u) => u.cluster === c).map((u) => u.text).join(" ")) ]),
  );

  // live cluster -> best-matching batch cluster (with its score)
  const candidates: Array<{ live: string; batch: string; score: number }> = [];
  for (const live of Object.keys(assignments)) {
    const turns = liveTurns.filter((t) => t.cluster === live).map((t) => norm(t.text)).filter((t) => t.length >= MIN_MATCH_CHARS);
    if (turns.length === 0) {
      // Captions were off (or nothing said) — trust an identical label.
      if (batchClusters.includes(live)) candidates.push({ live, batch: live, score: 0.5 });
      continue;
    }
    let best: { batch: string; score: number } | undefined;
    let runnerUp = 0;
    for (const [batch, text] of textByBatchCluster) {
      const score = turns.filter((t) => text.includes(t)).length;
      if (!best || score > best.score) {
        runnerUp = best?.score ?? 0;
        best = { batch, score };
      } else if (score > runnerUp) {
        runnerUp = score;
      }
    }
    if (best && best.score >= 1 && best.score > runnerUp) {
      candidates.push({ live, batch: best.batch, score: best.score });
    }
  }

  // One name per batch cluster: on collision the stronger match wins.
  const byBatch = new Map<string, { live: string; score: number }>();
  for (const c of candidates) {
    const cur = byBatch.get(c.batch);
    if (!cur || c.score > cur.score) byBatch.set(c.batch, { live: c.live, score: c.score });
  }

  const evidence: AttributionEvidence = { source: "manual", score: 1, detail: "named live during capture" };
  const applied = utterances.map((u) => {
    const hit = byBatch.get(u.cluster);
    if (!hit) return u;
    const target = assignments[hit.live]!;
    return {
      ...u,
      speakerUserId: target.userId,
      guestLabel: target.userId ? undefined : target.guestLabel,
      evidence,
    };
  });
  return { utterances: applied, appliedClusters: [...byBatch.keys()] };
}

/** Manual correction — always wins; scope "voice" re-labels the whole cluster. */
export function correct(
  utterances: Utterance[],
  utteranceId: string,
  target: { userId?: string; guestLabel?: string },
  scope: "line" | "voice",
): Utterance[] {
  const anchor = utterances.find((u) => u.id === utteranceId);
  if (!anchor) throw Object.assign(new Error("utterance not found"), { statusCode: 404 });
  const applies = (u: Utterance) =>
    scope === "line" ? u.id === utteranceId : u.cluster === anchor.cluster;
  const evidence: AttributionEvidence = { source: "manual", score: 1, detail: `manual correction (${scope})` };
  return utterances.map((u) =>
    applies(u)
      ? { ...u, speakerUserId: target.userId, guestLabel: target.userId ? undefined : target.guestLabel, evidence }
      : u,
  );
}
