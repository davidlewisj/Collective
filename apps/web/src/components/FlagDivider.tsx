import { fmtClock } from "../lib/format";
import { IconFlag } from "./icons";

/**
 * A labeled break line across the transcript marking a moment the facilitator
 * flagged. `atMs` is milliseconds from meeting start.
 */
export function FlagDivider({ atMs, label }: { atMs: number; label?: string }) {
  return (
    <div className="flag-divider" role="separator" aria-label={`Flag at ${fmtClock(atMs)}${label ? ` — ${label}` : ""}`}>
      <span className="flag-divider-pill">
        <IconFlag size={14} />
        <span className="mono flag-divider-time">{fmtClock(atMs)}</span>
        <span className="flag-divider-label">{label || "Flag"}</span>
      </span>
    </div>
  );
}
