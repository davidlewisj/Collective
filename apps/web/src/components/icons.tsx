/**
 * Icon set — inline, stroke-based, token-colored (design-spec §7.2 redesign).
 *
 * One 24×24 grid, 1.75 stroke, round caps/joins, `fill="none"`,
 * `stroke="currentColor"` so every icon inherits the surrounding text color
 * (a `--c-*` token, never a hardcoded hue). Filled shapes are reserved for the
 * three places a solid mark carries meaning: the record core, the stop core,
 * and state dots. Icons are decorative by default (`aria-hidden`); pass a
 * `title` to make one a labelled graphic. Sizes 16 / 20 / 24 — at 16 the
 * stroke bumps to 2 for optical weight.
 */
import type { ReactNode, SVGProps } from "react";

export type IconProps = Omit<SVGProps<SVGSVGElement>, "width" | "height"> & {
  /** Rendered box in px (typically 16 / 20 / 24). */
  size?: number;
  title?: string;
};

function Icon({ size = 20, title, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={size <= 16 ? 2 : 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

/* --------------------------- capture / audio ---------------------------- */

/** Record: a filled core inside a ring (the app's signature mark). */
export const IconRecord = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none" />
  </Icon>
);

export const IconStop = (p: IconProps) => (
  <Icon {...p}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="3" fill="currentColor" stroke="none" />
  </Icon>
);

export const IconPause = (p: IconProps) => (
  <Icon {...p}>
    <line x1="9" y1="6" x2="9" y2="18" />
    <line x1="15" y1="6" x2="15" y2="18" />
  </Icon>
);

export const IconPlay = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 5.5l11 6.5-11 6.5z" fill="currentColor" stroke="currentColor" />
  </Icon>
);

export const IconMic = (p: IconProps) => (
  <Icon {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
    <line x1="12" y1="17.5" x2="12" y2="21" />
    <line x1="8.5" y1="21" x2="15.5" y2="21" />
  </Icon>
);

export const IconWave = (p: IconProps) => (
  <Icon {...p}>
    <line x1="4" y1="10" x2="4" y2="14" />
    <line x1="8" y1="7" x2="8" y2="17" />
    <line x1="12" y1="4" x2="12" y2="20" />
    <line x1="16" y1="8" x2="16" y2="16" />
    <line x1="20" y1="10.5" x2="20" y2="13.5" />
  </Icon>
);

/* ------------------------------ actions --------------------------------- */

export const IconFlag = (p: IconProps) => (
  <Icon {...p}>
    <line x1="6" y1="3" x2="6" y2="21" />
    <path d="M6 4.5h10.5l-2.2 3.75L16.5 12H6z" />
  </Icon>
);

export const IconHand = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11m0-.5V4.5a1.5 1.5 0 0 1 3 0V11m0-.5V6a1.5 1.5 0 0 1 3 0v7a6 6 0 0 1-6 6h-1.2a5 5 0 0 1-3.9-1.9L4.3 15a1.6 1.6 0 0 1 2.5-2l1.2 1.4V6.5a1.5 1.5 0 0 1 3 0" />
  </Icon>
);

export const IconNotes = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H14l6 6v8.5A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5z" />
    <path d="M14 4v5.5H20" />
    <line x1="8" y1="13" x2="14" y2="13" />
    <line x1="8" y1="16.5" x2="12" y2="16.5" />
  </Icon>
);

export const IconSearch = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <line x1="15.5" y1="15.5" x2="20" y2="20" />
  </Icon>
);

export const IconShare = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 15V4" />
    <path d="M8.5 7.5 12 4l3.5 3.5" />
    <path d="M6 12v6.5A1.5 1.5 0 0 0 7.5 20h9a1.5 1.5 0 0 0 1.5-1.5V12" />
  </Icon>
);

export const IconCopy = (p: IconProps) => (
  <Icon {...p}>
    <rect x="8" y="8" width="12" height="12" rx="2.5" />
    <path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" />
  </Icon>
);

