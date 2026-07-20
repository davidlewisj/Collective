/** Semantic state badges — color never the sole signal; every badge carries text. */

export type BadgeKind = "recording" | "processing" | "shared" | "success" | "error";

const LABELS: Record<BadgeKind, string> = {
  recording: "Recording",
  processing: "Processing",
  shared: "Shared",
  success: "Saved",
  error: "Error",
};

export function StateBadge({ kind, label }: { kind: BadgeKind; label?: string }) {
  return (
    <span className={`state-badge state-badge-${kind}`}>
      <span className={`state-dot${kind === "processing" ? " state-dot-pulse" : ""}`} aria-hidden="true" />
      {label ?? LABELS[kind]}
    </span>
  );
}
