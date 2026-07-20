import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type {
  AuditEvent,
  BaaRegistry,
  ConsentMechanism,
  ConsentPolicy,
  RetentionPolicy,
} from "@collective/shared";
import {
  getAudit,
  getBaaRegistry,
  getConsentPolicy,
  getRetention,
  putBaaRegistry,
  putConsentPolicy,
  putRetention,
} from "../api";
import { useAuth } from "../auth";
import { useUsers } from "../lib/useUsers";

type SaveState = "idle" | "saving" | "saved" | "error";

function SaveNote({ state }: { state: SaveState }) {
  return (
    <span className={`notes-save notes-save-${state}`} aria-live="polite">
      {state === "saving" ? "Saving…" : state === "saved" ? "Saved" : state === "error" ? "Couldn't save" : ""}
    </span>
  );
}

/* ------------------------------ BAA registry ----------------------------- */

const BAA_LABELS: Array<{ key: keyof BaaRegistry; label: string; hint: string }> = [
  { key: "assemblyai", label: "AssemblyAI", hint: "Transcription" },
  { key: "awsBedrock", label: "AWS Bedrock", hint: "AI summaries" },
  { key: "claudeWorkspace", label: "Claude workspace", hint: "MCP / connector access" },
  { key: "microsoft", label: "Microsoft", hint: "Teams & Graph" },
];

function BaaCard() {
  const [reg, setReg] = useState<BaaRegistry | null>(null);
  const [save, setSave] = useState<SaveState>("idle");

  useEffect(() => {
    getBaaRegistry().then(setReg).catch(() => setSave("error"));
  }, []);

  const submit = async () => {
    if (!reg) return;
    setSave("saving");
    try {
      setReg(await putBaaRegistry(reg));
      setSave("saved");
    } catch {
      setSave("error");
    }
  };

  return (
    <section className="admin-card">
      <h2 className="section-heading">BAA registry</h2>
      <p className="admin-hint">
        A checked vendor has a signed Business Associate Agreement on file. Unchecked vendors are
        blocked from patient-info meetings.
      </p>
      {reg ? (
        <>
          {BAA_LABELS.map(({ key, label, hint }) => (
            <label key={key} className="toggle-row">
              <input
                type="checkbox"
                checked={reg[key]}
                onChange={(e) => setReg({ ...reg, [key]: e.target.checked })}
              />
              <span>{label}</span>
              <span className="admin-row-hint">{hint}</span>
            </label>
          ))}
          <div className="admin-card-foot">
            <button type="button" className="btn" onClick={() => void submit()}>
              Save BAA registry
            </button>
            <SaveNote state={save} />
          </div>
        </>
      ) : (
        <p className="detail-muted">Loading…</p>
      )}
    </section>
  );
}

/* ----------------------------- consent policy ---------------------------- */

const MECHANISMS: Array<{ key: ConsentMechanism; label: string }> = [
  { key: "verbal_announcement_attested", label: "Verbal announcement (attested)" },
  { key: "audible_tone", label: "Audible tone" },
  { key: "invite_disclosure", label: "Disclosure in the invite" },
  { key: "participant_ack", label: "Participant acknowledgment" },
  { key: "teams_banner", label: "Teams recording banner" },
];

function ConsentCard() {
  const [policy, setPolicy] = useState<ConsentPolicy | null>(null);
  const [save, setSave] = useState<SaveState>("idle");

  useEffect(() => {
    getConsentPolicy().then(setPolicy).catch(() => setSave("error"));
  }, []);

  const toggleMechanism = (m: ConsentMechanism, on: boolean) => {
    if (!policy) return;
    const set = new Set(policy.requiredMechanisms);
    if (on) set.add(m);
    else set.delete(m);
    setPolicy({ ...policy, requiredMechanisms: [...set] });
  };

  const submit = async () => {
    if (!policy) return;
    setSave("saving");
    try {
      setPolicy(await putConsentPolicy(policy));
      setSave("saved");
    } catch {
      setSave("error");
    }
  };

  return (
    <section className="admin-card">
      <h2 className="section-heading">Consent policy</h2>
      <p className="admin-hint">Steps required before a capture can start.</p>
      {policy ? (
        <>
          {MECHANISMS.map(({ key, label }) => (
            <label key={key} className="toggle-row">
              <input
                type="checkbox"
                checked={policy.requiredMechanisms.includes(key)}
                onChange={(e) => toggleMechanism(key, e.target.checked)}
              />
              <span>{label}</span>
            </label>
          ))}
          <label className="toggle-row toggle-row-strong">
            <input
              type="checkbox"
              checked={policy.phiFailSafe}
              onChange={(e) => setPolicy({ ...policy, phiFailSafe: e.target.checked })}
            />
            <span>PHI fail-safe</span>
            <span className="admin-row-hint">Treat an unanswered patient-info flag as “yes”</span>
          </label>
          <div className="admin-card-foot">
            <button type="button" className="btn" onClick={() => void submit()}>
              Save consent policy
            </button>
            <SaveNote state={save} />
          </div>
        </>
      ) : (
        <p className="detail-muted">Loading…</p>
      )}
    </section>
  );
}

