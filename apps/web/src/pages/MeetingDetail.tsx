import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import type { ActionItem, Meeting, ShareGrant, ShareLayer, User, Utterance } from "@collective/shared";
import {
  correctSpeaker,
  fetchAudio,
  getMeeting,
  getTranscript,
  patchMeetingTitle,
  putPhiFlag,
  tryListShares,
} from "../api";
import { useAuth } from "../auth";
import { useUsers } from "../lib/useUsers";
import { fmtClock } from "../lib/format";
import { Avatar, hueForUser } from "../components/Avatar";
import { NotesEditor } from "../components/NotesEditor";
import { ShareSheet } from "../components/ShareSheet";
import { useNote } from "../lib/useNote";

type MeetingMaybeShared = Meeting & { shares?: ShareGrant[] };

/* ------------------------------- PHI chip ------------------------------- */

function PhiChip({
  meeting,
  isOwner,
  onChange,
}: {
  meeting: Meeting;
  isOwner: boolean;
  onChange: (m: Meeting) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const set = async (flagged: boolean) => {
    setBusy(true);
    try {
      onChange(await putPhiFlag(meeting.id, flagged));
      setEditing(false);
    } catch {
      /* leave as-is; chip stays answerable */
    } finally {
      setBusy(false);
    }
  };

  const unanswered = meeting.phiFlag === null;
  if (unanswered || editing) {
    return (
      <span className="phi-chip phi-chip-open" role="group" aria-label="Contains patient info?">
        <span>Contains patient info?</span>
        <button type="button" className="btn-mini" disabled={!isOwner || busy} onClick={() => void set(true)}>
          Yes
        </button>
        <button type="button" className="btn-mini" disabled={!isOwner || busy} onClick={() => void set(false)}>
          No
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="phi-chip"
      disabled={!isOwner}
      title={isOwner ? "Tap to change" : "Only the owner can change this"}
      onClick={() => setEditing(true)}
    >
      Patient info: {meeting.phiFlag ? "Yes" : "No"}
    </button>
  );
}

/* ----------------------------- action items ----------------------------- */

function ActionItems({
  items,
  byId,
}: {
  items: ActionItem[];
  byId: Map<string, User>;
}) {
  // No update endpoint in the API contract — checkbox state is view-local.
  const [done, setDone] = useState<Record<string, boolean>>({});
  if (items.length === 0) return <p className="detail-muted">No action items were found.</p>;
  return (
    <ul className="action-list">
      {items.map((a) => {
        const isDone = done[a.id] ?? a.done;
        const assignee = a.assigneeUserId ? byId.get(a.assigneeUserId) : undefined;
        return (
          <li key={a.id} className={`action-item${isDone ? " action-done" : ""}`}>
            <input
              type="checkbox"
              id={`ai-${a.id}`}
              checked={isDone}
              onChange={(e) => setDone((d) => ({ ...d, [a.id]: e.target.checked }))}
            />
            <label htmlFor={`ai-${a.id}`}>{a.text}</label>
            {assignee && (
              <span className="person-chip">
                <Avatar user={assignee} />
                <span>{assignee.displayName}</span>
              </span>
            )}
            {a.sourceUtteranceIds.length === 0 && (
              <span
                className="verify-badge"
                title="No transcript line backs this item — verify it before relying on it."
              >
                Verify
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/* --------------------------- speaker correction -------------------------- */

function SpeakerPopover({
  meeting,
  users,
  utterance,
  onApplied,
  onClose,
}: {
  meeting: Meeting;
  users: User[];
  utterance: Utterance;
  onApplied: (utts: Utterance[]) => void;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<"line" | "voice">("voice");
  const [guest, setGuest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const attendeeIds = new Set([meeting.ownerUserId, ...meeting.attendeeUserIds]);
  const attendees = users.filter((u) => attendeeIds.has(u.id));
  const others = users.filter((u) => !attendeeIds.has(u.id) && !u.deactivated);

  const apply = async (body: { userId?: string; guestLabel?: string }) => {
    setBusy(true);
    setError(false);
    try {
      onApplied(await correctSpeaker(meeting.id, utterance.id, { ...body, scope }));
      onClose();
    } catch {
      setError(true);
      setBusy(false);
    }
  };

  const personRow = (u: User) => (
    <li key={u.id}>
      <button type="button" className="popover-person" disabled={busy} onClick={() => void apply({ userId: u.id })}>
        <Avatar user={u} />
        {u.displayName}
      </button>
    </li>
  );

  return (
    <div className="speaker-popover" role="dialog" aria-label="Who said this?" tabIndex={-1} ref={ref}>
      <h3>Who said this?</h3>
      <fieldset className="popover-scope">
        <legend className="visually-hidden">Apply to</legend>
        <label>
          <input type="radio" name="scope" checked={scope === "line"} onChange={() => setScope("line")} />
          Just this line
        </label>
        <label>
          <input type="radio" name="scope" checked={scope === "voice"} onChange={() => setScope("voice")} />
          All lines by this voice
        </label>
      </fieldset>
      {attendees.length > 0 && (
        <>
          <span className="section-label">Attendees</span>
          <ul className="popover-people">{attendees.map(personRow)}</ul>
        </>
      )}
      {others.length > 0 && (
        <>
          <span className="section-label">Others</span>
          <ul className="popover-people">{others.map(personRow)}</ul>
        </>
      )}
      <div className="popover-guest">
        <label htmlFor="guest-label" className="section-label">
          Someone else (guest)
        </label>
        <div className="popover-guest-row">
          <input
            id="guest-label"
            type="text"
            placeholder="e.g. Visiting specialist"
            value={guest}
            onChange={(e) => setGuest(e.target.value)}
          />
          <button
            type="button"
            className="btn"
            disabled={busy || !guest.trim()}
            onClick={() => void apply({ guestLabel: guest.trim() })}
          >
            Name guest
          </button>
        </div>
      </div>
      {error && (
        <p className="field-error" role="alert">
          Couldn't save the correction. Try again.
        </p>
      )}
      <button type="button" className="btn-quiet" onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}

/* ------------------------------ transcript ------------------------------ */

function highlight(text: string, q: string): ReactNode {
  if (!q) return text;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "ig"));
  return parts.map((p, i) => (p.toLowerCase() === q.toLowerCase() ? <mark key={i}>{p}</mark> : p));
}

function TranscriptSection({
  meeting,
  users,
  byId,
  utterances,
  onUtterances,
}: {
  meeting: Meeting;
  users: User[];
  byId: Map<string, User>;
  utterances: Utterance[];
  onUtterances: (u: Utterance[]) => void;
}) {
  const [q, setQ] = useState("");
  const [popoverFor, setPopoverFor] = useState<string | null>(null);

  // Stable "Unknown speaker n" numbering by first appearance (matches server).
  const unknownOrder = useMemo(() => {
    const order: string[] = [];
    for (const u of utterances)
      if (!u.speakerUserId && !u.guestLabel && !order.includes(u.cluster)) order.push(u.cluster);
    return order;
  }, [utterances]);

  const blocks = useMemo(() => {
    const out: Array<{ key: string; head: Utterance; lines: Utterance[] }> = [];
    for (const u of utterances) {
      const identity = u.speakerUserId ?? (u.guestLabel ? `g:${u.guestLabel}` : `c:${u.cluster}`);
      const last = out[out.length - 1];
      if (last && last.key === identity) last.lines.push(u);
      else out.push({ key: identity, head: u, lines: [u] });
    }
    return out;
  }, [utterances]);

  const query = q.trim();
  const visible = query
    ? blocks.filter((b) => b.lines.some((l) => l.text.toLowerCase().includes(query.toLowerCase())))
    : blocks;

  return (
    <section className="detail-section transcript-section">
      <div className="transcript-head">
        <h2 className="section-heading">Transcript</h2>
        <label className="visually-hidden" htmlFor="transcript-search">
          Search in transcript
        </label>
        <input
          id="transcript-search"
          type="search"
          placeholder="Search in transcript…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {utterances.length === 0 && <p className="detail-muted">No transcript lines yet.</p>}
      {query && visible.length === 0 && utterances.length > 0 && (
        <p className="detail-muted">No matches for “{query}”.</p>
      )}
      {visible.map((b, i) => {
        const speaker = b.head.speakerUserId ? byId.get(b.head.speakerUserId) : undefined;
        const unknown = !b.head.speakerUserId && !b.head.guestLabel;
        const name = speaker
          ? speaker.displayName
          : (b.head.guestLabel ?? `Unknown speaker ${unknownOrder.indexOf(b.head.cluster) + 1}`);
        const popKey = `${b.head.id}-${i}`;
        return (
          <div className="transcript-block" key={popKey}>
            <div className="transcript-block-head">
              <button
                type="button"
                className={`speaker-chip${unknown ? " speaker-chip-unknown" : ""}`}
                style={speaker ? { color: hueForUser(speaker) } : undefined}
                title="Correct speaker"
                onClick={() => setPopoverFor(popoverFor === popKey ? null : popKey)}
              >
                {unknown ? null : <Avatar user={speaker} name={b.head.guestLabel ?? name} />}
                {name}
              </button>
              <span className="mono transcript-ts">{fmtClock(b.head.startMs)}</span>
              {popoverFor === popKey && (
                <SpeakerPopover
                  meeting={meeting}
                  users={users}
                  utterance={b.head}
                  onApplied={onUtterances}
                  onClose={() => setPopoverFor(null)}
                />
              )}
            </div>
            <div className="transcript-lines">
              {b.lines.map((l) => (
                <p key={l.id} className="transcript-line">
                  {highlight(l.text, query)}
                </p>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

/* ------------------------------ audio stub ------------------------------ */

function AudioStub({ meetingId, durationMs }: { meetingId: string; durationMs: number }) {
  const [playing, setPlaying] = useState(false);
  const [denied, setDenied] = useState(false);

  const toggle = async () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    const ok = await fetchAudio(meetingId); // access itself is audited server-side
    if (ok) setPlaying(true);
    else setDenied(true);
  };

  if (denied) return <p className="detail-muted">Audio isn't available to you for this meeting.</p>;
  return (
    <div className="audio-bar">
      <button type="button" className="btn-mini" onClick={() => void toggle()}>
        {playing ? "Pause audio" : "Play audio"}
      </button>
      <span className="audio-track" aria-hidden="true">
        <span className={`audio-progress${playing ? " audio-progress-live" : ""}`} />
      </span>
      <span className="mono">{fmtClock(durationMs)}</span>
    </div>
  );
}

/* ------------------------------- skeleton ------------------------------- */

function Skeleton({ lines }: { lines: number }) {
  return (
    <div className="skeleton-group" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton-line" />
      ))}
    </div>
  );
}

/* ------------------------------- the page ------------------------------- */

export function MeetingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const { users, byId } = useUsers();
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [myLayers, setMyLayers] = useState<ShareLayer[]>([]);
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [grants, setGrants] = useState<ShareGrant[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [settled, setSettled] = useState(false);
  const wasProcessing = useRef(false);
  const [title, setTitle] = useState("");

  const note = useNote(id ?? null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await getMeeting(id);
      setMeeting(r.meeting);
      setTitle(r.meeting.title);
      setMyLayers(r.myLayers);
      const inline = (r.meeting as MeetingMaybeShared).shares;
      if (Array.isArray(inline)) setGrants(inline);
      if (r.meeting.status === "processing") wasProcessing.current = true;
      else if (wasProcessing.current) {
        setSettled(true);
        wasProcessing.current = false;
      }
      return r;
    } catch {
      setNotFound(true);
      return null;
    }
  }, [id]);

  useEffect(() => {
    void load();
    if (!id) return;
    void tryListShares(id).then((s) => {
      if (s) setGrants(s);
    });
  }, [id, load]);

  // Poll every 2 s while processing.
  useEffect(() => {
    if (!meeting || meeting.status !== "processing") return;
    const t = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(t);
  }, [meeting, load]);

  // Transcript: fetch when permitted; refresh when the meeting turns ready.
  const canTranscript = myLayers.includes("transcript");
  const status = meeting?.status;
  useEffect(() => {
    if (!id || !canTranscript || !status || status === "draft") return;
    getTranscript(id)
      .then(setUtterances)
      .catch(() => {});
  }, [id, canTranscript, status]);

  if (notFound)
    return (
      <main className="detail-page">
        <Link to="/" className="btn-quiet">
          ← Meetings
        </Link>
        <p className="detail-muted" role="alert">
          This meeting doesn't exist or you don't have access to it.
        </p>
      </main>
    );

  if (!meeting || !user) return <main className="detail-page" aria-busy="true" />;

  const processing = meeting.status === "processing";
  const isOwner = meeting.ownerUserId === user.id;
  const sharedPeople = new Set(grants.map((g) => g.granteeUserId)).size;
  const durationMs =
    meeting.startedAt && meeting.endedAt
      ? new Date(meeting.endedAt).getTime() - new Date(meeting.startedAt).getTime()
      : (utterances[utterances.length - 1]?.endMs ?? 0);

  const saveTitle = async () => {
    const next = title.trim();
    if (!next || next === meeting.title) return;
    setMeeting({ ...meeting, title: next });
    try {
      const updated = await patchMeetingTitle(meeting.id, next);
      if (updated) setMeeting(updated);
    } catch {
      /* optimistic title stands */
    }
  };

  const sectionStyle = (i: number) =>
    settled ? { animationDelay: `calc(${i} * var(--app-stagger))` } : undefined;
  const sectionClass = settled ? "detail-section settle" : "detail-section";

  return (
    <main className="detail-page">
      <header className="detail-topbar">
        <Link to="/" className="btn-quiet">
          ← Meetings
        </Link>
        <div className="detail-chips">
          {processing && <span className="state-badge state-badge-processing">Processing</span>}
          <button
            type="button"
            className={`share-chip${sharedPeople > 0 ? " share-chip-shared" : ""}`}
            onClick={() => setSheetOpen(true)}
          >
            {sharedPeople > 0
              ? `Shared · ${sharedPeople} ${sharedPeople === 1 ? "person" : "people"}`
              : "Private · Only you"}
          </button>
          <PhiChip meeting={meeting} isOwner={isOwner} onChange={setMeeting} />
        </div>
      </header>

      {processing ? (
        <>
          <Skeleton lines={1} />
          <section className="detail-section">
            <h2 className="section-heading">Summary</h2>
            <Skeleton lines={3} />
          </section>
          <section className="detail-section">
            <h2 className="section-heading">Action items</h2>
            <Skeleton lines={2} />
          </section>
        </>
      ) : (
        <>
          <label className="visually-hidden" htmlFor="detail-title">
            Meeting title
          </label>
          <input
            id="detail-title"
            className={`detail-title-input${settled ? " settle" : ""}`}
            style={sectionStyle(0)}
            value={title}
            placeholder="Untitled meeting"
            readOnly={!isOwner}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => void saveTitle()}
          />
          <section className={sectionClass} style={sectionStyle(1)}>
            <h2 className="section-heading">Summary</h2>
            {meeting.ai?.skippedReason && (
              <p className="summary-skipped">{meeting.ai.skippedReason}</p>
            )}
            {meeting.ai?.summary ? (
              <p className="summary-text">{meeting.ai.summary}</p>
            ) : (
              !meeting.ai?.skippedReason && <p className="detail-muted">No summary yet.</p>
            )}
          </section>
          <section className={sectionClass} style={sectionStyle(2)}>
            <h2 className="section-heading">Action items</h2>
            <ActionItems items={meeting.ai?.actionItems ?? []} byId={byId} />
          </section>
        </>
      )}

      <section className={sectionClass} style={sectionStyle(3)}>
        <NotesEditor body={note.body} onChange={note.setBody} saveState={note.saveState} rows={6} />
      </section>

      {canTranscript && (
        <TranscriptSection
          meeting={meeting}
          users={users}
          byId={byId}
          utterances={utterances}
          onUtterances={setUtterances}
        />
      )}

      {myLayers.includes("audio") && (
        <section className="detail-section">
          <h2 className="section-heading">Audio</h2>
          <AudioStub meetingId={meeting.id} durationMs={durationMs} />
        </section>
      )}

      {sheetOpen && (
        <ShareSheet
          meeting={meeting}
          users={users}
          currentUserId={user.id}
          grants={grants}
          onGrantsChange={setGrants}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </main>
  );
}
