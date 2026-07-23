import { describe, expect, it } from "vitest";
import { auth, login, makeCtx, type Ctx } from "./helpers.js";
import { linkOrProvisionUser } from "../src/store.js";

const BOOTSTRAP = "owner@clinic.example";

function msClaims(email: string, name: string, oid: string) {
  return { email, name, oid };
}

/** Provision a pending Microsoft user directly and give them a live session. */
function seedPending(ctx: Ctx, email: string, name: string, oid: string): { id: string; token: string } {
  const user = linkOrProvisionUser(ctx.db, msClaims(email, name, oid));
  const token = `sess_${oid}`;
  ctx.db.sessions.set(token, { token, userId: user.id, createdAt: Date.now(), lastSeenAt: Date.now() });
  return { id: user.id, token };
}

describe("org membership — provisioning (linkOrProvisionUser)", () => {
  it("seeds the demo directory as active members", () => {
    const ctx = makeCtx();
    for (const u of ctx.db.users.values()) expect(u.status).toBe("active");
  });

  it("provisions an unknown Microsoft sign-in as a PENDING member", () => {
    const ctx = makeCtx();
    const u = linkOrProvisionUser(ctx.db, msClaims("new@clinic.example", "New Person", "oid-new"));
    expect(u.role).toBe("member");
    expect(u.status).toBe("pending");
  });

  it("provisions the bootstrap-admin email as an ACTIVE org_admin", () => {
    const ctx = makeCtx();
    const u = linkOrProvisionUser(ctx.db, msClaims(BOOTSTRAP, "The Owner", "oid-owner"), {
      bootstrapAdminEmail: BOOTSTRAP,
    });
    expect(u.role).toBe("org_admin");
    expect(u.status).toBe("active");
  });

  it("matches the bootstrap email case-insensitively", () => {
    const ctx = makeCtx();
    const u = linkOrProvisionUser(ctx.db, msClaims("OWNER@Clinic.Example", "The Owner", "oid-owner"), {
      bootstrapAdminEmail: BOOTSTRAP,
    });
    expect(u.role).toBe("org_admin");
    expect(u.status).toBe("active");
  });

  it("promotes an existing pending user to active org_admin when they are the bootstrap admin", () => {
    const ctx = makeCtx();
    // First sign-in before the env was set — lands pending.
    const first = linkOrProvisionUser(ctx.db, msClaims(BOOTSTRAP, "The Owner", "oid-owner"));
    expect(first.status).toBe("pending");
    // Second sign-in after COLLECTIVE_BOOTSTRAP_ADMIN is configured — promoted.
    const again = linkOrProvisionUser(ctx.db, msClaims(BOOTSTRAP, "The Owner", "oid-owner"), {
      bootstrapAdminEmail: BOOTSTRAP,
    });
    expect(again.id).toBe(first.id); // no duplicate account
    expect(again.role).toBe("org_admin");
    expect(again.status).toBe("active");
  });

  it("does not touch an existing non-bootstrap user's role or status", () => {
    const ctx = makeCtx();
    const before = ctx.db.users.get("u_priya")!;
    const linked = linkOrProvisionUser(ctx.db, msClaims("priya@collective.dev", "Priya N", "oid-priya"), {
      bootstrapAdminEmail: BOOTSTRAP,
    });
    expect(linked.id).toBe("u_priya");
    expect(linked.role).toBe(before.role);
    expect(linked.status).toBe("active");
  });
});

describe("org membership — pending gate", () => {
  it("lets a pending member read /me but nothing else", async () => {
    const ctx = makeCtx();
    const p = seedPending(ctx, "new@clinic.example", "New Person", "oid-new");

    const me = await ctx.app.inject({ method: "GET", url: "/me", headers: auth(p.token) });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.status).toBe("pending");

    for (const url of ["/users", "/meetings"]) {
      const res = await ctx.app.inject({ method: "GET", url, headers: auth(p.token) });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/pending/i);
    }
  });

  it("hides pending members from the /users attendee directory", async () => {
    const ctx = makeCtx();
    seedPending(ctx, "new@clinic.example", "New Person", "oid-new");
    const dana = await login(ctx, "dana@collective.dev");
    const users = (await ctx.app.inject({ method: "GET", url: "/users", headers: auth(dana) })).json().users as Array<{
      id: string;
    }>;
    expect(users.some((u) => u.id.startsWith("u_ms_"))).toBe(false);
    expect(users.some((u) => u.id === "u_priya")).toBe(true);
  });
});

