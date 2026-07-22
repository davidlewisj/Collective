import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ConsentMechanism, Meeting, MeetingMode, User } from "@collective/shared";
import {
  ApiError,
  createMeeting,
  nameLiveSpeaker,
  patchMeetingTitle,
  postChunk,
  postConsent,
  postFlag,
  postObjection,
  startMeeting,
  stopMeeting,
  wsUrl,
} from "../api";
import { subscribeSse } from "../sse";
import { startPcmStream, type PcmStreamer } from "../lib/pcm";
import { blobToBase64, playConsentTone } from "../lib/audio";
import { fmtClock } from "../lib/format";
import { useNote } from "../lib/useNote";
import { useUsers } from "../lib/useUsers";
import { useAuth } from "../auth";
import { buildSpeakerStyles, identityKey } from "../lib/speakerColors";
import { Avatar } from "../components/Avatar";
import { NotesEditor } from "../components/NotesEditor";
import { FlagDivider } from "../components/FlagDivider";
import { Waveform } from "../components/Waveform";
import { RecordButton } from "../components/RecordButton";
import {
  IconChevronLeft,
  IconCheck,
  IconFlag,
  IconHand,
  IconMic,
  IconNotes,
  IconPause,
  IconPlay,
  IconRecord,
} from "../components/icons";

type Phase = "setup" | "consent" | "recording" | "paused" | "stopping";

interface CaptionLine {
  key: string;
  cluster: string;
  text: string;
  interim: boolean;
}

/** A dropped flag, positioned in the live view by the line count at flag time. */
interface LiveFlag {
  id: string;
  atMs: number;
  afterCount: number;
  label?: string;
}

const ANNOUNCEMENT_SCRIPT = "Quick note: I'm recording this meeting for notes — any objection?";
const CHUNK_MS = 3000;

/* --------------------- in-session speaker naming ------------------------ */

/**
 * Popover to name a live voice while the meeting runs — fixes "Speaker 2"
 * (or a wrong guess) in real time; the assignment also carries into the final
 * transcript as a manual correction.
 */
function LiveSpeakerPopover({
  users,
  currentName,
  onPick,
  onClose,
}: {
  users: User[];
  currentName?: string;
  onPick: (target: { userId?: string; guestLabel?: string }) => void;
  onClose: () => void;
}) {
  const [guest, setGuest] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="speaker-popover" role="dialog" aria-label="Who is this voice?" tabIndex={-1} ref={ref}>
      <h3>Who is this voice?</h3>
      {currentName && <p className="detail-muted">Currently: {currentName}</p>}
      <ul className="popover-people">
        {users
          .filter((u) => !u.deactivated)
          .map((u) => (
            <li key={u.id}>
              <button type="button" className="popover-person" onClick={() => onPick({ userId: u.id })}>
                <Avatar user={u} />
                {u.displayName}
              </button>
            </li>
          ))}
      </ul>
      <div className="popover-guest">
        <label htmlFor="live-guest-label" className="section-label">
          Someone else (guest)
        </label>
        <div className="popover-guest-row">
          <input
            id="live-guest-label"
            type="text"
            placeholder="e.g. Visiting specialist"
            value={guest}
            onChange={(e) => setGuest(e.target.value)}
          />
          <button
            type="button"
            className="btn"
            disabled={!guest.trim()}
            onClick={() => onPick({ guestLabel: guest.trim() })}
          >
            Name guest
          </button>
        </div>
      </div>
      <button type="button" className="btn-quiet" onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}

/* ------------------------- live transcript view ------------------------- */

