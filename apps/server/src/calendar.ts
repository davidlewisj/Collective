/**
 * Calendar naming via per-user ICS feeds (a pragmatic slice of backlog AT-3).
 *
 * Users paste the "secret address in iCal format" (Google) / published
 * calendar URL (Outlook) into Settings. When a capture is created without a
 * title, the server fetches the feed, finds the event covering "now" (with a
 * grace window), and names the meeting — also pre-filling attendees whose
 * email addresses match directory users. Full Microsoft Graph calendar OAuth
 * remains the production path (backlog AT-3).
 *
 * The parser is deliberately minimal: VEVENT blocks, folded-line unfolding,
 * DTSTART/DTEND in UTC ("...Z"), floating/TZID-local times (treated as server
 * local — adequate for same-machine dev), all-day dates (ignored for
 * matching), SUMMARY, and ATTENDEE mailto addresses. Feeds it can't make
 * sense of simply produce no match — calendar naming never blocks capture.
 */

export interface CalendarEvent {
  summary: string;
  startMs: number;
  endMs: number;
  attendeeEmails: string[];
}

export type IcsFetcher = (url: string) => Promise<string>;

export const httpIcsFetcher: IcsFetcher = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`ics fetch: ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
};

function unfold(ics: string): string[] {
  const raw = ics.split(/\r?\n/);
  const lines: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

function parseDt(value: string): number | null {
  // 20260720T173000Z | 20260720T173000 (floating/TZID-local) — all-day
  // (20260720) returns null so day-long events never swallow the match.
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  return z === "Z"
    ? Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!)
    : new Date(+y!, +mo! - 1, +d!, +h!, +mi!, +s!).getTime();
}

export function parseIcs(ics: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  let cur: Partial<CalendarEvent> & { attendeeEmails: string[] } = { attendeeEmails: [] };
  let inEvent = false;

  for (const line of unfold(ics)) {
    if (line === "BEGIN:VEVENT") {
      inEvent = true;
      cur = { attendeeEmails: [] };
      continue;
    }
    if (line === "END:VEVENT") {
      inEvent = false;
      if (cur.summary && cur.startMs != null && cur.endMs != null && cur.endMs > cur.startMs) {
        events.push(cur as CalendarEvent);
      }
      continue;
    }
    if (!inEvent) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const [nameAndParams, value] = [line.slice(0, colon), line.slice(colon + 1)];
    const name = nameAndParams.split(";")[0]!.toUpperCase();
    if (name === "SUMMARY") {
      cur.summary = value.replace(/\\([,;nN])/g, (_, c: string) => (c.toLowerCase() === "n" ? " " : c)).trim();
    } else if (name === "DTSTART") {
      cur.startMs = parseDt(value) ?? undefined;
    } else if (name === "DTEND") {
      cur.endMs = parseDt(value) ?? undefined;
    } else if (name === "ATTENDEE" || name === "ORGANIZER") {
      const mail = /mailto:([^\s>]+)/i.exec(value)?.[1];
      if (mail) cur.attendeeEmails.push(mail.toLowerCase());
    }
  }
  return events;
}

/** Grace window: events that started ≤20 min ago or start within 10 min. */
const BEFORE_MS = 10 * 60 * 1000;

export function eventCovering(events: CalendarEvent[], nowMs: number): CalendarEvent | undefined {
  const candidates = events.filter((e) => nowMs >= e.startMs - BEFORE_MS && nowMs < e.endMs);
  // Prefer the event that started most recently (back-to-back meetings).
  return candidates.sort((a, b) => b.startMs - a.startMs)[0];
}

const cache = new Map<string, { at: number; events: CalendarEvent[] }>();
const CACHE_MS = 5 * 60 * 1000;

export async function currentCalendarEvent(
  url: string,
  fetcher: IcsFetcher,
  nowMs = Date.now(),
): Promise<CalendarEvent | undefined> {
  try {
    let entry = cache.get(url);
    if (!entry || nowMs - entry.at > CACHE_MS) {
      entry = { at: nowMs, events: parseIcs(await fetcher(url)) };
      cache.set(url, entry);
    }
    return eventCovering(entry.events, nowMs);
  } catch {
    return undefined; // calendar problems never block capture
  }
}
