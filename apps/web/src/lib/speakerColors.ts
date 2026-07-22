/**
 * Chat-bubble color + side assignment (§7.3 redesign).
 *
 * Rules the owner signed off on:
 *  - The meeting facilitator (owner) sits on the RIGHT in their personal
 *    bubble color (`bubbleHue`: 0/absent = accent, 1..8 = speaker ramp).
 *  - Every identified non-facilitator sits on the LEFT in a distinct color,
 *    from their personal `bubbleHue` (1..8) else their stable `speakerHue`,
 *    with a meeting-scoped collision pass so two people never share a hue.
 *  - A named guest takes the next unused ramp hue, stable for the meeting.
 *  - An UNKNOWN / unnamed voice is neutral (no hue) until someone names it —
 *    honest about the certainty the app actually has.
 *
 * Deterministic given the same ordered turns, so live + detail agree.
 */
import type { User } from "@collective/shared";
import { SPEAKER_HUE_COUNT, speakerHueForId } from "@collective/shared";

export type BubbleKind = "owner" | "person" | "guest" | "unknown";

export interface BubbleStyle {
  side: "left" | "right";
  /** CSS var for the hue, or undefined for the neutral unknown treatment. */
  colorVar?: string;
  kind: BubbleKind;
}

export interface SpeakerRef {
  speakerUserId?: string;
  guestLabel?: string;
  cluster: string;
}

/** Block-grouping identity, matching the transcript/live renderers. */
export function identityKey(u: SpeakerRef): string {
  return u.speakerUserId ?? (u.guestLabel ? `g:${u.guestLabel}` : `c:${u.cluster}`);
}

function rampVar(index: number): string {
  const n = ((Math.max(1, Math.round(index)) - 1) % SPEAKER_HUE_COUNT) + 1;
  return `var(--c-speaker-${n})`;
}

/** A user's preferred ramp index (1..8), or undefined if they default to accent. */
function preferredRamp(user: User): number | undefined {
  if (typeof user.bubbleHue === "number") return user.bubbleHue >= 1 ? user.bubbleHue : undefined;
  return user.speakerHue || speakerHueForId(user.id);
}

/**
 * Resolve a stable style per speaker-identity for one meeting.
 * `ordered` should be the turns in first-appearance order.
 */
export function buildSpeakerStyles(
  ownerUserId: string,
  ordered: SpeakerRef[],
  byId: Map<string, User>,
): Map<string, BubbleStyle> {
  const styles = new Map<string, BubbleStyle>();
  const taken = new Set<number>();

  // Reserve the owner's hue first (only if they use a ramp color, not accent).
  const owner = byId.get(ownerUserId);
  const ownerRamp = owner && typeof owner.bubbleHue === "number" && owner.bubbleHue >= 1 ? owner.bubbleHue : undefined;
  if (ownerRamp) taken.add(((ownerRamp - 1) % SPEAKER_HUE_COUNT) + 1);

  const nextFree = (desired?: number): number => {
    const start = desired ? ((desired - 1) % SPEAKER_HUE_COUNT) + 1 : 1;
    for (let i = 0; i < SPEAKER_HUE_COUNT; i++) {
      const n = ((start - 1 + i) % SPEAKER_HUE_COUNT) + 1;
      if (!taken.has(n)) return n;
    }
    return start; // ramp exhausted (>8 speakers) — reuse rather than crash
  };

  for (const ref of ordered) {
    const key = identityKey(ref);
    if (styles.has(key)) continue;

    // Facilitator → right, personal color (accent by default).
    if (ref.speakerUserId && ref.speakerUserId === ownerUserId) {
      styles.set(key, {
        side: "right",
        colorVar: ownerRamp ? rampVar(ownerRamp) : "var(--c-juniper)",
        kind: "owner",
      });
      continue;
    }

    // Identified non-facilitator → left, distinct ramp hue.
    if (ref.speakerUserId) {
      const u = byId.get(ref.speakerUserId);
      const n = nextFree(u ? preferredRamp(u) : undefined);
      taken.add(n);
      styles.set(key, { side: "left", colorVar: rampVar(n), kind: "person" });
      continue;
    }

    // Named guest → left, next free hue.
    if (ref.guestLabel) {
      const n = nextFree();
      taken.add(n);
      styles.set(key, { side: "left", colorVar: rampVar(n), kind: "guest" });
      continue;
    }

    // Unknown → left, neutral (no hue) until named.
    styles.set(key, { side: "left", kind: "unknown" });
  }

  return styles;
}
