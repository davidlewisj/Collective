/**
 * Search with query-time ACL filtering (design-spec §3.3): revoking a share or
 * deleting a record removes visibility immediately because permissions are
 * evaluated on every query — nothing stale is ever served from the index.
 */
import { ShareLayer, User } from "@collective/shared";
import { can, canSeeRecord } from "./rbac.js";
import { Db } from "./store.js";

export interface SearchHit {
  meetingId: string;
  title: string;
  layer: ShareLayer | "title";
  snippet: string;
  /** Meeting time (start, else created) so results can show the date. */
  whenIso: string;
}

function snippetAround(text: string, q: string): string {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return "";
  const start = Math.max(0, i - 40);
  return (start > 0 ? "…" : "") + text.slice(start, i + q.length + 60) + "…";
}

export function search(db: Db, user: User, q: string): SearchHit[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const hits: SearchHit[] = [];

  for (const m of db.meetings.values()) {
    if (m.status === "deleted" || !canSeeRecord(db, user, m)) continue;
    const whenIso = m.startedAt ?? m.createdAt;

    if (m.title.toLowerCase().includes(needle)) {
      hits.push({ meetingId: m.id, title: m.title, layer: "title", snippet: m.title, whenIso });
    }
    if (can(db, user, "read", m, "transcript")) {
      for (const u of db.utterances.get(m.id) ?? []) {
        if (u.text.toLowerCase().includes(needle)) {
          hits.push({ meetingId: m.id, title: m.title, layer: "transcript", snippet: snippetAround(u.text, q), whenIso });
          break;
        }
      }
    }
    // Notes are searchable ONLY by their author, regardless of shares.
    const own = db.notes.get(`${m.id}:${user.id}`);
    if (own && own.body.toLowerCase().includes(needle)) {
      hits.push({ meetingId: m.id, title: m.title, layer: "notes", snippet: snippetAround(own.body, q), whenIso });
    }
  }
  return hits.slice(0, 50);
}
