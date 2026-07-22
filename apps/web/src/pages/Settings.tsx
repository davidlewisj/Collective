import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  getCalendarPreview,
  getConnectorTokenStatus,
  getSettings,
  mintConnectorToken,
  putAppearance,
  putSettings,
  revokeConnectorToken,
} from "../api";
import { useAuth } from "../auth";
import { hueVar } from "../components/Avatar";
import { IconCheck } from "../components/icons";

/** 0 = accent (default); 1..8 = a speaker-ramp swatch. */
function swatchVar(i: number): string {
  return i === 0 ? "var(--c-juniper)" : hueVar(i);
}

function BubbleColorCard() {
  const { user } = useAuth();
  const [selected, setSelected] = useState<number>(user?.bubbleHue ?? 0);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved" | "error">("idle");

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

  return (
    <section className="admin-card admin-card-wide">
      <h2 className="section-heading">Your bubble color</h2>
      <p className="admin-hint">
        The color of your speech bubbles when you're the meeting facilitator — everyone sees it on your
        turns. Pick one:
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
        <span className="bubble-group bubble-right bubble-kind-owner" style={{ "--bubble": swatchVar(selected) } as React.CSSProperties}>
          <span className="bubble-stack">
            <span className="bubble">This is how your turns will look.</span>
          </span>
        </span>
      </div>
      <p className="detail-muted" aria-live="polite">
        {saved === "saving" ? "Saving…" : saved === "saved" ? "Saved." : saved === "error" ? "Couldn't save." : ""}
      </p>
    </section>
  );
}

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
      <BubbleColorCard />
      <CalendarCard />
      <ConnectClaudeCard />
    </main>
  );
}
