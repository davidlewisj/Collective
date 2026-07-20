import type { User } from "@collective/shared";
import { SPEAKER_HUE_COUNT, speakerHueForId } from "@collective/shared";
import { initials } from "../lib/format";

export function hueVar(hue: number): string {
  const n = ((Math.max(1, Math.round(hue)) - 1) % SPEAKER_HUE_COUNT) + 1;
  return `var(--c-speaker-${n})`;
}

export function hueForUser(user: User): string {
  return hueVar(user.speakerHue || speakerHueForId(user.id));
}

/** Speaker-hue initials chip — color always paired with initials/name (WCAG 1.4.1). */
export function Avatar({
  user,
  name,
  size = "sm",
}: {
  user?: User;
  name?: string;
  size?: "sm" | "md";
}) {
  const label = user?.displayName ?? name ?? "?";
  const color = user ? hueForUser(user) : "var(--c-sage)";
  return (
    <span
      className={`avatar avatar-${size}`}
      style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
      title={label}
      aria-hidden="true"
    >
      {initials(label)}
    </span>
  );
}

/** Attendee chip: avatar + name, colored by the person's stable speaker hue. */
export function PersonChip({ user, name }: { user?: User; name?: string }) {
  const label = user?.displayName ?? name ?? "Unknown";
  return (
    <span className="person-chip">
      <Avatar user={user} name={name} />
      <span>{label}</span>
    </span>
  );
}