function LiveTranscript({
  lines,
  liveCaptions,
  speakers,
  ownerUserId,
  flags,
  onNameSpeaker,
}: {
  lines: CaptionLine[];
  liveCaptions: boolean;
  speakers: Record<string, { name: string; userId: string | null }>;
  ownerUserId: string;
  flags: LiveFlag[];
  onNameSpeaker: (cluster: string, target: { userId?: string; guestLabel?: string }) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const announceRef = useRef({ last: 0, queued: "" });
  const [announcement, setAnnouncement] = useState("");
  const [namingCluster, setNamingCluster] = useState<string | null>(null);
  const { users, byId } = useUsers();

  // Stable "Speaker n" numbering by first appearance.
  const clusterOrder = useMemo(() => {
    const order: string[] = [];
    for (const l of lines) if (!order.includes(l.cluster)) order.push(l.cluster);
    return order;
  }, [lines]);

  // Bubble color/side per cluster: map each named cluster to a user/guest, then
  // reuse the shared resolver (facilitator → right, others → distinct left).
  const styles = useMemo(() => {
    const refs = clusterOrder.map((cluster) => {
      const s = speakers[cluster];
      if (s?.userId) return { speakerUserId: s.userId, cluster };
      if (s) return { guestLabel: s.name, cluster };
      return { cluster };
    });
    return buildSpeakerStyles(ownerUserId, refs, byId);
  }, [clusterOrder, speakers, ownerUserId, byId]);

  // Group consecutive lines by cluster into speaker blocks.
  const blocks = useMemo(() => {
    const out: Array<{ cluster: string; lines: CaptionLine[] }> = [];
    for (const l of lines) {
      const last = out[out.length - 1];
      if (last && last.cluster === l.cluster) last.lines.push(l);
      else out.push({ cluster: l.cluster, lines: [l] });
    }
    return out;
  }, [lines]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  // Rate-limited screen-reader announcements for finalized lines.
  useEffect(() => {
    const last = lines.filter((l) => !l.interim).pop();
    if (!last) return;
    const state = announceRef.current;
    state.queued = last.text;
    const now = Date.now();
    if (now - state.last > 4000) {
      state.last = now;
      setAnnouncement(state.queued);
    }
  }, [lines]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    pinnedRef.current = pinned;
    setShowJump(!pinned);
  };

  const jumpToLive = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = true;
    setShowJump(false);
    el.scrollTop = el.scrollHeight;
  };

  return (
    <div className="live-transcript-wrap">
      <div className="live-transcript" ref={scrollRef} onScroll={onScroll}>
        {blocks.length === 0 && (
          <p className="live-transcript-empty">
            {liveCaptions
              ? "Live transcript appears here as people speak."
              : "Recording is on. The transcript arrives shortly after you stop — live captions are coming in a future update."}
          </p>
        )}
        {(() => {
          // Interleave flag dividers by how many lines existed when each was
          // dropped, so a flag lands right where the facilitator marked it.
          const sorted = [...flags].sort((a, b) => a.afterCount - b.afterCount || a.atMs - b.atMs);
          const items: React.ReactNode[] = [];
          let cursor = 0;
          let fi = 0;
          const emitFlagsUpTo = (n: number) => {
            while (fi < sorted.length && sorted[fi]!.afterCount <= n) {
              const f = sorted[fi]!;
              items.push(<FlagDivider key={`flag-${f.id}`} atMs={f.atMs} label={f.label} />);
              fi++;
            }
          };
          emitFlagsUpTo(0);
          blocks.forEach((b, i) => {
            const named = speakers[b.cluster]?.name;
            const st =
              styles.get(
                identityKey({
                  cluster: b.cluster,
                  ...(speakers[b.cluster]?.userId
                    ? { speakerUserId: speakers[b.cluster]!.userId! }
                    : named
                      ? { guestLabel: named }
                      : {}),
                }),
              ) ?? { side: "left" as const, kind: "unknown" as const };
            const popKey = `${b.cluster}-${i}`;
            items.push(
              <div
                className={`bubble-group bubble-${st.side} bubble-kind-${st.kind}`}
                key={popKey}
                style={st.colorVar ? ({ "--bubble": st.colorVar } as React.CSSProperties) : undefined}
              >
                <span className="bubble-head live-block-speaker">
                  <button
                    type="button"
                    className="bubble-speaker"
                    title="Tap to name this voice"
                    onClick={() => setNamingCluster(namingCluster === popKey ? null : popKey)}
                  >
                    <span className="bubble-name">{named ?? `Speaker ${clusterOrder.indexOf(b.cluster) + 1}`}</span>
                  </button>
                  {namingCluster === popKey && (
                    <LiveSpeakerPopover
                      users={users}
                      currentName={named}
                      onPick={(target) => {
                        setNamingCluster(null);
                        onNameSpeaker(b.cluster, target);
                      }}
                      onClose={() => setNamingCluster(null)}
                    />
                  )}
                </span>
                <div className="bubble-stack">
                  {b.lines.map((l) => (
                    <p key={l.key} className={`bubble${l.interim ? " bubble-interim" : ""}`}>
                      {l.text}
                    </p>
                  ))}
                </div>
              </div>,
            );
            cursor += b.lines.length;
            emitFlagsUpTo(cursor);
          });
          return items;
        })()}
      </div>
      {showJump && (
        <button type="button" className="jump-live-pill" onClick={jumpToLive}>
          Jump to live
        </button>
      )}
      <div className="visually-hidden" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

/* ------------------------------ main page ------------------------------- */

export function CapturePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [phase, setPhase] = useState<Phase>("setup");
  const [mode, setMode] = useState<MeetingMode>("virtual_desktop");
  const [title, setTitle] = useState("");
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<CaptionLine[]>([]);
  const [liveCaptions, setLiveCaptions] = useState(true);
  const [speakers, setSpeakers] = useState<Record<string, { name: string; userId: string | null }>>({});
  const [elapsed, setElapsed] = useState(0);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  // Notes panel: open by default on desktop (a side rail), closed on mobile
  // (a bottom sheet). The dock toggle collapses/expands it either way.
  const [notesOpen, setNotesOpen] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 56.25em)").matches,
  );
  const [objectionArmed, setObjectionArmed] = useState(false);
  const [flags, setFlags] = useState<LiveFlag[]>([]);

  const note = useNote(meeting?.id ?? null);

  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const pcmRef = useRef<PcmStreamer | null>(null);
  const seqRef = useRef(0);
  const pendingRef = useRef<Array<Promise<unknown>>>([]);
  const sseAbortRef = useRef<AbortController | null>(null);
  const runStartRef = useRef(0);
  const accumulatedRef = useRef(0);
  const leavingRef = useRef(false);

  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const consentMechanisms = useMemo(
    () => new Set<ConsentMechanism>((meeting?.consent ?? []).map((c) => c.mechanism)),
    [meeting],
  );

  const cleanup = useCallback(() => {
    pcmRef.current?.stop();
    pcmRef.current = null;
    sseAbortRef.current?.abort();
    sseAbortRef.current = null;
    const rec = recRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    recRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  // Elapsed timer, pause-aware.
  useEffect(() => {
    if (phase !== "recording") return;
    const t = window.setInterval(() => {
      setElapsed(accumulatedRef.current + (Date.now() - runStartRef.current));
    }, 500);
    return () => window.clearInterval(t);
  }, [phase]);

  const elapsedNow = () =>
    phaseRef.current === "recording"
      ? accumulatedRef.current + (Date.now() - runStartRef.current)
      : accumulatedRef.current;

  /* ------------------------------ setup ------------------------------- */

  const proceedToConsent = async () => {
    setBusy(true);
    setError(null);
    try {
      const m = await createMeeting({ title: title.trim() || undefined, mode });
      setMeeting(m);
      if (m.title) setTitle(m.title);
      setPhase("consent");
    } catch {
      setError("Couldn't create the meeting. Check the dev server and try again.");
    } finally {
      setBusy(false);
    }
  };

  /* ----------------------------- consent ------------------------------ */

  const recordConsent = async (mechanism: ConsentMechanism) => {
    if (!meeting) return;
    if (mechanism === "audible_tone") playConsentTone();
    try {
      const m = await postConsent(meeting.id, mechanism);
      setMeeting(m);
    } catch {
      setError("Couldn't record the consent step. Try again.");
    }
  };

  const onCaption = useCallback((data: unknown) => {
    if (!data || typeof data !== "object") return;
    const d = data as { cluster?: string; text?: string; interim?: boolean; seq?: number; id?: string };
    if (typeof d.text !== "string" || d.text.length === 0) return;
    const key = d.id ?? (d.seq !== undefined ? `seq-${d.seq}` : `t-${Date.now()}-${Math.random()}`);
    const line: CaptionLine = {
      key,
      cluster: d.cluster ?? "A",
      text: d.text,
      interim: d.interim === true,
    };
    setLines((prev) => {
      const idx = prev.findIndex((l) => l.key === key);
      if (idx >= 0) {
        const next = prev.slice();
        next[idx] = line;
        return next;
      }
      return [...prev, line];
    });
  }, []);

  const beginRecording = async (m: Meeting) => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;

    const audioCtx = new AudioContext();
    ctxRef.current = audioCtx;
    const source = audioCtx.createMediaStreamSource(stream);
    const an = audioCtx.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0.8;
    source.connect(an);
    setAnalyser(an);

    // Live-caption PCM stream to the server relay (real-engine mode). If the
    // relay is off or gated, the socket just closes — recording is unaffected.
    pcmRef.current = startPcmStream(audioCtx, source, wsUrl(`/meetings/${m.id}/stream?rate=16000`));

    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(
      (t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t),
    );
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = (ev: BlobEvent) => {
      if (ev.data.size === 0) return;
      const seq = seqRef.current++;
      pendingRef.current.push(
        blobToBase64(ev.data)
          .then((b64) => postChunk(m.id, seq, b64))
          .catch(() => {}),
      );
    };
    rec.start(CHUNK_MS);
    recRef.current = rec;

    const abort = new AbortController();
    sseAbortRef.current = abort;
    subscribeSse(
      `/meetings/${m.id}/live`,
      {
        onEvent: (event, data) => {
          if (event === "caption") onCaption(data);
          else if (event === "speakers" && data && typeof data === "object") {
            setSpeakers(data as Record<string, { name: string; userId: string | null }>);
          } else if (event === "status") {
            const payload = data as { status?: string; liveCaptions?: boolean };
            if (typeof payload?.liveCaptions === "boolean") setLiveCaptions(payload.liveCaptions);
            const s = payload?.status;
            if ((s === "processing" || s === "ready") && !leavingRef.current) {
              // Stopped from elsewhere — follow the meeting to its record.
              leavingRef.current = true;
              cleanup();
              navigate(`/m/${m.id}`);
            }
          }
        },
      },
      abort.signal,
    );

    accumulatedRef.current = 0;
    runStartRef.current = Date.now();
    setPhase("recording");
  };

  const start = async () => {
    if (!meeting) return;
    setBusy(true);
    setError(null);
    try {
      const m = await startMeeting(meeting.id);
      setMeeting(m);
      await beginRecording(m);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.code === "consent_required")) {
        setError("This org's consent policy needs more steps before capture can start.");
      } else if (err instanceof DOMException && err.name === "NotAllowedError") {
        setError("Microphone access is needed to capture. Allow the mic, then try again.");
      } else {
        setError("Couldn't start capture. Try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  /* ---------------------------- recording ------------------------------ */

  const pause = () => {
    const rec = recRef.current;
    if (!rec || rec.state !== "recording") return;
    rec.pause();
    pcmRef.current?.setPaused(true);
    accumulatedRef.current += Date.now() - runStartRef.current;
    setElapsed(accumulatedRef.current);
    setPhase("paused");
  };

  const resume = () => {
    const rec = recRef.current;
    if (!rec || rec.state !== "paused") return;
    rec.resume();
    pcmRef.current?.setPaused(false);
    runStartRef.current = Date.now();
    setPhase("recording");
  };

  const flagMoment = async () => {
    if (!meeting) return;
    const atMs = Math.round(elapsedNow());
    const afterCount = lines.length; // position the divider at the current bottom
    try {
      const flag = await postFlag(meeting.id, atMs);
      setFlags((prev) => [...prev, { id: flag.id, atMs: flag.atMs, afterCount, label: flag.label }]);
    } catch {
      /* transient — the flag button can be tapped again */
    }
  };

  const handleNameSpeaker = async (cluster: string, target: { userId?: string; guestLabel?: string }) => {
    if (!meeting) return;
    try {
      setSpeakers(await nameLiveSpeaker(meeting.id, { cluster, ...target }));
    } catch {
      /* chip keeps its old label; the popover can be reopened */
    }
  };

  const stop = async () => {
    if (!meeting || leavingRef.current) return;
    leavingRef.current = true;
    setPhase("stopping");
    sseAbortRef.current?.abort();
    const rec = recRef.current;
    if (rec && rec.state !== "inactive") {
      await new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
        rec.stop();
      });
    }
    await Promise.allSettled(pendingRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    void ctxRef.current?.close().catch(() => {});
    try {
      await stopMeeting(meeting.id);
    } catch {
      /* the record still exists; detail will show its state */
    }
    navigate(`/m/${meeting.id}`);
  };

  const objection = async () => {
    if (!meeting || leavingRef.current) return;
    if (!objectionArmed) {
      setObjectionArmed(true);
      return;
    }
    leavingRef.current = true;
    setPhase("stopping");
    cleanup();
    try {
      await postObjection(meeting.id);
    } catch {
      /* fall through to the record */
    }
    navigate(`/m/${meeting.id}`);
  };

  const saveTitle = async () => {
    if (!meeting) return;
    const next = title.trim();
    if (!next || next === meeting.title) return;
    setMeeting({ ...meeting, title: next });
    try {
      const updated = await patchMeetingTitle(meeting.id, next);
      if (updated) setMeeting(updated);
    } catch {
      /* keep the optimistic title */
    }
  };

  const isLive = phase === "recording" || phase === "paused";

  /* ------------------------------ render ------------------------------- */

  return (
    <main className={`capture-page${isLive ? " capture-live" : ""}`}>
      <header className="capture-header">
        {!isLive && phase !== "stopping" && (
          <button type="button" className="btn-quiet nav-link" onClick={() => navigate("/")}>
            <IconChevronLeft size={20} />
            <span>Back</span>
          </button>
        )}
        <label className="visually-hidden" htmlFor="capture-title">
          Meeting title
        </label>
        <input
          id="capture-title"
          className="capture-title-input"
          placeholder="Untitled meeting"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void saveTitle()}
        />
        {isLive && (
          <>
            <span className="capture-timer mono" aria-label="Elapsed time">
              {fmtClock(elapsed)}
            </span>
            <span className="consent-chip consent-chip-ok">
              <IconCheck size={16} />
              Consent noted
            </span>
            <span className={`record-dot-wrap${phase === "paused" ? " record-paused" : ""}`}>
              <span className="record-dot" aria-hidden="true" />
              <span className="visually-hidden">{phase === "paused" ? "Paused" : "Recording"}</span>
            </span>
          </>
        )}
      </header>

      {phase === "setup" && (
        <section className="capture-setup">
          <span className="capture-setup-mark" aria-hidden="true">
            <IconMic size={24} />
          </span>
          <h1 className="capture-setup-headline">Start a capture</h1>
          <div className="segmented" role="radiogroup" aria-label="Meeting mode">
            <button
              type="button"
              role="radio"
              aria-checked={mode === "virtual_desktop"}
              className={mode === "virtual_desktop" ? "seg-on" : ""}
              onClick={() => setMode("virtual_desktop")}
            >
              Virtual meeting
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === "in_person"}
              className={mode === "in_person" ? "seg-on" : ""}
              onClick={() => setMode("in_person")}
            >
              In person
            </button>
          </div>
          <button type="button" className="btn" onClick={() => void proceedToConsent()} disabled={busy}>
            Continue to consent
          </button>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </section>
      )}

      {isLive && <Waveform analyser={analyser} paused={phase === "paused"} />}

      {(isLive || phase === "stopping") && (
        <div className={`capture-body${notesOpen ? "" : " notes-hidden"}`}>
          <LiveTranscript
            lines={lines}
            liveCaptions={liveCaptions}
            speakers={speakers}
            ownerUserId={user?.id ?? ""}
            flags={flags}
            onNameSpeaker={(cluster, target) => void handleNameSpeaker(cluster, target)}
          />
          <aside className={`notes-pane${notesOpen ? " notes-pane-open" : ""}`}>
            <NotesEditor body={note.body} onChange={note.setBody} saveState={note.saveState} rows={14} />
          </aside>
        </div>
      )}

      {isLive && (
        <div className="capture-dock" role="group" aria-label="Recording controls">
          <button
            type="button"
            className="dock-btn"
            onClick={phase === "recording" ? pause : resume}
          >
            {phase === "recording" ? <IconPause size={24} /> : <IconPlay size={24} />}
            <span>{phase === "recording" ? "Pause" : "Resume"}</span>
          </button>
          <button type="button" className="dock-btn" onClick={() => void flagMoment()}>
            <IconFlag size={24} />
            <span>Flag</span>
          </button>
          <div className="dock-hero">
            <RecordButton
              variant="hero"
              state={phase === "paused" ? "paused" : "recording"}
              label="Stop recording"
              onClick={() => void stop()}
            />
            <span className="dock-hero-label">Stop</span>
          </div>
          <button
            type="button"
            className={`dock-btn dock-btn-danger${objectionArmed ? " armed" : ""}`}
            onClick={() => void objection()}
            title={objectionArmed ? "Stops recording and deletes the audio" : "A participant objected to recording"}
          >
            <IconHand size={24} />
            <span>{objectionArmed ? "Delete audio?" : "Objection"}</span>
          </button>
          <button
            type="button"
            className="dock-btn notes-toggle"
            aria-expanded={notesOpen}
            onClick={() => setNotesOpen((v) => !v)}
          >
            <IconNotes size={24} />
            <span>{notesOpen ? "Hide" : "Notes"}</span>
          </button>
        </div>
      )}

      {phase === "stopping" && <p className="capture-stopping">Wrapping up — saving your capture…</p>}

      {phase === "consent" && meeting && (
        <div className="consent-scrim" role="presentation">
          <section className="consent-sheet" role="dialog" aria-modal="true" aria-label="Recording consent">
            <h2>Before you record</h2>
            <p className="consent-lede">Say this out loud to the room or the call:</p>
            <blockquote className="consent-script">“{ANNOUNCEMENT_SCRIPT}”</blockquote>
            <div className="consent-actions">
              <button
                type="button"
                className={`btn-quiet consent-step${consentMechanisms.has("verbal_announcement_attested") ? " done" : ""}`}
                onClick={() => void recordConsent("verbal_announcement_attested")}
              >
                {consentMechanisms.has("verbal_announcement_attested") && <IconCheck size={16} />}
                {consentMechanisms.has("verbal_announcement_attested") ? "Announced" : "I announced it"}
              </button>
              <button
                type="button"
                className={`btn-quiet consent-step${consentMechanisms.has("audible_tone") ? " done" : ""}`}
                onClick={() => void recordConsent("audible_tone")}
              >
                {consentMechanisms.has("audible_tone") && <IconCheck size={16} />}
                {consentMechanisms.has("audible_tone") ? "Tone played" : "Play tone"}
              </button>
            </div>
            <button
              type="button"
              className="btn btn-block btn-record-start"
              disabled={busy || consentMechanisms.size === 0}
              onClick={() => void start()}
            >
              <IconRecord size={20} />
              Start capture
            </button>
            {consentMechanisms.size === 0 && (
              <p className="consent-hint">Record at least one consent step to start.</p>
            )}
            {error && (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}
            <button type="button" className="btn-quiet consent-cancel" onClick={() => navigate("/")}>
              Cancel — back to meetings
            </button>
          </section>
        </div>
      )}
    </main>
  );
}
