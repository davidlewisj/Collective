import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  getCalendarPreview,
  getConnectorTokenStatus,
  getSettings,
  mintConnectorToken,
  putSettings,
  revokeConnectorToken,
} from "../api";

function CalendarCard() {
  const [url, setUrl] = useState("");
  const [saved, setSaved] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    getSettings()
      .then((s) => setUrl(s.calendarIcsUrl ?? ""))
      .catch(() => setSaved("error"));
  }, []);

  const save = async () => {
    setSaved("saving");
    try {
      await putSettings({ calendarIcsUrl: url.trim() });
      setSaved("saved");
    } catch {
      setSaved("error");
    }
  };

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
    <section className="admin-card admin-card-wide">
      <h2 className="section-heading">Calendar</h2>
      <p className="admin-hint">
        Paste your calendar's secret ICS address and new captures are named after the meeting you're in, with
        attendees pre-filled when their email matches a teammate. Outlook: Settings → Calendar → Shared calendars
        → Publish a calendar → ICS link. Google: calendar Settings → "Secret address in iCal format". Treat the
        URL like a password — anyone holding it can read your calendar.
      </p>
      <div className="retention-confirm-row">
        <input
          type="url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setSaved("idle");
          }}
          placeholder="https://outlook.office365.com/owa/calendar/…/calendar.ics"
          aria-label="Calendar ICS address"
          autoComplete="off"
        />
        <button type="button" className="btn" onClick={() => void save()}>
          Save
        </button>
        <button type="button" className="btn-quiet" onClick={() => void test()} disabled={!url.trim()}>
          Test
        </button>
      </div>
      <p className="detail-muted" aria-live="polite">
        {saved === "saving" ? "Saving…" : saved === "saved" ? "Saved." : saved === "error" ? "Couldn't save." : ""}
        {preview ? ` ${preview}` : ""}
      </p>
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
    <section className="admin-card admin-card-wide">
      <h2 className="section-heading">Connect Claude Desktop</h2>
      <p className="admin-hint">
        This is how you get summaries, action items, and answers from your meeting archive — ask Claude
        ("summarize yesterday's huddle", "what did we decide about the intake forms?").
        Generate a connector token, add the snippet below to Claude Desktop's config file
        (%APPDATA%\Claude\claude_desktop_config.json on Windows), restart Claude Desktop, and ask away. The token
        only reaches the archive tools — never audio, never other people's notes — every request is permission-
        checked and audited, and patient-info-flagged meetings stay hidden per the BAA registry. For Claude on
        the web (claude.ai), an org admin sets up a connector under Admin → Claude connectors, and this server
        must be reachable from the internet (part of the hosted deployment).
      </p>
      {freshToken ? (
        <>
          <p className="detail-muted">
            Copy this now — it's shown once. Generating a new token revokes this one.
          </p>
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

export function SettingsPage() {
  return (
    <main className="admin-page">
      <header className="detail-topbar">
        <Link to="/" className="btn-quiet">
          ← Meetings
        </Link>
        <h1 className="admin-headline">Settings</h1>
      </header>
      <CalendarCard />
      <ConnectClaudeCard />
    </main>
  );
}
