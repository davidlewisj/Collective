/**
 * Durable local persistence behind the storage seam (backlog PF-3 dev slice).
 *
 * Three stores, all under one data directory (COLLECTIVE_DATA_DIR, default
 * apps/server/.data):
 *   state.json  — atomic snapshot of the domain state (meetings, transcripts,
 *                 notes, shares, policies). Written debounced + on shutdown.
 *   audit.jsonl — append-only audit events, one JSON object per line; the
 *                 hash chain is re-verified on load and tampering is reported.
 *   audio/      — one <meetingId>.webm per meeting, appended chunk by chunk.
 *
 * Sessions are deliberately NOT persisted: a server restart requiring
 * re-login is correct behavior for a PHI-adjacent tool.
 *
 * Production target remains Aurora Postgres + S3 + WORM audit (PF-1..3);
 * these implementations sit behind the same interfaces the prod adapters
 * will implement.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AuditEvent,
  BaaRegistry,
  ConsentPolicy,
  Meeting,
  Note,
  RetentionPolicy,
  ShareGrant,
  Utterance,
} from "@collective/shared";
import { ConnectorToken, Db, UserSettings } from "./store.js";

/* ------------------------------ audio store ---------------------------- */

export interface AudioStore {
  append(meetingId: string, chunk: Buffer): void;
  read(meetingId: string): Buffer;
  delete(meetingId: string): void;
}

export class MemoryAudioStore implements AudioStore {
  private chunks = new Map<string, Buffer[]>();

  append(meetingId: string, chunk: Buffer): void {
    const arr = this.chunks.get(meetingId) ?? [];
    arr.push(chunk);
    this.chunks.set(meetingId, arr);
  }

  read(meetingId: string): Buffer {
    return Buffer.concat(this.chunks.get(meetingId) ?? []);
  }

  delete(meetingId: string): void {
    this.chunks.delete(meetingId);
  }
}

export class DiskAudioStore implements AudioStore {
  private dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "audio");
    mkdirSync(this.dir, { recursive: true });
  }

  private file(meetingId: string): string {
    // Meeting ids are server-generated ([a-z0-9_]); keep a hard guard anyway.
    if (!/^[A-Za-z0-9_-]+$/.test(meetingId)) throw new Error("invalid meeting id");
    return join(this.dir, `${meetingId}.webm`);
  }

  append(meetingId: string, chunk: Buffer): void {
    appendFileSync(this.file(meetingId), chunk);
  }

  read(meetingId: string): Buffer {
    const f = this.file(meetingId);
    return existsSync(f) ? readFileSync(f) : Buffer.alloc(0);
  }

  delete(meetingId: string): void {
    rmSync(this.file(meetingId), { force: true });
  }
}

/* ----------------------------- state snapshot --------------------------- */

interface Snapshot {
  version: 1 | 2;
  meetings: Meeting[];
  utterances: Array<[string, Utterance[]]>;
  notes: Array<[string, Note]>;
  shares: ShareGrant[];
  baa: BaaRegistry;
  consentPolicy: ConsentPolicy;
  retention: RetentionPolicy;
  idleMinutes: number;
  /** v2 additions; absent in v1 snapshots. */
  userSettings?: Array<[string, UserSettings]>;
  connectorTokens?: ConnectorToken[];
}

export class StateSnapshotStore {
  private file: string;
  private tmp: string;
  private timer: NodeJS.Timeout | null = null;

  constructor(dataDir: string, private db: Db) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "state.json");
    this.tmp = join(dataDir, "state.json.tmp");
  }

  /** Hydrate the db from disk. Returns true when a snapshot was loaded. */
  load(): boolean {
    if (!existsSync(this.file)) return false;
    const snap = JSON.parse(readFileSync(this.file, "utf8")) as Snapshot;
    this.db.meetings = new Map(snap.meetings.map((m) => [m.id, m]));
    this.db.utterances = new Map(snap.utterances);
    this.db.notes = new Map(snap.notes);
    this.db.shares = new Map(snap.shares.map((s) => [s.id, s]));
    this.db.baa = snap.baa;
    this.db.consentPolicy = snap.consentPolicy;
    this.db.retention = snap.retention;
    this.db.idleMinutes = snap.idleMinutes;
    this.db.userSettings = new Map(snap.userSettings ?? []);
    this.db.connectorTokens = new Map((snap.connectorTokens ?? []).map((t) => [t.token, t]));
    return true;
  }

  /** Atomic write: temp file + rename, so a crash never truncates state. */
  save(): void {
    const snap: Snapshot = {
      version: 2,
      meetings: [...this.db.meetings.values()],
      utterances: [...this.db.utterances.entries()],
      notes: [...this.db.notes.entries()],
      shares: [...this.db.shares.values()],
      baa: this.db.baa,
      consentPolicy: this.db.consentPolicy,
      retention: this.db.retention,
      idleMinutes: this.db.idleMinutes,
      userSettings: [...this.db.userSettings.entries()],
      connectorTokens: [...this.db.connectorTokens.values()],
    };
    writeFileSync(this.tmp, JSON.stringify(snap));
    renameSync(this.tmp, this.file);
  }

  /** Autosave loop; unref'd so it never keeps the process alive. */
  startAutosave(intervalMs = 2000): void {
    this.timer = setInterval(() => this.save(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.save();
  }
}

/* ------------------------------ audit journal --------------------------- */

export function auditJournalPath(dataDir: string): string {
  return join(dataDir, "audit.jsonl");
}

export function appendAuditEvent(dataDir: string, event: AuditEvent): void {
  appendFileSync(auditJournalPath(dataDir), JSON.stringify(event) + "\n");
}

export function loadAuditEvents(dataDir: string): AuditEvent[] {
  const file = auditJournalPath(dataDir);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditEvent);
}
