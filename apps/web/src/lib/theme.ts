/**
 * Theme preference: light / dark / follow the OS ("system"). The compiled
 * tokens (`tokens.css`) already react to `:root[data-theme]` and, absent it,
 * to `prefers-color-scheme`. So "system" simply removes the attribute and lets
 * the media query decide; explicit choices stamp the attribute.
 */
export type ThemePref = "light" | "dark" | "system";

const KEY = "collective.theme";

export function getStoredTheme(): ThemePref {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

function applyTheme(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}

export function setTheme(pref: ThemePref): void {
  if (pref === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, pref);
  applyTheme(pref);
}

/** Apply the saved preference as early as possible (called from main.tsx). */
export function initTheme(): void {
  applyTheme(getStoredTheme());
}
