/**
 * Retention clocks + deletion worker (design-spec §2.6.4; backlog AR-3/AR-4).
 * Layer clocks run from meeting end: audio (default 90 d) then transcript
 * (default 7 y). Deletion cascades through utterances and (by construction)
 * search visibility; every action is audit-logged. Production adds soft-delete
 * windows, backup expiry, and deletion certificates.
 */
import { AuditLog } from "./audit.js";
import { AudioStore } from "./persist.js";
import { Db } from "./store.js";

const DAY = 24 * 60 * 60 * 1000;

export function runRetentionSweep(
  db: Db,
  audit: AuditLog,
  audioStore?: AudioStore,
  now = Date.now(),
): { audioPurged: number; recordsDeleted: number } {
  let audioPurged = 0;
  let recordsDeleted = 0;

  for (const m of db.meetings.values()) {
    if (m.status === "deleted" || !m.endedAt) continue;
    const age = now - Date.parse(m.endedAt);

    if (m.audioChunks > 0 && age > db.retention.audioDays * DAY) {
      audioStore?.delete(m.id);
      m.audioChunks = 0;
      audioPurged++;
      audit.emit({ actorUserId: "system_retention", action: "retention.audio_purged", meetingId: m.id, layer: "audio" });
    }

    if (age > db.retention.transcriptDays * DAY) {
      audioStore?.delete(m.id);
      db.utterances.delete(m.id);
      for (const [k] of db.notes) if (k.startsWith(`${m.id}:`)) db.notes.delete(k);
      for (const [id, g] of db.shares) if (g.meetingId === m.id) db.shares.delete(id);
      m.status = "deleted";
      m.notice = undefined;
      recordsDeleted++;
      audit.emit({ actorUserId: "system_retention", action: "retention.record_deleted", meetingId: m.id, layer: "record" });
    }
  }
  return { audioPurged, recordsDeleted };
}

export function startRetentionWorker(db: Db, audit: AuditLog, audioStore?: AudioStore): NodeJS.Timeout {
  return setInterval(() => runRetentionSweep(db, audit, audioStore), 60 * 60 * 1000).unref() as unknown as NodeJS.Timeout;
}
