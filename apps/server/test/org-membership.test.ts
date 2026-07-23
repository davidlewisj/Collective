import { describe, expect, it } from "vitest";
import { auth, login, makeCtx, type Ctx } from "./helpers.js";
import { activeAdminCount, linkOrProvisionUser } from "../src/store.js";

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

describe("org membership — stable Entra-oid identity", () => {
  it("matches a returning sign-in by oid even after the mailbox is renamed", () => {
    const ctx = makeCtx();
    const first = linkOrProvisionUser(ctx.db, msClaims("old.name@clinic.example", "Pat Doe", "oid-stable"));
    const renamed = linkOrProvisionUser(ctx.db, msClaims("new.name@clinic.example", "Pat Doe", "oid-stable"));
    expect(renamed.id).toBe(first.id); // same account — identity is the oid, not the email
    expect([...ctx.db.users.values()].filter((u) => u.entraOid === "oid-stable")).toHaveLength(1);
  });

  it("does NOT let a reused email inherit a prior (admin) account", () => {
    const ctx = makeCtx();
    // A departed admin, later deleted in Entra; their app row lingers.
    const departed = linkOrProvisionUser(ctx.db, msClaims("shared@clinic.example", "First Person", "oid-first"));
    departed.role = "org_admin";
    departed.status = "active";
    // The address is reassigned to a new hire (a DIFFERENT Entra oid).
    const reused = linkOrProvisionUser(ctx.db, msClaims("shared@clinic.example", "Second Person", "oid-second"));
    expect(reused.id).not.toBe(departed.id); // fresh account, no inheritance
    expect(reused.role).toBe("member");
    expect(reused.status).toBe("pending");
    // The old admin record is untouched (cleanup is a separate off-boarding step).
    expect(ctx.db.users.get(departed.id)!.role).toBe("org_admin");
  });

  it("binds the oid to a pre-existing directory row on first Microsoft sign-in", () => {
    const ctx = makeCtx();
    expect(ctx.db.users.get("u_priya")!.entraOid).toBeUndefined();
    const linked = linkOrProvisionUser(ctx.db, msClaims("priya@collective.dev", "Priya N", "oid-priya"));
    expect(linked.id).toBe("u_priya");
    expect(linked.entraOid).toBe("oid-priya");
    // Once bound, a later sign-in under a changed email still lands on the same row.
    const again = linkOrProvisionUser(ctx.db, msClaims("priya.natarajan@collective.dev", "Priya N", "oid-priya"));
    expect(again.id).toBe("u_priya");
  });
});

describe("org membership — last-admin guardrail", () => {
  it("activeAdminCount counts only active, non-deactivated org_admins", () => {
    const ctx = makeCtx();
    expect(activeAdminCount(ctx.db)).toBe(1); // seeded dana
    const p = linkOrProvisionUser(ctx.db, msClaims("new@clinic.example", "New", "oid-new"));
    p.role = "org_admin"; // still pending — does not count
    expect(activeAdminCount(ctx.db)).toBe(1);
    p.status = "active";
    expect(activeAdminCount(ctx.db)).toBe(2);
    p.deactivated = true; // deactivated — does not count
    expect(activeAdminCount(ctx.db)).toBe(1);
  });

  it("allows demoting an admin while a second admin remains", async () => {
    const ctx = makeCtx();
    const dana = await login(ctx, "dana@collective.dev");
    const promote = await ctx.app.inject({
      method: "PUT",
      url: "/admin/users/u_omar/role",
      headers: auth(dana),
      payload: { role: "org_admin" },
    });
    expect(promote.statusCode).toBe(200);
    expect(activeAdminCount(ctx.db)).toBe(2);

    const demote = await ctx.app.inject({
      method: "PUT",
      url: "/admin/users/u_omar/role",
      headers: auth(dana),
      payload: { role: "member" },
    });
    expect(demote.statusCode).toBe(200); // fine — dana is still an admin
    expect(activeAdminCount(ctx.db)).toBe(1);
  });

  it("keeps the sole admin from demoting themselves (can't reach zero admins)", async () => {
    const ctx = makeCtx();
    const dana = await login(ctx, "dana@collective.dev");
    expect(activeAdminCount(ctx.db)).toBe(1);
    const res = await ctx.app.inject({
      method: "PUT",
      url: "/admin/users/u_dana/role",
      headers: auth(dana),
      payload: { role: "member" },
    });
    expect(res.statusCode).toBe(400); // self-change guard; org still has its admin
    expect(activeAdminCount(ctx.db)).toBe(1);
  });
});

