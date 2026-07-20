/**
 * Append-only, hash-chained audit log (design-spec §2.6.1, §3.3; HIPAA
 * §164.312(b)). Every access to meeting content MUST flow through emit().
 * Production target: Kinesis → S3 Object Lock (backlog AR-1); the chain
 * semantics here are the same ones that store would verify.
 */
import { createHash } from "node:crypto";
import { AuditEvent, ShareLayer } from "@collective/shared";

export class AuditLog {
  private events: AuditEvent[] = [];

  emit(e: {
    actorUserId: string;
    action: string;
    meetingId?: string;
    layer?: ShareLayer | "record";
    detail?: string;
  }): AuditEvent {
    const prevHash = this.events.length ? this.events[this.events.length - 1]!.hash : "genesis";
    const body = {
      seq: this.events.length + 1,
      at: new Date().toISOString(),
      ...e,
      prevHash,
    };
    const hash = createHash("sha256").update(prevHash + JSON.stringify(body)).digest("hex");
    const event: AuditEvent = { ...body, hash };
    this.events.push(event);
    return event;
  }

  /** Recomputes the chain; returns index of first tampered event, or -1. */
  verifyChain(): number {
    let prev = "genesis";
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i]!;
      const { hash, ...rest } = e;
      const expected = createHash("sha256").update(prev + JSON.stringify(rest)).digest("hex");
      if (hash !== expected || e.prevHash !== prev) return i;
      prev = hash;
    }
    return -1;
  }

  query(filter: { meetingId?: string; actorUserId?: string }): AuditEvent[] {
    return this.events.filter(
      (e) =>
        (!filter.meetingId || e.meetingId === filter.meetingId) &&
        (!filter.actorUserId || e.actorUserId === filter.actorUserId),
    );
  }

  get length(): number {
    return this.events.length;
  }

  /** Test hook: simulate tampering to prove verifyChain catches it. */
  _unsafeMutate(i: number, patch: Partial<AuditEvent>): void {
    Object.assign(this.events[i]!, patch);
  }
}
