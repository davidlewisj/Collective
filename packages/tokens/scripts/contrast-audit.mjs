// WCAG 2.1 contrast audit for token pairings (design-spec §7.2.2).
// Fails the build (exit 1) if any required pairing misses its ratio.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const t = JSON.parse(readFileSync(join(root, "tokens.json"), "utf8"));

function lum(hex) {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(a, b) {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

const failures = [];
for (const mode of ["light", "dark"]) {
  const c = t.color[mode];
  const checks = [
    // [fg, bg, min, label]
    [c.ink, c.linen, 4.5, "ink on linen (body text)"],
    [c.ink, c.surfaceRaised, 4.5, "ink on raised surface"],
    [c.sage, c.linen, 4.5, "sage on linen (secondary text)"],
    [c.juniper, c.linen, 4.5, "juniper on linen (links/actions)"],
    [c.state.recording, c.linen, 3.0, "recording state (UI component)"],
    [c.state.processing, c.linen, 3.0, "processing state (UI component)"],
    [c.state.shared, c.linen, 3.0, "shared state (UI component)"],
    [c.state.error, c.linen, 3.0, "error state (UI component)"],
    ...c.speaker.map((s, i) => [s, c.linen, 3.0, `speaker-${i + 1} chip on linen`]),
  ];
  for (const [fg, bg, min, label] of checks) {
    const r = ratio(fg, bg);
    if (r < min) failures.push(`${mode}: ${label} = ${r.toFixed(2)} (< ${min})`);
  }
}

if (failures.length) {
  console.error("Contrast audit FAILED:\n" + failures.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}
console.log("Contrast audit passed (WCAG 2.1 AA pairings, light + dark).");
