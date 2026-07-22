import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Meeting, ShareGrant } from "@collective/shared";
import { listMeetings, search, type SearchHit } from "../api";
import { useAuth } from "../auth";
import { useUsers } from "../lib/useUsers";
import { dateGroupLabel, fmtTimeOfDay, meetingDuration } from "../lib/format";
import { Avatar } from "../components/Avatar";
import { StateBadge } from "../components/Badges";
import { RecordButton } from "../components/RecordButton";
import { IconSearch, IconShield, IconSignOut, IconSliders } from "../components/icons";

/** Some servers annotate meetings with their grants; render "Shared" if so. */
type MeetingMaybeShared = Meeting & { shares?: ShareGrant[]; shared?: boolean };

function isShared(m: Meeting): boolean {
  const x = m as MeetingMaybeShared;
  return x.shared === true || (Array.isArray(x.shares) && x.shares.length > 0);
}

function MeetingRow({ meeting }: { meeting: Meeting }) {
  const { byId } = useUsers();
  const when = meeting.startedAt ?? meeting.createdAt;
  const duration = meetingDuration(meeting.startedAt, meeting.endedAt);
  const attendees = [meeting.ownerUserId, ...meeting.attendeeUserIds];
  return (
    <li>
      <Link className="meeting-row" to={`/m/${meeting.id}`}>
        <div className="meeting-row-main">
          <span className="meeting-row-title">{meeting.title || "Untitled meeting"}</span>
          <span className="meeting-row-time mono">
            {fmtTimeOfDay(when)}
            {duration ? ` · ${duration}` : ""}
          </span>
        </div>
        <div className="meeting-row-side">
          <span className="meeting-row-people">
            {attendees.slice(0, 5).map((id) => {
              const u = byId.get(id);
              return <Avatar key={id} user={u} name={u?.displayName ?? "?"} />;
            })}
          </span>
          {meeting.status === "recording" && <StateBadge kind="recording" />}
          {meeting.status === "processing" && <StateBadge kind="processing" />}
          {isShared(meeting) && <StateBadge kind="shared" />}
        </div>
      </Link>
    </li>
  );
}

function SearchResults({ hits }: { hits: SearchHit[] }) {
  const groups = useMemo(() => {
    const byMeeting = new Map<string, { title: string; items: SearchHit[] }>();
    for (const h of hits) {
      const g = byMeeting.get(h.meetingId) ?? { title: h.title, items: [] };
      g.items.push(h);
      byMeeting.set(h.meetingId, g);
    }
    return [...byMeeting.entries()];
  }, [hits]);

  if (groups.length === 0) return <p className="list-empty-note">No matches in anything you can access.</p>;
  return (
    <div className="search-results">
      {groups.map(([meetingId, g]) => (
        <section key={meetingId} className="search-group">
          <Link to={`/m/${meetingId}`} className="search-group-title">
            {g.title || "Untitled meeting"}
          </Link>
          <ul>
            {g.items.map((h, i) => (
              <li key={i} className="search-hit">
                <span className="chip search-layer-chip">{h.layer}</span>
                <span className="search-snippet">{h.snippet}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function MeetingListPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const searchTimer = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    listMeetings()
      .then((m) => {
        if (alive) setMeetings(m);
      })
      .catch(() => {
        if (alive) setLoadError(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    const query = q.trim();
    if (!query) {
      setHits(null);
      return;
    }
    searchTimer.current = window.setTimeout(() => {
      search(query)
        .then(setHits)
        .catch(() => setHits([]));
    }, 300);
  }, [q]);

  const groups = useMemo(() => {
    if (!meetings) return [];
    const out: Array<{ label: string; items: Meeting[] }> = [];
    for (const m of meetings) {
      const label = dateGroupLabel(m.startedAt ?? m.createdAt);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(m);
      else out.push({ label, items: [m] });
    }
    return out;
  }, [meetings]);

  const showAdmin = user?.role === "org_admin" || user?.role === "compliance_auditor";

  return (
    <main className="list-page">
      <header className="list-topbar">
        <span className="wordmark">Collective</span>
        <nav className="list-nav" aria-label="Account">
          {showAdmin && (
            <Link to="/admin" className="nav-link">
              <IconShield size={20} />
              <span>Admin</span>
            </Link>
          )}
          <Link to="/settings" className="nav-link">
            <IconSliders size={20} />
            <span>Settings</span>
          </Link>
          <span className="list-user">{user?.displayName}</span>
          <button type="button" className="btn-quiet nav-link" onClick={logout}>
            <IconSignOut size={20} />
            <span>Sign out</span>
          </button>
        </nav>
      </header>

      <div className="list-search">
        <label className="visually-hidden" htmlFor="global-search">
          Search meetings, summaries, and transcripts
        </label>
        <IconSearch className="list-search-icon" size={20} aria-hidden="true" />
        <input
          id="global-search"
          type="search"
          placeholder="Search meetings, summaries, transcripts…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {hits !== null ? (
        <SearchResults hits={hits} />
      ) : loadError ? (
        <p className="list-empty-note" role="alert">
          Couldn't load meetings. Check that the dev server is running, then reload.
        </p>
      ) : meetings === null ? (
        <p className="list-empty-note">Loading…</p>
      ) : meetings.length === 0 ? (
        <div className="list-empty">
          <h1 className="empty-headline">Your meetings will live here.</h1>
          <p>Capture your first conversation — notes, transcript, and a summary follow on their own.</p>
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.label} className="list-group">
            <h2 className="list-group-label">{g.label}</h2>
            <ul className="list-rows">
              {g.items.map((m) => (
                <MeetingRow key={m.id} meeting={m} />
              ))}
            </ul>
          </section>
        ))
      )}

      <div className="capture-fab-wrap">
        <RecordButton variant="fab" label="Record" onClick={() => navigate("/capture")} />
      </div>
    </main>
  );
}
