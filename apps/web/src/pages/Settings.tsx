import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import type {
  AuditEvent,
  BaaRegistry,
  ConsentMechanism,
  ConsentPolicy,
  RetentionPolicy,
} from "@collective/shared";
import {
  ApiError,
  approveMember,
  createOAuthClient,
  deactivateMember,
  deleteOAuthClient,
  deleteVoiceprint,
  denyMember,
  enrollVoiceprint,
  getAudit,
  getBaaRegistry,
  getCalendarPreview,
  getConnectorTokenStatus,
  getConsentPolicy,
  getMembers,
  getRetention,
  getSettings,
  getVoiceprint,
  listOAuthClients,
  mintConnectorToken,
  putAppearance,
  putBaaRegistry,
  putConsentPolicy,
  putRetention,
  putSettings,
  reactivateMember,
  revokeConnectorToken,
  type Member,
  type OAuthClient,
  type VoiceprintStatus,
} from "../api";
import { useAuth } from "../auth";
import { useUsers } from "../lib/useUsers";
import { hueVar } from "../components/Avatar";
import { blobToBase64 } from "../lib/audio";
import { getStoredTheme, setTheme, type ThemePref } from "../lib/theme";
import {
  IconCalendar,
  IconCheck,
  IconChevronLeft,
  IconMic,
  IconShield,
  IconSliders,
  IconSparkle,
  IconX,
} from "../components/icons";

type SaveState = "idle" | "saving" | "saved" | "error";

function SaveNote({ state }: { state: SaveState }) {
  return (
    <span className={`notes-save notes-save-${state}`} aria-live="polite">
      {state === "saved" && <IconCheck size={14} />}
      {state === "saving" ? "Saving…" : state === "saved" ? "Saved" : state === "error" ? "Couldn't save" : ""}
    </span>
  );
}

/* --------------------------- floating save bar --------------------------- */

/**
 * A page-level save bar: editable cards register a `dirty` flag and a `save`
 * fn; when anything is unsaved a bar floats bottom-right and saves them all at
 * once. Destructive edits (retention) keep their own confirm-gated button and
 * stay out of the bar. Bubble color + theme apply instantly, also out of band.
 */
interface Saver {
  dirty: boolean;
  save: () => Promise<void>;
}
const SaveBarCtx = createContext<{ report: (id: string, s: Saver | null) => void } | null>(null);

/** Register a card's dirty state + save fn with the bar (only while dirty). */
function useRegisterSaver(id: string, dirty: boolean, save: () => Promise<void>) {
  const bar = useContext(SaveBarCtx);
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    bar?.report(id, dirty ? { dirty, save: () => saveRef.current() } : null);
    return () => bar?.report(id, null);
  }, [id, dirty, bar]);
}

function SettingsSaveBar({ children }: { children: ReactNode }) {
  const [savers, setSavers] = useState<Record<string, Saver>>({});
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const report = useCallback((id: string, s: Saver | null) => {
    setSavers((prev) => {
      if (!s || !s.dirty) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: s };
    });
  }, []);
  // Stable context value: a fresh object here would change the `bar` dep in
  // every useRegisterSaver effect on each provider render → update loop.
  const ctx = useMemo(() => ({ report }), [report]);

  const dirty = Object.values(savers);
  const saveAll = async () => {
    setSaving(true);
    setFailed(false);
    const results = await Promise.allSettled(dirty.map((s) => s.save()));
    setSaving(false);
    if (results.some((r) => r.status === "rejected")) setFailed(true);
  };

  return (
    <SaveBarCtx.Provider value={ctx}>
      {children}
      {dirty.length > 0 && (
        <div className="save-bar" role="region" aria-label="Unsaved changes">
          <span className="save-bar-text">
            {failed
              ? "Some changes couldn't be saved — try again"
              : `${dirty.length} unsaved change${dirty.length > 1 ? "s" : ""}`}
          </span>
          <button type="button" className="btn save-bar-btn" disabled={saving} onClick={() => void saveAll()}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      )}
    </SaveBarCtx.Provider>
  );
}

