import "./env.js"; // .env auto-loading — must be first so adapters see the values
import { AuditLog } from "./audit.js";
import { buildApp } from "./http.js";
import { makeInsight } from "./adapters/insight.js";
import { makeTranscriber } from "./adapters/transcriber.js";
import { startRetentionWorker } from "./retention.js";
import { createDb, seedUsers } from "./store.js";

const db = createDb();
seedUsers(db);
const audit = new AuditLog();
const transcriber = makeTranscriber();
const insight = makeInsight();

// Local demo convenience: with mock adapters nothing leaves the machine, so
// the BAA registry is pre-marked satisfied to show the full experience. With
// REAL adapters the registry starts all-false and §6.6 gating fails safe —
// flip entries in /admin only as executed BAAs are filed (CP-1/CP-2/CP-4).
if (transcriber.name === "mock" && insight.name === "mock") {
  db.baa = { assemblyai: true, awsBedrock: true, claudeWorkspace: true, microsoft: true };
  console.log("dev mode: mock adapters — BAA registry pre-set for local demo");
}

const app = buildApp({ db, audit, transcriber, insight });
startRetentionWorker(db, audit);

const port = Number(process.env.PORT ?? 4000);
app
  .listen({ port, host: "0.0.0.0" })
  .then(() => {
    console.log(`Collective server on :${port}`);
    console.log(`  transcriber: ${transcriber.name}  insight: ${insight.name}`);
    console.log(`  dev users: dana@ | omar@ | priya@ | casey@  (collective.dev)`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