describe("org membership — admin directory & approvals", () => {
  it("lists the full directory with pending requests sorted first (admin only)", async () => {
    const ctx = makeCtx();
    seedPending(ctx, "new@clinic.example", "New Person", "oid-new");
    const dana = await login(ctx, "dana@collective.dev");

    const res = await ctx.app.inject({ method: "GET", url: "/admin/members", headers: auth(dana) });
    expect(res.statusCode).toBe(200);
    const members = res.json().members as Array<{ status: string; email: string }>;
    expect(members[0]!.status).toBe("pending"); // pending float to the top
    expect(members.some((m) => m.email === "dana@collective.dev" && m.status === "active")).toBe(true);
    expect(members.length).toBe(5); // 4 seeded + 1 pending
  });

  it("refuses the directory to non-admins", async () => {
    const ctx = makeCtx();
    const omar = await login(ctx, "omar@collective.dev");
    const res = await ctx.app.inject({ method: "GET", url: "/admin/members", headers: auth(omar) });
    expect(res.statusCode).toBe(403);
  });

  it("approve flips a pending member to active and unblocks their session", async () => {
    const ctx = makeCtx();
    const p = seedPending(ctx, "new@clinic.example", "New Person", "oid-new");
    const dana = await login(ctx, "dana@collective.dev");

    // Blocked before approval.
    expect((await ctx.app.inject({ method: "GET", url: "/users", headers: auth(p.token) })).statusCode).toBe(403);

    const ok = await ctx.app.inject({ method: "POST", url: `/admin/members/${p.id}/approve`, headers: auth(dana) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().member.status).toBe("active");
    expect(ctx.db.users.get(p.id)!.status).toBe("active");
    expect(ctx.audit.query({}).some((e) => e.action === "admin.member_approved" && e.detail === p.id)).toBe(true);

    // The same session now works.
    expect((await ctx.app.inject({ method: "GET", url: "/users", headers: auth(p.token) })).statusCode).toBe(200);
  });

  it("approving an already-active member is a 409", async () => {
    const ctx = makeCtx();
    const dana = await login(ctx, "dana@collective.dev");
    const res = await ctx.app.inject({ method: "POST", url: "/admin/members/u_priya/approve", headers: auth(dana) });
    expect(res.statusCode).toBe(409);
  });

  it("deny removes the pending account and revokes its sessions", async () => {
    const ctx = makeCtx();
    const p = seedPending(ctx, "new@clinic.example", "New Person", "oid-new");
    const dana = await login(ctx, "dana@collective.dev");

    const ok = await ctx.app.inject({ method: "POST", url: `/admin/members/${p.id}/deny`, headers: auth(dana) });
    expect(ok.statusCode).toBe(200);
    expect(ctx.db.users.has(p.id)).toBe(false);
    expect(ctx.db.sessions.has(p.token)).toBe(false);
    expect(ctx.audit.query({}).some((e) => e.action === "admin.member_denied" && e.detail === p.id)).toBe(true);

    // The revoked session no longer authenticates.
    expect((await ctx.app.inject({ method: "GET", url: "/me", headers: auth(p.token) })).statusCode).toBe(401);
  });

  it("denying an already-active member is a 409", async () => {
    const ctx = makeCtx();
    const dana = await login(ctx, "dana@collective.dev");
    const res = await ctx.app.inject({ method: "POST", url: "/admin/members/u_priya/deny", headers: auth(dana) });
    expect(res.statusCode).toBe(409);
  });

  it("404s on an unknown member id", async () => {
    const ctx = makeCtx();
    const dana = await login(ctx, "dana@collective.dev");
    const res = await ctx.app.inject({ method: "POST", url: "/admin/members/u_nope/approve", headers: auth(dana) });
    expect(res.statusCode).toBe(404);
  });
});