describe("org membership — off-boarding active members", () => {
  it("deactivates an approved member: blocks access, revokes sessions, keeps the record", async () => {
    const ctx = makeCtx();
    const dana = await login(ctx, "dana@collective.dev");
    const omar = await login(ctx, "omar@collective.dev");
    // Omar can use the app before off-boarding.
    expect((await ctx.app.inject({ method: "GET", url: "/meetings", headers: auth(omar) })).statusCode).toBe(200);

    const res = await ctx.app.inject({ method: "POST", url: "/admin/members/u_omar/deactivate", headers: auth(dana) });
    expect(res.statusCode).toBe(200);
    expect(res.json().member.deactivated).toBe(true);
    // Soft delete: the record survives (notes/meetings/audit stay intact).
    expect(ctx.db.users.has("u_omar")).toBe(true);
    expect(ctx.audit.query({}).some((e) => e.action === "admin.member_deactivated" && e.detail === "u_omar")).toBe(true);

    // Session revoked immediately, and re-login is refused.
    expect((await ctx.app.inject({ method: "GET", url: "/meetings", headers: auth(omar) })).statusCode).toBe(401);
    const relogin = await ctx.app.inject({ method: "POST", url: "/auth/dev-login", payload: { email: "omar@collective.dev" } });
    expect(relogin.statusCode).toBe(404); // deactivated accounts can't sign in

    // Hidden from the attendee directory.
    const users = (await ctx.app.inject({ method: "GET", url: "/users", headers: auth(dana) })).json().users as Array<{ id: string }>;
    expect(users.some((u) => u.id === "u_omar")).toBe(false);
  });

  it("reactivates an off-boarded member", async () => {
    const ctx = makeCtx();
    const dana = await login(ctx, "dana@collective.dev");
    await ctx.app.inject({ method: "POST", url: "/admin/members/u_omar/deactivate", headers: auth(dana) });

    const res = await ctx.app.inject({ method: "POST", url: "/admin/members/u_omar/reactivate", headers: auth(dana) });
    expect(res.statusCode).toBe(200);
    expect(res.json().member.deactivated).toBe(false);
    expect(ctx.audit.query({}).some((e) => e.action === "admin.member_reactivated" && e.detail === "u_omar")).toBe(true);
    // Can sign in again.
    expect((await ctx.app.inject({ method: "POST", url: "/auth/dev-login", payload: { email: "omar@collective.dev" } })).statusCode).toBe(200);
  });

  it("refuses to off-board the last administrator (409, reachable)", async () => {
    const ctx = makeCtx();
    const dana = await login(ctx, "dana@collective.dev");
    expect(activeAdminCount(ctx.db)).toBe(1);
    const res = await ctx.app.inject({ method: "POST", url: "/admin/members/u_dana/deactivate", headers: auth(dana) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/last administrator/i);
    expect(ctx.db.users.get("u_dana")!.deactivated).toBeFalsy();
  });

  it("allows off-boarding an admin while a backup admin remains", async () => {
    const ctx = makeCtx();
    const dana = await login(ctx, "dana@collective.dev");
    await ctx.app.inject({ method: "PUT", url: "/admin/users/u_omar/role", headers: auth(dana), payload: { role: "org_admin" } });
    expect(activeAdminCount(ctx.db)).toBe(2);
    const res = await ctx.app.inject({ method: "POST", url: "/admin/members/u_omar/deactivate", headers: auth(dana) });
    expect(res.statusCode).toBe(200);
    expect(activeAdminCount(ctx.db)).toBe(1);
  });

  it("rejects deactivating a pending member (use deny), and double-deactivate / bad restore", async () => {
    const ctx = makeCtx();
    const dana = await login(ctx, "dana@collective.dev");
    seedPending(ctx, "new@clinic.example", "New Person", "oid-new");
    const pendingId = [...ctx.db.users.values()].find((u) => u.status === "pending")!.id;

    expect((await ctx.app.inject({ method: "POST", url: `/admin/members/${pendingId}/deactivate`, headers: auth(dana) })).statusCode).toBe(409);
    // Restoring a member who isn't deactivated is a 409.
    expect((await ctx.app.inject({ method: "POST", url: "/admin/members/u_priya/reactivate", headers: auth(dana) })).statusCode).toBe(409);
    // Deactivate omar once (ok), twice (409).
    expect((await ctx.app.inject({ method: "POST", url: "/admin/members/u_priya/deactivate", headers: auth(dana) })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "POST", url: "/admin/members/u_priya/deactivate", headers: auth(dana) })).statusCode).toBe(409);
  });

  it("is admin-only and 404s unknown ids", async () => {
    const ctx = makeCtx();
    const omar = await login(ctx, "omar@collective.dev");
    const dana = await login(ctx, "dana@collective.dev");
    expect((await ctx.app.inject({ method: "POST", url: "/admin/members/u_priya/deactivate", headers: auth(omar) })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "POST", url: "/admin/members/u_ghost/deactivate", headers: auth(dana) })).statusCode).toBe(404);
  });
});
