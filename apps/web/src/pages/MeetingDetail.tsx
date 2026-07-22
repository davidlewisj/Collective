import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import type { Meeting, ShareGrant, ShareLayer, User, Utterance } from "@collective/shared";
import {
  correctSpeaker,
  fetchAudioBlob,
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
import {
  IconChevronLeft,
  IconCopy,
  IconLock,
  IconPause,
  IconPlay,
  IconShare,
  IconSparkle,
} from "../components/icons";

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

/* ------------------------------ ask Claude ------------------------------ */

/**
 * Summaries and action items are connector-territory (D10): the user asks
 * their own Claude, which reads this meeting through the MCP connector. This
 * card hands them a ready-made prompt.
 */
function AskClaudeCard({ meeting }: { meeting: Meeting }) {
  const [copied, setCopied] = useState(false);
  const when = new Date(meeting.startedAt ?? meeting.createdAt).toLocaleDateString("en-US");
  const prompt = `Using the Collective connector, summarize the meeting "${meeting.title || "Untitled meeting"}" (${when}): key points, decisions, and action items with owners. Use the transcript and my notes.`;

  return (
    <section className="detail-section">
      <h2 className="section-heading section-heading-icon">
        <IconSparkle size={20} />
        Summary &amp; action items
      </h2>
      <p className="detail-muted">
        Ask Claude — it reads this meeting's transcript and your notes through your Collective connector
        and answers with exactly what you need. Set it up once in Settings → Connect Claude.
      </p>
      <div className="ask-claude-row">
        <p className="ask-claude-prompt mono">{prompt}</p>
        <button
          type="button"
          className="btn-quiet icon-text-btn"
          onClick={() => {
            void navigator.clipboard.writeText(prompt).then(() => setCopied(true));
          }}
        >
          <IconCopy size={18} />
          {copied ? "Copied" : "Copy prompt"}
        </button>
      </div>
    </section>
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

/* ------------------------------ audio player ----------------------------- */

function AudioPlayer({ meetingId, durationMs }: { meetingId: string; durationMs: number }) {
  const [playing, setPlaying] = useState(false);
  const [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [totalMs, setTotalMs] = useState(durationMs);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  const ensureAudio = async (): Promise<HTMLAudioElement | null> => {
    if (audioRef.current) return audioRef.current;
    setLoading(true);
    try {
      const blob = await fetchAudioBlob(meetingId); // every fetch is audited server-side
      if (!blob) {
        setDenied(true);
        return null;
      }
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const el = new Audio(url);
      // MediaRecorder webm carries no duration metadata (reports Infinity);
      // seeking far ahead once forces the browser to compute the real length.
      el.addEventListener("loadedmetadata", () => {
        if (!Number.isFinite(el.duration)) {
          const settle = () => {
            el.removeEventListener("timeupdate", settle);
            el.currentTime = 0;
            if (Number.isFinite(el.duration)) setTotalMs(el.duration * 1000);
          };
          el.addEventListener("timeupdate", settle);
          el.currentTime = Number.MAX_SAFE_INTEGER;
        } else {
          setTotalMs(el.duration * 1000);
        }
      });
      el.addEventListener("timeupdate", () => setPositionMs(el.currentTime * 1000));
      el.addEventListener("ended", () => setPlaying(false));
      el.addEventListener("error", () => {
        setError(true);
        setPlaying(false);
      });
      audioRef.current = el;
      return el;
    } catch {
      setError(true);
      return null;
    } finally {
      setLoading(false);
    }
  };

  const toggle = async () => {
    if (playing) {
      audioRef.current?.pause();
      setPlaying(false);
      return;
    }
    const el = await ensureAudio();
    if (!el) return;
    try {
      await el.play();
      setPlaying(true);
    } catch {
      setError(true);
    }
  };

  const seek = async (e: { currentTarget: HTMLElement; clientX: number }) => {
    const el = await ensureAudio();
    if (!el || !Number.isFinite(el.duration)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    el.currentTime = frac * el.duration;
    setPositionMs(el.currentTime * 1000);
  };

  if (denied) return <p className="detail-muted">Audio isn't available to you for this meeting.</p>;
  if (error) return <p className="detail-muted">This recording can't be played back right now.</p>;

  const pct = totalMs > 0 ? Math.min((positionMs / totalMs) * 100, 100) : 0;
  return (
    <div className="audio-bar">
      <button type="button" className="btn-mini icon-text-btn" onClick={() => void toggle()} disabled={loading}>
        {playing ? <IconPause size={18} /> : <IconPlay size={18} />}
        {loading ? "Loading…" : playing ? "Pause" : "Play"}
      </button>
      <span
        className="audio-track audio-track-seek"
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(totalMs / 1000)}
        aria-valuenow={Math.round(positionMs / 1000)}
        tabIndex={0}
        onClick={(e) => void seek(e)}
      >
        <span className="audio-progress" style={{ width: `${pct}%` }} />
      </span>
      <span className="mono">
        {fmtClock(positionMs)} / {fmtClock(totalMs)}
      </span>
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
        <Link to="/" className="btn-quiet nav-link">
          <IconChevronLeft size={20} />
          <span>Meetings</span>
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
        <Link to="/" className="btn-quiet nav-link">
          <IconChevronLeft size={20} />
          <span>Meetings</span>
        </Link>
        <div className="detail-chips">
          {processing && <span className="state-badge state-badge-processing">Processing</span>}
          <button
            type="button"
            className={`share-chip icon-text-btn${sharedPeople > 0 ? " share-chip-shared" : ""}`}
            onClick={() => setSheetOpen(true)}
          >
            {sharedPeople > 0 ? <IconShare size={16} /> : <IconLock size={16} />}
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
            <h2 className="section-heading">Transcript</h2>
            <Skeleton lines={3} />
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
          {meeting.notice && (
            <p className="meeting-notice" role="status">
              {meeting.notice}
            </p>
          )}
          <AskClaudeCard meeting={meeting} />
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
          <AudioPlayer meetingId={meeting.id} durationMs={durationMs} />
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