/* ============================== zone: You ============================== */

/** 0 = accent (default); 1..8 = a speaker-ramp swatch. */
function swatchVar(i: number): string {
  return i === 0 ? "var(--c-juniper)" : hueVar(i);
}

function ProfileCard() {
  const { user } = useAuth();
  const roleLabel =
    user?.role === "org_admin"
      ? "Organization admin"
      : user?.role === "compliance_auditor"
        ? "Compliance auditor"
        : "Member";
  return (
    <section id="profile" className="set-card">
      <h2 className="section-heading section-heading-icon">
        <IconSliders size={20} />
        Profile
      </h2>
      <dl className="profile-facts">
        <div>
          <dt>Name</dt>
          <dd>{user?.displayName ?? "—"}</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd className="mono">{user?.email ?? "—"}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>
            <span className="role-badge">{roleLabel}</span>
          </dd>
        </div>
      </dl>
      <p className="set-hint">Your name and role come from your organization's directory.</p>
    </section>
  );
}

function AppearanceCard() {
  const { user } = useAuth();
  const [selected, setSelected] = useState<number>(user?.bubbleHue ?? 0);
  const [saved, setSaved] = useState<SaveState>("idle");
  const [theme, setThemePref] = useState<ThemePref>(() => getStoredTheme());

  const pick = async (i: number) => {
    setSelected(i);
    setSaved("saving");
    try {
      await putAppearance(i);
      setSaved("saved");
    } catch {
      setSaved("error");
    }
  };

  const chooseTheme = (t: ThemePref) => {
    setThemePref(t);
    setTheme(t);
  };

  const THEMES: Array<{ key: ThemePref; label: string }> = [
    { key: "light", label: "Light" },
    { key: "dark", label: "Dark" },
    { key: "system", label: "System" },
  ];

  return (
    <section id="appearance" className="set-card">
      <h2 className="section-heading section-heading-icon">
        <IconSparkle size={20} />
        Appearance
      </h2>

      <h3 className="set-subhead">Your bubble color</h3>
      <p className="set-hint">
        The color of your speech bubbles when you're the meeting facilitator — everyone sees it on your turns.
      </p>
      <div className="swatch-row" role="radiogroup" aria-label="Bubble color">
        {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
          <button
            key={i}
            type="button"
            role="radio"
            aria-checked={selected === i}
            aria-label={i === 0 ? "Default (accent)" : `Color ${i}`}
            className={`swatch${selected === i ? " swatch-on" : ""}`}
            style={{ "--swatch": swatchVar(i) } as React.CSSProperties}
            onClick={() => void pick(i)}
          >
            {selected === i && <IconCheck size={16} />}
          </button>
        ))}
      </div>
      <div className="swatch-preview">
        <span
          className="bubble-group bubble-right bubble-kind-owner"
          style={{ "--bubble": swatchVar(selected) } as React.CSSProperties}
        >
          <span className="bubble-stack">
            <span className="bubble">This is how your turns will look.</span>
          </span>
        </span>
      </div>
      <p className="detail-muted set-inline-note" aria-live="polite">
        {saved === "saving" ? "Saving…" : saved === "saved" ? "Saved." : saved === "error" ? "Couldn't save." : ""}
      </p>

      <h3 className="set-subhead">Theme</h3>
      <p className="set-hint">Choose a light or dark look, or follow your device.</p>
      <div className="segmented theme-toggle" role="radiogroup" aria-label="Theme">
        {THEMES.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={theme === key}
            className={theme === key ? "seg-on" : ""}
            onClick={() => chooseTheme(key)}
          >
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}