export const IconLink = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L11.5 6.8" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5" />
  </Icon>
);

export const IconPlus = (p: IconProps) => (
  <Icon {...p}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </Icon>
);

export const IconX = (p: IconProps) => (
  <Icon {...p}>
    <line x1="6" y1="6" x2="18" y2="18" />
    <line x1="18" y1="6" x2="6" y2="18" />
  </Icon>
);

export const IconCheck = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 12.5l4.5 4.5L19 7" />
  </Icon>
);

export const IconChevronLeft = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14.5 5.5 8 12l6.5 6.5" />
  </Icon>
);

export const IconChevronDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5.5 9.5 12 16l6.5-6.5" />
  </Icon>
);

/* ------------------------------- chrome --------------------------------- */

/** Settings: sliders (friendlier + more distinct than a gear). */
export const IconSliders = (p: IconProps) => (
  <Icon {...p}>
    <line x1="4" y1="7" x2="20" y2="7" />
    <line x1="4" y1="12" x2="20" y2="12" />
    <line x1="4" y1="17" x2="20" y2="17" />
    <circle cx="9" cy="7" r="2.2" fill="var(--c-surface-raised)" />
    <circle cx="15" cy="12" r="2.2" fill="var(--c-surface-raised)" />
    <circle cx="8" cy="17" r="2.2" fill="var(--c-surface-raised)" />
  </Icon>
);

export const IconShield = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5 19 6v5.5c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6z" />
    <path d="M9 12l2 2 4-4" />
  </Icon>
);

export const IconSignOut = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 5.5V4.5A1.5 1.5 0 0 0 12.5 3h-7A1.5 1.5 0 0 0 4 4.5v15A1.5 1.5 0 0 0 5.5 21h7a1.5 1.5 0 0 0 1.5-1.5v-1" />
    <path d="M10 12h10m0 0-3.5-3.5M20 12l-3.5 3.5" />
  </Icon>
);

export const IconCalendar = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4" y="5.5" width="16" height="15" rx="2.5" />
    <line x1="4" y1="10" x2="20" y2="10" />
    <line x1="8.5" y1="3.5" x2="8.5" y2="7" />
    <line x1="15.5" y1="3.5" x2="15.5" y2="7" />
  </Icon>
);

export const IconUsers = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
    <path d="M16 5.2a3.2 3.2 0 0 1 0 5.6" />
    <path d="M17 14.2a5.5 5.5 0 0 1 3.5 4.8" />
  </Icon>
);

export const IconLock = (p: IconProps) => (
  <Icon {...p}>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    <circle cx="12" cy="15" r="1.3" fill="currentColor" stroke="none" />
  </Icon>
);

export const IconSparkle = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5c.6 3.9 1.6 4.9 5.5 5.5-3.9.6-4.9 1.6-5.5 5.5-.6-3.9-1.6-4.9-5.5-5.5 3.9-.6 4.9-1.6 5.5-5.5z" />
    <path d="M18 15c.3 1.7.8 2.2 2.5 2.5-1.7.3-2.2.8-2.5 2.5-.3-1.7-.8-2.2-2.5-2.5 1.7-.3 2.2-.8 2.5-2.5z" />
  </Icon>
);

/**
 * A radiant burst — the mark on the "Summarize" / Claude-connector button. A
 * simple generic sunburst (twelve tapering rays), drawn with currentColor so
 * it reads white on the brand-colored button.
 */
export const IconClaude = (p: IconProps) => (
  <Icon {...p} strokeWidth={2}>
    {Array.from({ length: 12 }, (_, i) => {
      const a = (i * Math.PI) / 6;
      const r1 = i % 2 === 0 ? 3.4 : 4.2;
      const r2 = i % 2 === 0 ? 9.2 : 7.6;
      const x1 = 12 + Math.cos(a) * r1;
      const y1 = 12 + Math.sin(a) * r1;
      const x2 = 12 + Math.cos(a) * r2;
      const y2 = 12 + Math.sin(a) * r2;
      return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />;
    })}
  </Icon>
);
