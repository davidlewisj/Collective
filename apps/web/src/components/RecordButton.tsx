/**
 * The app's signature control (design-spec §7.3.2). Two placements, one look:
 *  - `variant="fab"`: the round "Record" entry point on the meeting list.
 *  - `variant="hero"`: the large in-capture control whose core morphs
 *    circle → rounded-square as it moves armed → recording, with a breathing
 *    pulse halo while live (paused stills it; stopping collapses it).
 *
 * The core is a CSS element (not an icon) so it can tween its shape; the pulse
 * reuses the existing `app-pulse` keyframes and is disabled under
 * prefers-reduced-motion by the stylesheet.
 */
export type RecordState = "armed" | "recording" | "paused" | "stopping";

export function RecordButton({
  variant,
  state = "armed",
  label,
  onClick,
  disabled,
}: {
  variant: "fab" | "hero";
  state?: RecordState;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  const live = state === "recording";
  return (
    <button
      type="button"
      className={`record-btn record-btn-${variant} record-${state}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={variant === "hero" ? live : undefined}
    >
      <span className="record-halo" aria-hidden="true" />
      <span className="record-core" aria-hidden="true" />
      {variant === "fab" && <span className="record-btn-label">{label}</span>}
    </button>
  );
}