function VoiceCard() {
  const [status, setStatus] = useState<VoiceprintStatus | null>(null);
  const [phase, setPhase] = useState<"idle" | "recording" | "enrolling" | "error">("idle");
  const [consent, setConsent] = useState(false);

  useEffect(() => {
    getVoiceprint().then(setStatus).catch(() => {});
  }, []);

  const record = async () => {
    setPhase("recording");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(
        (t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t),
      );
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setPhase("enrolling");
        try {
          const b64 = await blobToBase64(new Blob(chunks, { type: rec.mimeType }));
          setStatus(await enrollVoiceprint(b64));
          setPhase("idle");
        } catch {
          setPhase("error");
        }
      };
      rec.start();
      window.setTimeout(() => {
        if (rec.state !== "inactive") rec.stop();
      }, 4000);
    } catch {
      setPhase("error");
    }
  };

  const remove = async () => {
    try {
      setStatus(await deleteVoiceprint());
      setConsent(false);
    } catch {
      /* leave as-is */
    }
  };

  return (
    <section id="voice" className="set-card">
      <h2 className="section-heading section-heading-icon">
        <IconMic size={20} />
        Voice recognition
      </h2>
      <p className="set-hint">
        Enroll your voice once and Collective can label your turns automatically in future meetings — no need to
        tag yourself each time. Your voiceprint is biometric data: it's used only for speaker attribution, never
        shared, and you can delete it anytime.
      </p>
      {status?.enrolled ? (
        <div className="voice-enrolled">
          <span className="consent-chip consent-chip-ok">
            <IconCheck size={16} />
            Enrolled{status.createdAt ? ` · ${new Date(status.createdAt).toLocaleDateString("en-US")}` : ""}
          </span>
          <button type="button" className="btn-quiet" onClick={() => void remove()}>
            Remove my voiceprint
          </button>
        </div>
      ) : (
        <>
          <label className="toggle-row">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>I consent to Collective creating a voiceprint of my voice for speaker recognition.</span>
          </label>
          <div className="admin-card-foot">
            <button
              type="button"
              className="btn icon-text-btn"
              disabled={!consent || phase === "recording" || phase === "enrolling"}
              onClick={() => void record()}
            >
              <IconMic size={18} />
              {phase === "recording"
                ? "Listening… speak now"
                : phase === "enrolling"
                  ? "Saving…"
                  : "Record a 4-second sample"}
            </button>
          </div>
          {phase === "error" && (
            <p className="field-error" role="alert">
              Couldn't capture a sample — allow microphone access and try again.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function CalendarCard() {
  const [url, setUrl] = useState("");
  const [savedUrl, setSavedUrl] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    getSettings()
      .then((s) => {
        setUrl(s.calendarIcsUrl ?? "");
        setSavedUrl(s.calendarIcsUrl ?? "");
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const dirty = loaded && url.trim() !== savedUrl;
  const save = async () => {
    const next = url.trim();
    await putSettings({ calendarIcsUrl: next });
    setSavedUrl(next);
  };
  useRegisterSaver("calendar", dirty, save);

  const test = async () => {
    setPreview("Checking…");
    try {
      const event = await getCalendarPreview();
      setPreview(
        event
          ? `A capture started now would be named "${event.title}"${
              event.attendeeEmails.length ? ` (${event.attendeeEmails.length} attendee(s) on the invite)` : ""
            }.`
          : "No calendar event covers this moment — captures started now stay untitled.",
      );
    } catch {
      setPreview("Couldn't read that feed. Check the URL (and that it's the ICS address, not the calendar page).");
    }
  };

  return (
    <section id="calendar" className="set-card">
      <h2 className="section-heading section-heading-icon">
        <IconCalendar size={20} />
        Calendar
      </h2>
      <p className="set-hint">
        Paste your calendar's secret ICS address and new captures are named after the meeting you're in, with
        attendees pre-filled when their email matches a teammate.{" "}
        <button type="button" className="link-button" onClick={() => setShowHelp((v) => !v)} aria-expanded={showHelp}>
          {showHelp ? "Hide setup steps" : "Where do I find this?"}
        </button>
      </p>
      {showHelp && (
        <p className="set-hint set-hint-disclosed">
          Outlook: Settings → Calendar → Shared calendars → Publish a calendar → ICS link. Google: calendar
          Settings → "Secret address in iCal format". Treat the URL like a password — anyone holding it can read
          your calendar.
        </p>
      )}
      <div className="retention-confirm-row">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://outlook.office365.com/owa/calendar/…/calendar.ics"
          aria-label="Calendar ICS address"
          autoComplete="off"
        />
        <button type="button" className="btn-quiet" onClick={() => void test()} disabled={!url.trim()}>
          Test
        </button>
      </div>
      {preview && (
        <p className="detail-muted set-inline-note" aria-live="polite">
          {preview}
        </p>
      )}
    </section>
  );
}

function ConnectClaudeCard() {
  const [status, setStatus] = useState<{ exists: boolean; createdAt: string | null } | null>(null);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = () => {
    getConnectorTokenStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  };
  useEffect(refresh, []);

  const mint = async () => {
    setFreshToken(await mintConnectorToken());
    setCopied(false);
    refresh();
  };
  const revoke = async () => {
    await revokeConnectorToken();
    setFreshToken(null);
    refresh();
  };

  const snippet = freshToken
    ? JSON.stringify(
        {
          mcpServers: {
            collective: {
              command: "npx",
              args: ["-y", "mcp-remote", "http://localhost:4000/mcp", "--header", `Authorization: Bearer ${freshToken}`],
            },
          },
        },
        null,
        2,
      )
    : null;

  return (
    <section id="claude" className="set-card">
      <h2 className="section-heading section-heading-icon">
        <IconSparkle size={20} />
        Connect Claude Desktop
      </h2>
      <p className="set-hint">
        This is how you get summaries, action items, and answers from your meeting archive — ask Claude
        ("summarize yesterday's huddle", "what did we decide about the intake forms?"). Generate a connector
        token, add the snippet below to Claude Desktop's config file
        (%APPDATA%\Claude\claude_desktop_config.json on Windows), restart Claude Desktop, and ask away. The token
        only reaches the archive tools — never audio, never other people's notes — every request is permission-
        checked and audited, and patient-info-flagged meetings stay hidden per the BAA registry. For Claude on
        the web (claude.ai), an org admin sets up a connector (Workspace → Claude connectors), and this server
        must be reachable from the internet.
      </p>
      {freshToken ? (
        <>
          <p className="detail-muted">Copy this now — it's shown once. Generating a new token revokes this one.</p>
          <div className="audit-scroll">
            <pre className="mono connector-snippet">{snippet}</pre>
          </div>
          <div className="admin-card-foot">
            <button
              type="button"
              className="btn"
              onClick={() => {
                void navigator.clipboard.writeText(snippet ?? "").then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy config snippet"}
            </button>
            <button type="button" className="btn-quiet" onClick={() => void revoke()}>
              Revoke token
            </button>
          </div>
        </>
      ) : (
        <div className="admin-card-foot">
          <button type="button" className="btn" onClick={() => void mint()}>
            {status?.exists ? "Generate new token (revokes the old one)" : "Generate connector token"}
          </button>
          {status?.exists && (
            <>
              <span className="detail-muted">
                Active token since {status.createdAt ? new Date(status.createdAt).toLocaleString("en-US") : "—"}
              </span>
              <button type="button" className="btn-quiet" onClick={() => void revoke()}>
                Revoke
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

/* =========================== zone: Workspace =========================== */

const BAA_LABELS: Array<{ key: keyof BaaRegistry; label: string; hint: string }> = [
  { key: "assemblyai", label: "AssemblyAI", hint: "Transcription" },
  { key: "claudeWorkspace", label: "Claude workspace", hint: "Claude connector (summaries & Q&A)" },
  { key: "microsoft", label: "Microsoft", hint: "Sign-in & calendar" },
  { key: "voice", label: "Voice vendor", hint: "Voiceprint recognition" },
];

const MECHANISMS: Array<{ key: ConsentMechanism; label: string }> = [
  { key: "verbal_announcement_attested", label: "Verbal announcement (attested)" },
  { key: "audible_tone", label: "Audible tone" },
  { key: "invite_disclosure", label: "Disclosure in the invite" },
  { key: "participant_ack", label: "Participant acknowledgment" },
  { key: "teams_banner", label: "Teams recording banner" },
];

/** Read-only "compliance at a glance" strip at the top of the workspace zone. */
function ComplianceGlance() {
  const [baa, setBaa] = useState<BaaRegistry | null>(null);
  const [consent, setConsent] = useState<ConsentPolicy | null>(null);
  const [retention, setRetention] = useState<RetentionPolicy | null>(null);

  useEffect(() => {
    getBaaRegistry().then(setBaa).catch(() => {});
    getConsentPolicy().then(setConsent).catch(() => {});
    getRetention().then(setRetention).catch(() => {});
  }, []);

  const baaOnFile = baa ? BAA_LABELS.filter(({ key }) => baa[key]).length : null;
  const stat = (value: string, label: string) => (
    <div className="glance-stat">
      <span className="glance-value">{value}</span>
      <span className="glance-label">{label}</span>
    </div>
  );

  return (
    <div className="glance-strip" aria-label="Compliance at a glance">
      {stat(baaOnFile === null ? "—" : `${baaOnFile}/${BAA_LABELS.length}`, "BAAs on file")}
      {stat(consent ? String(consent.requiredMechanisms.length) : "—", "Consent steps")}
      {stat(retention ? `${retention.audioDays}d` : "—", "Audio kept")}
      {stat(retention ? `${retention.transcriptDays}d` : "—", "Transcripts kept")}
    </div>
  );
}

function roleLabel(role: string): string {
  switch (role) {
    case "org_admin":
      return "Admin";
    case "entity_admin":
      return "Entity admin";
    case "compliance_auditor":
      return "Auditor";
    case "guest_viewer":
      return "Guest";
    default:
      return "Member";
  }
}

/**
 * Org directory + join-request approvals (org_admin only). Everyone who signs
 * in lands here; new sign-ins are `pending` and can't touch content until an
 * admin approves them (server enforces the 403 gate — this is the control).
 */
function DirectoryCard() {
  const { user: me } = useAuth();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Id of the member whose off-board is awaiting an inline confirm.
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const refresh = () => {
    getMembers()
      .then(setMembers)
      .catch(() => setMembers([]));
  };
  useEffect(refresh, []);

  const act = async (id: string, fn: (id: string) => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await fn(id);
      refresh();
    } catch (e) {
      // Surface the server's reason for business-rule refusals (e.g. the
      // last-admin block); keep internal codes out of the UI otherwise.
      const reason = e instanceof ApiError && e.status === 409 ? e.code : "Couldn't complete that action. Try again.";
      setError(reason.charAt(0).toUpperCase() + reason.slice(1));
    } finally {
      setBusy(null);
    }
  };

  const pending = members?.filter((m) => m.status === "pending") ?? [];
  const active = members?.filter((m) => m.status === "active") ?? [];
  // Usable administrators (active, not deactivated). One is a lock-out risk: if
  // that account is lost — e.g. removed from Microsoft — nobody can manage the
  // workspace. The server also refuses to demote the last admin.
  const adminCount = (members ?? []).filter(
    (m) => m.role === "org_admin" && m.status === "active" && !m.deactivated,
  ).length;

  return (
    <section id="directory" className="set-card workspace-card">
      <h2 className="section-heading">Directory</h2>
      <p className="set-hint">
        Everyone who has signed in to this workspace. A new sign-in waits here as a join request until you
        approve it — until then it can't reach any meeting, transcript, or note.
      </p>

      {members !== null && adminCount <= 1 && (
        <p className="directory-warn" role="status">
          Only one administrator on this workspace. Add a second org admin as a backup so you're not locked
          out if this account is lost — for example, if it's removed from Microsoft.
        </p>
      )}

      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}

      {pending.length > 0 && (
        <div className="directory-group">
          <h3 className="directory-group-title">
            Join requests <span className="directory-count">{pending.length}</span>
          </h3>
          <ul className="member-list">
            {pending.map((m) => (
              <li key={m.id} className="member-row member-row-pending">
                <div className="member-ident">
                  <span className="member-name">{m.displayName}</span>
                  <span className="detail-muted">{m.email}</span>
                </div>
                <div className="member-actions">
                  <button
                    type="button"
                    className="btn icon-text-btn"
                    disabled={busy === m.id}
                    onClick={() => void act(m.id, approveMember)}
                  >
                    <IconCheck size={16} />
                    <span>Approve</span>
                  </button>
                  <button
                    type="button"
                    className="btn-quiet icon-text-btn"
                    disabled={busy === m.id}
                    onClick={() => void act(m.id, denyMember)}
                  >
                    <IconX size={16} />
                    <span>Deny</span>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="directory-group">
        <h3 className="directory-group-title">
          Members {active.length > 0 && <span className="directory-count">{active.length}</span>}
        </h3>
        {members === null ? (
          <p className="detail-muted">Loading…</p>
        ) : active.length === 0 ? (
          <p className="detail-muted">No approved members yet.</p>
        ) : (
          <ul className="member-list">
            {active.map((m) => (
              <li key={m.id} className={`member-row${m.deactivated ? " member-row-off" : ""}`}>
                <div className="member-ident">
                  <span className="member-name">{m.displayName}</span>
                  <span className="detail-muted">{m.email}</span>
                </div>
                <div className="member-tags">
                  {m.deactivated && <span className="member-tag member-tag-off">Deactivated</span>}
                  <span className="member-tag">{roleLabel(m.role)}</span>
                  {m.deactivated ? (
                    <button
                      type="button"
                      className="btn-quiet member-action"
                      disabled={busy === m.id}
                      onClick={() => void act(m.id, reactivateMember)}
                    >
                      Restore
                    </button>
                  ) : m.id === me?.id ? null : confirmId === m.id ? (
                    <span className="member-confirm">
                      <span className="detail-muted">Off-board?</span>
                      <button
                        type="button"
                        className="btn-quiet member-action-danger"
                        disabled={busy === m.id}
                        onClick={() => {
                          setConfirmId(null);
                          void act(m.id, deactivateMember);
                        }}
                      >
                        Off-board
                      </button>
                      <button type="button" className="btn-quiet" onClick={() => setConfirmId(null)}>
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn-quiet member-action"
                      onClick={() => {
                        setError(null);
                        setConfirmId(m.id);
                      }}
                    >
                      Off-board
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function BaaCard() {
  const [reg, setReg] = useState<BaaRegistry | null>(null);
  const [savedReg, setSavedReg] = useState<BaaRegistry | null>(null);

  useEffect(() => {
    getBaaRegistry()
      .then((r) => {
        setReg(r);
        setSavedReg(r);
      })
      .catch(() => {});
  }, []);

  const dirty = !!reg && !!savedReg && JSON.stringify(reg) !== JSON.stringify(savedReg);
  const save = async () => {
    if (!reg) return;
    setSavedReg(await putBaaRegistry(reg));
  };
  useRegisterSaver("baa", dirty, save);

  return (
    <section id="baa" className="set-card workspace-card">
      <h2 className="section-heading">BAA registry</h2>
      <p className="set-hint">
        A checked vendor has a signed Business Associate Agreement on file. Unchecked vendors are blocked from
        patient-info meetings.
      </p>
      {reg ? (
        BAA_LABELS.map(({ key, label, hint }) => (
          <label key={key} className="toggle-row">
            <input type="checkbox" checked={reg[key]} onChange={(e) => setReg({ ...reg, [key]: e.target.checked })} />
            <span>{label}</span>
            <span className="admin-row-hint">{hint}</span>
          </label>
        ))
      ) : (
        <p className="detail-muted">Loading…</p>
      )}
    </section>
  );
}

function ConsentCard() {
  const [policy, setPolicy] = useState<ConsentPolicy | null>(null);
  const [savedPolicy, setSavedPolicy] = useState<ConsentPolicy | null>(null);

  useEffect(() => {
    getConsentPolicy()
      .then((p) => {
        setPolicy(p);
        setSavedPolicy(p);
      })
      .catch(() => {});
  }, []);

  const toggleMechanism = (m: ConsentMechanism, on: boolean) => {
    if (!policy) return;
    const set = new Set(policy.requiredMechanisms);
    if (on) set.add(m);
    else set.delete(m);
    setPolicy({ ...policy, requiredMechanisms: [...set] });
  };

  // Order-independent comparison for the mechanism list.
  const norm = (p: ConsentPolicy) => JSON.stringify({ m: [...p.requiredMechanisms].sort(), f: p.phiFailSafe });
  const dirty = !!policy && !!savedPolicy && norm(policy) !== norm(savedPolicy);
  const save = async () => {
    if (!policy) return;
    setSavedPolicy(await putConsentPolicy(policy));
  };
  useRegisterSaver("consent", dirty, save);

  return (
    <section id="consent" className="set-card workspace-card">
      <h2 className="section-heading">Consent policy</h2>
      <p className="set-hint">Steps required before a capture can start.</p>
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
        </>
      ) : (
        <p className="detail-muted">Loading…</p>
      )}
    </section>
  );
}

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
    <section id="retention" className="set-card workspace-card">
      <h2 className="section-heading">Retention</h2>
      <p className="set-hint">How long each layer is kept before automatic deletion. Changes apply org-wide.</p>
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
                <button type="button" className="btn" disabled={confirmText !== "CONFIRM"} onClick={() => void submit()}>
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

function ConnectorsCard() {
  const [clients, setClients] = useState<OAuthClient[] | null>(null);
  const [name, setName] = useState("Claude (claude.ai)");
  const [redirects, setRedirects] = useState("https://claude.ai/api/mcp/auth_callback");
  const [minted, setMinted] = useState<{ client: OAuthClient; clientSecret: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    listOAuthClients()
      .then(setClients)
      .catch(() => setClients([]));
  };
  useEffect(refresh, []);

  const create = async () => {
    const uris = redirects
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!name.trim() || uris.length === 0) {
      setError("Give the connector a name and at least one redirect URL.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setMinted(await createOAuthClient({ name: name.trim(), redirectUris: uris }));
      refresh();
    } catch {
      setError("Couldn't create the connector. Check the redirect URLs are valid.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (clientId: string) => {
    await deleteOAuthClient(clientId);
    if (minted?.client.clientId === clientId) setMinted(null);
    refresh();
  };

  return (
    <section id="connectors" className="set-card workspace-card">
      <h2 className="section-heading">Claude connectors (claude.ai)</h2>
      <p className="set-hint">
        Register an OAuth client so Claude on the web can connect to this workspace's archive. Create it here,
        then in claude.ai add a custom connector pointing at <span className="mono">{`${window.location.origin}/mcp`}</span> and
        paste in the client ID and secret. Each person still signs in as themselves and only sees what they're
        allowed to; patient-info-flagged meetings stay hidden per the BAA registry. (Claude Desktop uses a
        per-user token from the "Connect Claude Desktop" section above instead.)
      </p>

      {minted && (
        <div className="connector-minted">
          <p className="detail-muted">Copy the secret now — it's shown once. Paste both into claude.ai's connector settings.</p>
          <div className="audit-scroll">
            <pre className="mono connector-snippet">{`Client ID:     ${minted.client.clientId}
Client secret: ${minted.clientSecret}
Redirect URL:  ${minted.client.redirectUris.join(", ")}`}</pre>
          </div>
        </div>
      )}

      <div className="connector-form">
        <label htmlFor="oauth-name">Connector name</label>
        <input id="oauth-name" type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        <label htmlFor="oauth-redirects">Redirect URL(s)</label>
        <input
          id="oauth-redirects"
          type="text"
          value={redirects}
          onChange={(e) => setRedirects(e.target.value)}
          placeholder="https://claude.ai/api/mcp/auth_callback"
          autoComplete="off"
        />
        <div className="admin-card-foot">
          <button type="button" className="btn" disabled={busy} onClick={() => void create()}>
            {busy ? "Creating…" : "Create connector"}
          </button>
          {error && (
            <span className="field-error" role="alert">
              {error}
            </span>
          )}
        </div>
      </div>

      {clients && clients.length > 0 && (
        <ul className="connector-list">
          {clients.map((c) => (
            <li key={c.clientId} className="connector-list-row">
              <div>
                <span className="connector-list-name">{c.name}</span>
                <span className="detail-muted mono"> · {c.clientId}</span>
              </div>
              <button type="button" className="btn-quiet" onClick={() => void revoke(c.clientId)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

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
    <section id="audit" className="set-card workspace-card">
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

/* ================================ the page ============================= */

interface Anchor {
  id: string;
  label: string;
}

function MiniNav({ anchors, active }: { anchors: Anchor[]; active: string }) {
  return (
    <nav className="settings-nav" aria-label="Settings sections">
      {anchors.map((a) => (
        <a key={a.id} href={`#${a.id}`} className={`settings-nav-link${active === a.id ? " settings-nav-on" : ""}`}>
          {a.label}
        </a>
      ))}
    </nav>
  );
}

export function SettingsPage() {
  const { user } = useAuth();
  const location = useLocation();
  const isAdmin = user?.role === "org_admin";
  const isAuditor = user?.role === "compliance_auditor";
  const showWorkspace = isAdmin || isAuditor;

  const anchors: Anchor[] = [
    { id: "profile", label: "Profile" },
    { id: "appearance", label: "Appearance" },
    { id: "voice", label: "Voice" },
    { id: "calendar", label: "Calendar" },
    { id: "claude", label: "Connect Claude" },
    ...(showWorkspace ? [{ id: "workspace", label: "Workspace" } as Anchor] : []),
    ...(isAdmin
      ? ([
          { id: "directory", label: "Directory" },
          { id: "baa", label: "BAA registry" },
          { id: "consent", label: "Consent policy" },
          { id: "retention", label: "Retention" },
          { id: "connectors", label: "Claude connectors" },
        ] as Anchor[])
      : []),
    ...(showWorkspace ? [{ id: "audit", label: "Audit log" } as Anchor] : []),
  ];

  const [active, setActive] = useState(anchors[0]?.id ?? "profile");
  const colRef = useRef<HTMLDivElement>(null);

  // Scroll-spy: highlight the section nearest the top of the viewport.
  useEffect(() => {
    const sections = anchors
      .map((a) => document.getElementById(a.id))
      .filter((el): el is HTMLElement => el !== null);
    if (sections.length === 0) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-96px 0px -60% 0px", threshold: 0 },
    );
    sections.forEach((s) => obs.observe(s));
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchors.length]);

  // Honor a #hash on entry (e.g. /admin → /settings#workspace).
  useEffect(() => {
    const hash = location.hash.replace("#", "");
    if (!hash) return;
    const el = document.getElementById(hash);
    if (el) el.scrollIntoView({ behavior: "auto", block: "start" });
  }, [location.hash]);

  return (
    <SettingsSaveBar>
      <main className="settings-page">
        <header className="detail-topbar">
          <Link to="/" className="btn-quiet nav-link">
            <IconChevronLeft size={20} />
            <span>Meetings</span>
          </Link>
          <h1 className="settings-headline">Settings</h1>
        </header>

        <div className="settings-layout">
          <MiniNav anchors={anchors} active={active} />

          <div className="settings-col" ref={colRef}>
            <ProfileCard />
            <AppearanceCard />
            <VoiceCard />
            <CalendarCard />
            <ConnectClaudeCard />

            {showWorkspace && (
              <div className="workspace-well">
                <div id="workspace" className="workspace-banner">
                  <span className="workspace-banner-mark" aria-hidden="true">
                    <IconShield size={22} />
                  </span>
                  <div>
                    <h2 className="workspace-banner-title">Workspace</h2>
                    <p className="set-hint">
                      Organization-wide compliance controls.{" "}
                      {isAdmin ? "Changes here apply to everyone." : "You have read access to the audit log."}
                    </p>
                  </div>
                </div>
                {isAdmin && <ComplianceGlance />}
                {isAdmin && (
                  <>
                    <DirectoryCard />
                    <BaaCard />
                    <ConsentCard />
                    <RetentionCard />
                    <ConnectorsCard />
                  </>
                )}
                <AuditTable />
              </div>
            )}
          </div>
        </div>
      </main>
    </SettingsSaveBar>
  );
}
