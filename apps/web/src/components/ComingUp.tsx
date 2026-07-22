import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getUpcomingEvents, type UpcomingEvent } from "../api";
import { InPersonGlyph, PROVIDER_LABEL, ProviderLogo } from "./providerLogos";

/** "1:00 – 2:00 PM" — drops the meridiem from the start when it matches the end. */
function timeRange(startMs: number, endMs: number): string {
  const fmt = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const start = fmt(startMs);
  const end = fmt(endMs);
  const period = (s: string) => s.slice(-2);
  const startShown = period(start) === period(end) ? start.replace(/\s?[AP]M$/i, "") : start;
  return `${startShown} – ${end}`;
}

function dayParts(ms: number) {
  const d = new Date(ms);
  return {
    dom: d.toLocaleDateString("en-US", { day: "numeric" }),
    mo: d.toLocaleDateString("en-US", { month: "short" }),
    dow: d.toLocaleDateString("en-US", { weekday: "short" }),
  };
}

/**
 * "Coming up": upcoming calendar events grouped by day. Only the soonest
 * event carries an active Start/Join button; as the day advances, ended
 * meetings drop off and the next becomes the top one. Hidden entirely when
 * there's no connected calendar or nothing upcoming.
 */
export function ComingUp() {
  const navigate = useNavigate();
  const [events, setEvents] = useState<UpcomingEvent[] | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    getUpcomingEvents()
      .then((e) => alive && setEvents(e))
      .catch(() => alive && setEvents([]));
    // Re-tick each minute so the "top" event and the drop-off stay current.
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  const groups = useMemo(() => {
    const visible = (events ?? []).filter((e) => e.endMs > now);
    const out: Array<{ key: string; events: UpcomingEvent[] }> = [];
    for (const e of visible) {
      const key = new Date(e.startMs).toDateString();
      const last = out[out.length - 1];
      if (last && last.key === key) last.events.push(e);
      else out.push({ key, events: [e] });
    }
    return out;
  }, [events, now]);

  if (!events || groups.length === 0) return null;

  // The single soonest event (first of the first group) owns the live button.
  const topEvent = groups[0]!.events[0]!;

  const start = (ev: UpcomingEvent) => {
    if (ev.joinUrl) window.open(ev.joinUrl, "_blank", "noopener,noreferrer");
    navigate("/capture", { state: { title: ev.title } });
  };

  return (
    <section className="comingup" aria-label="Coming up">
      <h2 className="comingup-head">Coming up</h2>
      <div className="comingup-body">
        {groups.map((g) => {
          const { dom, mo, dow } = dayParts(g.events[0]!.startMs);
          return (
            <div className="comingup-day" key={g.key}>
              <div className="comingup-date" aria-hidden="true">
                <span className="comingup-dom">{dom}</span>
                <span className="comingup-molabel">
                  <span className="comingup-mo">{mo}</span>
                  <span className="comingup-dow">{dow}</span>
                </span>
              </div>
              <ul className="comingup-events">
                {g.events.map((ev, i) => {
                  const isTop = ev === topEvent;
                  const live = now >= ev.startMs && now < ev.endMs;
                  return (
                    <li className="comingup-event" key={`${g.key}-${i}`}>
                      <span className="comingup-bar" aria-hidden="true" />
                      <div className="comingup-event-main">
                        <span className="comingup-title">{ev.title}</span>
                        <span className="comingup-time mono">
                          {live ? "Now · " : ""}
                          {timeRange(ev.startMs, ev.endMs)}
                        </span>
                      </div>
                      {isTop &&
                        (ev.joinProvider ? (
                          <button
                            type="button"
                            className="comingup-cta comingup-join"
                            onClick={() => start(ev)}
                            title={`Open in ${PROVIDER_LABEL[ev.joinProvider]} and start recording`}
                          >
                            <ProviderLogo provider={ev.joinProvider} size={18} />
                            Join now
                          </button>
                        ) : (
                          <button type="button" className="comingup-cta comingup-start" onClick={() => start(ev)}>
                            <InPersonGlyph size={16} />
                            Start now
                          </button>
                        ))}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}
