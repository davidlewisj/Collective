import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit.js";
import {
  DiskAudioStore,
  StateSnapshotStore,
  appendAuditEvent,
  loadAuditEvents,
} from "../src/persist.js";
import { runRetentionSweep } from "../src/retention.js";
import { createDb, seedUsers } from "../src/store.js";
import { auth, login, makeCtx, recordMeeting } from "./helpers.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "collective-persist-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("durable persistence", () => {
  it("round-trips full domain state through a snapshot (simulated restart)", async () => {
    const dir = tempDir();
    const ctx = makeCtx();
    ctx.db.baa = { assemblyai: true, claudeWorkspace: true, microsoft: true, voice: true };
    const t = await login(ctx, "dana@collective.dev");
    const id = await recordMeeting(ctx, t);
    await ctx.app.inject({
      method: "PUT",
      url: `/meetings/${id}/notes`,
      headers: auth(t),
      payload: { body: "note that must survive restart" },
    });
    await ctx.app.inject({
      method: "POST",
      url: `/meetings/${id}/shares`,
      headers: auth(t),
      payload: { layer: "summary", granteeUserId: "u_priya", permission: "view" },
    });
    new StateSnapshotStore(dir, ctx.db).save();

    // "Restart": a brand-new db hydrated from disk.
    const db2 = createDb();
    seedUsers(db2);
    expect(new StateSnapshotStore(dir, db2).load()).toBe(true);
    expect(db2.meetings.get(id)?.status).toBe("ready");
    expect(db2.meetings.get(id)?.title).toBeTruthy();
    expect(db2.utterances.get(id)?.length).toBeGreaterThan(0);
    expect(db2.notes.get(`${id}:u_dana`)?.body).toContain("survive restart");
    expect([...db2.shares.values()].some((s) => s.granteeUserId === "u_priya")).toBe(true);
    expect(db2.baa.assemblyai).toBe(true);
  });

  it("audio survives on disk, plays back byte-identical, and retention deletes the file", () => {
    const dir = tempDir();
    const store = new DiskAudioStore(dir);
    store.append("mtg_x", Buffer.from("hello "));
    store.append("mtg_x", Buffer.from("world"));

    // Fresh instance = restart; bytes must match exactly.
    const store2 = new DiskAudioStore(dir);
    expect(store2.read("mtg_x").toString()).toBe("hello world");

    const db = createDb();
    seedUsers(db);
    db.meetings.set("mtg_x", {
      id: "mtg_x",
      entityId: "entity_main",
      ownerUserId: "u_dana",
      title: "t",
      mode: "in_person",
      status: "ready",
      endedAt: new Date(Date.now() - 91 * 24 * 3600 * 1000).toISOString(),
      attendeeUserIds: [],
      phiFlag: false,
      consent: [],
      audioChunks: 2,
      createdAt: new Date().toISOString(),
    });
    const swept = runRetentionSweep(db, new AuditLog(), store2);
    expect(swept.audioPurged).toBe(1);
    expect(store2.read("mtg_x").length).toBe(0);
  });

  it("audit journal reloads with the chain intact and flags tampering", () => {
    const dir = tempDir();
    const log = new AuditLog();
    log.onEvent = (e) => appendAuditEvent(dir, e);
    log.emit({ actorUserId: "u", action: "a1" });
    log.emit({ actorUserId: "u", action: "a2", detail: "x" });

    const reloaded = new AuditLog();
    expect(reloaded.hydrate(loadAuditEvents(dir))).toBe(-1);
    expect(reloaded.length).toBe(2);

    // Continue the chain across the "restart", then verify end-to-end.
    reloaded.onEvent = (e) => appendAuditEvent(dir, e);
    reloaded.emit({ actorUserId: "u", action: "a3" });
    const again = new AuditLog();
    expect(again.hydrate(loadAuditEvents(dir))).toBe(-1);
    expect(again.length).toBe(3);

    // Tamper with the journal → hydration reports the broken index.
    const events = loadAuditEvents(dir);
    events[1] = { ...events[1]!, detail: "forged" };
    const tampered = new AuditLog();
    expect(tampered.hydrate(events)).toBe(1);
  });
});
