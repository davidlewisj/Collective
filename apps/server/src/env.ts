/**
 * Zero-dependency .env auto-loading. Imported first by main.ts, so vendor
 * adapters see the values when they read process.env.
 *
 * Looks for `.env` in the server package directory, then the repo root.
 * Real environment variables always win — a .env file never overrides them.
 * Syntax: KEY=VALUE lines; `#` comments and blank lines ignored; optional
 * surrounding single/double quotes stripped.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = dirname(dirname(fileURLToPath(import.meta.url))); // apps/server
const candidates = [join(serverDir, ".env"), join(serverDir, "..", "..", ".env")];

for (const file of candidates) {
  if (!existsSync(file)) continue;
  let loaded = 0;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
      loaded++;
    }
  }
  console.log(`env: loaded ${loaded} value(s) from ${file}`);
  break; // first file found wins
}
