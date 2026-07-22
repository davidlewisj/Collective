import "./env.js"; // .env auto-loading — must be first so adapters see the values
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditLog } from "./audit.js";
import { buildApp } from "./http.js";
import { makeTranscriber } from "./adapters/transcriber.js";
import {
  DiskAudioStore,
  StateSnapshotStore,
  appendAuditEvent,
  loadAuditEvents,
} from "./persist.js";
import { MsGraph, graphConfigFromEnv } from "./msgraph.js";
import { OAuthProvider, oauthConfigFromEnv } from "./oauth.js";
import { makeRelayFactory } from "./relay.js";
import { startRetentionWorker } from "./retention.js";
import { applyEnvOverrides, createDb, seedUsers } from "./store.js";

const serverDir = dirname(dirname(fileURLToPath(import.meta.url))); // apps/server
const dataDir = resolve(process.env.COLLECTIVE_DATA_DIR ?? join(serverDir, ".data"));

// Single-origin serving: if a built web app is present (or COLLECTIVE_WEB_DIR
// points at one), the server serves it too — the deploy topology (docs/deploy.md).
const webDir = process.env.COLLECTIVE_WEB_DIR
  ? resolve(process.env.COLLECTIVE_WEB_DIR)
  : join(dirname(serverDir), "web", "dist"); // apps/web/dist

const db = createDb();
seedUsers(db);

// Durable state: hydrate the snapshot, then let env-configured policy win.
const snapshot = new StateSnapshotStore(dataDir, db);
const restored = snapshot.load();
const overrides = applyEnvOverrides(db);
if (overrides.length) console.log(`env overrides: ${overrides.join(", ")}`);

// Durable audit: reload the journal, verify the chain, keep appending.
const audit = new AuditLog();
const priorEvents = loadAuditEvents(dataDir);
const tamperedAt = audit.hydrate(priorEvents);
if (tamperedAt >= 0) {
  console.error(`⚠ AUDIT CHAIN BROKEN at event ${tamperedAt + 1} — journal preserved; investigate before trusting it`);
}
audit.onEvent = (event) => appendAuditEvent(dataDir, event);

const transcriber = makeTranscriber();

// Local demo convenience: with the mock transcriber nothing leaves the
// machine, so the BAA registry is pre-marked satisfied to show the full
// experience. With a REAL adapter the registry starts all-false and §6.6
// gating fails safe — flip entries in /admin (or seed via COLLECTIVE_BAA)
// only as executed BAAs are filed (CP-1/CP-4).
if (transcriber.name === "mock") {
  db.baa = { assemblyai: true, claudeWorkspace: true, microsoft: true };
  console.log("dev mode: mock transcriber — BAA registry pre-set for local demo");
}

const audioStore = new DiskAudioStore(dataDir);
const upstreamFactory = makeRelayFactory();
const graphCfg = graphConfigFromEnv();
const graph = graphCfg ? new MsGraph(graphCfg) : null;
const oauthCfg = oauthConfigFromEnv();
const oauth = new OAuthProvider(db, audit, oauthCfg);
const servingWeb = existsSync(join(webDir, "index.html"));
const app = buildApp({
  db,
  audit,
  transcriber,
  audioStore,
  upstreamFactory,
  graph,
  oauth,
  webDir: servingWeb ? webDir : undefined,
});
snapshot.startAutosave();
startRetentionWorker(db, audit, audioStore);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    snapshot.stop(); // final save
    process.exit(0);
  });
}

const port = Number(process.env.PORT ?? 4000);
app
  .listen({ port, host: "0.0.0.0" })
  .then(() => {
    console.log(`Collective server on :${port}`);
    console.log(
      `  transcriber: ${transcriber.name}  live-captions: ${
        transcriber.name === "mock" ? "mock" : upstreamFactory ? "streaming relay" : "off"
      }  summaries: via Claude connector (D10)`,
    );
    console.log(
      `  data: ${dataDir} (${restored ? `restored ${db.meetings.size} meeting(s), ${priorEvents.length} audit events` : "fresh"})`,
    );
    console.log(`  microsoft sign-in: ${graph ? "on (Entra ID)" : "off — set GRAPH_TENANT_ID/GRAPH_CLIENT_ID/GRAPH_CLIENT_SECRET"}`);
    console.log(`  mcp oauth: issuer ${oauthCfg.issuer} (set COLLECTIVE_PUBLIC_URL for a public deploy)`);
    console.log(`  web app: ${servingWeb ? `serving ${webDir} (single origin)` : "not bundled — run the Vite dev server separately"}`);
    console.log(`  dev users: dana@ | omar@ | priya@ | casey@  (collective.dev)`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