/* ------------------------------- retention ------------------------------- */

function RetentionCard() {
  const [policy, setPolicy] = useState<RetentionPolicy | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [save, setSave] = useState<SaveState>("idle");

  useEffect(() => {
    getRetention().then(setPolicy).catch(() => setSave("error"));
  }, []);

  const submit = async () => {
    if (!policy || confirmText !== "CONFIRM") return;
    setSave("saving");
    try {
      setPolicy(await putRetention(policy));
      setSave("saved");
      setConfirming(false);
      setConfirmText("");
    } catch {
      setSave("error");
    }
  };

  const numberRow = (key: keyof RetentionPolicy, label: string) =>
    policy && (
      <div className="retention-row">
        <label htmlFor={`ret-${key}`}>{label}</label>
        <input
          id={`ret-${key}`}
          type="number"
          min={1}
          value={policy[key]}
          onChange={(e) => setPolicy({ ...policy, [key]: Number(e.target.value) })}
        />
        <span className="admin-row-hint">days</span>
      </div>
    );

  return (
    <section className="admin-card">
      <h2 className="section-heading">Retention</h2>
      <p className="admin-hint">
        How long each layer is kept before automatic deletion. Changes apply org-wide.
      </p>
      {policy ? (
        <>
          {numberRow("audioDays", "Audio")}
          {numberRow("transcriptDays", "Transcripts")}
          {numberRow("auditDays", "Audit log")}
          {!confirming ? (
            <div className="admin-card-foot">
              <button type="button" className="btn" onClick={() => setConfirming(true)}>
                Save retention…
              </button>
              <SaveNote state={save} />
            </div>
          ) : (
            <div className="retention-confirm">
              <label htmlFor="retention-confirm-input">
                Retention changes can delete data on a schedule. Type CONFIRM to save.
              </label>
              <div className="retention-confirm-row">
                <input
                  id="retention-confirm-input"
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="CONFIRM"
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="btn"
                  disabled={confirmText !== "CONFIRM"}
                  onClick={() => void submit()}
                >
                  Save retention
                </button>
                <button
                  type="button"
                  className="btn-quiet"
                  onClick={() => {
                    setConfirming(false);
                    setConfirmText("");
                  }}
                >
                  Cancel
                </button>
              </div>
              <SaveNote state={save} />
            </div>
          )}
        </>
      ) : (
        <p className="detail-muted">Loading…</p>
      )}
    </section>
  );
}

/* --------------------------------- audit -------------------------------- */

function AuditTable() {
  const { byId } = useUsers();
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    getAudit()
      .then(setEvents)
      .catch(() => setFailed(true));
  }, []);

  return (
    <section className="admin-card admin-card-wide">
      <h2 className="section-heading">Audit log</h2>
      {failed ? (
        <p className="detail-muted" role="alert">
          Couldn't load the audit log.
        </p>
      ) : events === null ? (
        <p className="detail-muted">Loading…</p>
      ) : events.length === 0 ? (
        <p className="detail-muted">No events yet.</p>
      ) : (
        <div className="audit-scroll">
          <table className="audit-table mono">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                <th scope="col">Meeting</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.seq}>
                  <td>{new Date(e.at).toLocaleString("en-US")}</td>
                  <td>{byId.get(e.actorUserId)?.displayName ?? e.actorUserId}</td>
                  <td>{e.action}</td>
                  <td>{e.meetingId ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* -------------------------------- the page ------------------------------- */

export function AdminPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "org_admin";
  const isAuditor = user?.role === "compliance_auditor";

  return (
    <main className="admin-page">
      <header className="detail-topbar">
        <Link to="/" className="btn-quiet">
          ← Meetings
        </Link>
        <h1 className="admin-headline">Admin</h1>
      </header>
      {!isAdmin && !isAuditor ? (
        <p className="detail-muted" role="alert">
          This area is for org admins and compliance auditors.
        </p>
      ) : (
        <>
          {isAdmin && (
            <div className="admin-grid">
              <BaaCard />
              <ConsentCard />
              <RetentionCard />
            </div>
          )}
          <AuditTable />
        </>
      )}
    </main>
  );
}
