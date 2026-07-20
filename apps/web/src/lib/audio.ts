/** WebAudio consent chime + audio-chunk base64 encoding. */

/**
 * A short two-note chime (spec §7.4 "consent tone"): played into the room so
 * participants hear that recording is starting.
 */
export function playConsentTone(): void {
  const Ctor = window.AudioContext;
  if (!Ctor) return;
  const ctx = new Ctor();
  const now = ctx.currentTime;
  const notes: Array<{ freq: number; at: number }> = [
    { freq: 659.25, at: 0 }, // E5
    { freq: 880, at: 0.28 }, // A5
  ];
  for (const { freq, at } of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, now + at);
    gain.gain.linearRampToValueAtTime(0.25, now + at + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, now + at + 0.45);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + at);
    osc.stop(now + at + 0.5);
  }
  window.setTimeout(() => void ctx.close(), 1200);
}

/** Blob → base64 payload for POST /meetings/:id/chunks. */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(",");
      resolve(comma >= 0 ? url.slice(comma + 1) : url);
    };
    reader.readAsDataURL(blob);
  });
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
