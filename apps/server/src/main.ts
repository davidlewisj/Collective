import "./env.js"; // .env auto-loading — must be first so adapters see the values
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditLog } from "./audit.js";
import { buildApp } from "./http.js";
import { makeInsight } from "./adapters/insight.js";
import { makeTranscriber } from "./adapters/transcriber.js";
import {
  DiskAudioStore,
  StateSnapshotStore,
  appendAuditEvent,
  loadAuditEvents,
} from "./persist.js";
import { startRetentionWorker } from "./retention.js";
import { applyEnvOverrides, createDb, seedUsers } from "./store.js";

const serverDir = dirname(dirname(fileURLToPath(import.meta.url))); // apps/server
const dataDir = resolve(process.env.COLLECTIVE_DATA_DIR ?? join(serverDir, ".data"));

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
const insight = makeInsight();

// Local demo convenience: with mock adapters nothing leaves the machine, so
// the BAA registry is pre-marked satisfied to show the full experience. With
// REAL adapters the registry starts all-false and §6.6 gating fails safe —
// flip entries in /admin (or seed via COLLECTIVE_BAA) only as executed BAAs
// are filed (CP-1/CP-2/CP-4).
if (transcriber.name === "mock" && insight.name === "mock") {
  db.baa = { assemblyai: true, awsBedrock: true, claudeWorkspace: true, microsoft: true };
  console.log("dev mode: mock adapters — BAA registry pre-set for local demo");
}

const audioStore = new DiskAudioStore(dataDir);
const app = buildApp({ db, audit, transcriber, insight, audioStore });
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
    console.log(`  transcriber: ${transcriber.name}  insight: ${insight.name}`);
    console.log(
      `  data: ${dataDir} (${restored ? `restored ${db.meetings.size} meeting(s), ${priorEvents.length} audit events` : "fresh"})`,
    );
    console.log(`  dev users: dana@ | omar@ | priya@ | casey@  (collective.dev)`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
