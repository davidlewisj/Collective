import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit.js";
import { LiveHub } from "../src/pipeline.js";
import { StreamingRelay, Upstream } from "../src/relay.js";
import { createDb, seedUsers } from "../src/store.js";
import type { Meeting } from "@collective/shared";
import type WebSocket from "ws";

function meetingFixture(db: ReturnType<typeof createDb>): Meeting {
  const m: Meeting = {
    id: "mtg_live",
    entityId: "entity_main",
    ownerUserId: "u_dana",
    title: "",
    mode: "in_person",
    status: "recording",
    attendeeUserIds: [],
    phiFlag: false,
    consent: [],
    audioChunks: 0,
    createdAt: new Date().toISOString(),
  };
  db.meetings.set(m.id, m);
  return m;
}

class FakeUpstream implements Upstream {
  sent: Array<Buffer | string> = [];
  closed = false;
  private messageCb: ((text: string) => void) | null = null;
  private downCb: (() => void) | null = null;

  send(data: Buffer | string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  onMessage(cb: (text: string) => void): void {
    this.messageCb = cb;
  }
  onDown(cb: () => void): void {
    this.downCb = cb;
  }
  emitTurn(msg: object): void {
    this.messageCb?.(JSON.stringify(msg));
  }
  goDown(): void {
    this.downCb?.();
  }
}

/** Minimal stand-in for the ws client socket. */
class FakeClient extends EventEmitter {
  closedWith: number | null = null;
  close(code?: number): void {
    this.closedWith = code ?? 1000;
  }
}

function setup(opts: { phiFlag?: boolean | null; assemblyaiBaa?: boolean } = {}) {
  const db = createDb();
  seedUsers(db);
  db.baa.assemblyai = opts.assemblyaiBaa ?? true;
  const m = meetingFixture(db);
  m.phiFlag = opts.phiFlag === undefined ? false : opts.phiFlag;
  const hub = new LiveHub();
  const captions: unknown[] = [];
  hub.subscribe(m.id, (event, data) => {
    if (event === "caption") captions.push(data);
  });
  const upstream = new FakeUpstream();
  const relay = new StreamingRelay(db, hub, new AuditLog(), () => upstream);
  return { db, m, relay, upstream, captions };
}

describe("streaming relay (IN-2)", () => {
  it("forwards binary audio frames and maps Turn events to captions", () => {
    const { relay, m, upstream, captions } = setup();
    const client = new FakeClient();
    relay.attach(client as unknown as WebSocket, m, 16000);

    client.emit("message", Buffer.from([1, 2, 3]), true);
    client.emit("message", "not audio json", false); // ignored: text frames untrusted
    expect(upstream.sent).toHaveLength(1);

    upstream.emitTurn({ type: "Turn", turn_order: 4, transcript: "hello there", end_of_turn: false });
    upstream.emitTurn({
      type: "Turn",
      turn_order: 4,
      transcript: "Hello there, team.",
      end_of_turn: true,
      turn_is_formatted: true,
      speaker_label: "B",
    });
    expect(captions).toHaveLength(2);
    expect(captions[0]).toMatchObject({ seq: 4, interim: true, text: "hello there" });
    expect(captions[1]).toMatchObject({ seq: 4, interim: false, cluster: "B", text: "Hello there, team." });
  });

  it("derives the cluster from word-level speakers when no turn label exists", () => {
    const { relay, m, upstream, captions } = setup();
    relay.attach(new FakeClient() as unknown as WebSocket, m, 16000);
    upstream.emitTurn({
      type: "Turn",
      turn_order: 1,
      transcript: "mixed turn",
      end_of_turn: true,
      words: [{ speaker: "C" }, { speaker: "C" }, { speaker: "A" }],
    });
    expect(captions[0]).toMatchObject({ cluster: "C" });
  });

  it("refuses PHI-effective meetings when the AssemblyAI BAA is absent (§6.6 on live egress)", () => {
    const { relay, m, upstream } = setup({ phiFlag: true, assemblyaiBaa: false });
    expect(relay.available(m)).toBe(false);
    const client = new FakeClient();
    relay.attach(client as unknown as WebSocket, m, 16000);
    expect(client.closedWith).toBe(1008);
    client.emit("message", Buffer.from([1]), true);
    expect(upstream.sent).toHaveLength(0); // nothing ever reaches the vendor
  });

  it("closes the vendor session when the client disconnects (cost guard)", () => {
    const { relay, m, upstream } = setup();
    const client = new FakeClient();
    relay.attach(client as unknown as WebSocket, m, 16000);
    client.emit("close");
    expect(upstream.closed).toBe(true);
  });

  it("survives vendor failure without touching the client recording path", () => {
    const { relay, m, upstream, captions } = setup();
    const client = new FakeClient();
    relay.attach(client as unknown as WebSocket, m, 16000);
    upstream.goDown();
    client.emit("message", Buffer.from([9, 9]), true); // no crash, silently dropped
    expect(captions).toHaveLength(0);
    expect(upstream.closed).toBe(true);
  });
});
