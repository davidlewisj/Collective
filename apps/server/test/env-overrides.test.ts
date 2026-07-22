import { describe, expect, it } from "vitest";
import { applyEnvOverrides, createDb } from "../src/store.js";

describe("environment policy seeds", () => {
  it("seeds BAA registry entries from COLLECTIVE_BAA", () => {
    const db = createDb();
    const applied = applyEnvOverrides(db, { COLLECTIVE_BAA: "assemblyai, claudeWorkspace" });
    expect(db.baa.assemblyai).toBe(true);
    expect(db.baa.claudeWorkspace).toBe(true);
    expect(db.baa.microsoft).toBe(false); // not listed → untouched
    expect(applied).toContain("baa.assemblyai=true");
  });

  it("ignores unknown entries and leaves defaults alone", () => {
    const db = createDb();
    const applied = applyEnvOverrides(db, { COLLECTIVE_BAA: "everything,nothing" });
    expect(applied).toHaveLength(0);
    expect(db.baa.assemblyai).toBe(false);
    expect(db.consentPolicy.phiFailSafe).toBe(true);
  });

  it("disables the PHI fail-safe only on the explicit '0'", () => {
    const db = createDb();
    applyEnvOverrides(db, { COLLECTIVE_PHI_FAILSAFE: "0" });
    expect(db.consentPolicy.phiFailSafe).toBe(false);
    const db2 = createDb();
    applyEnvOverrides(db2, { COLLECTIVE_PHI_FAILSAFE: "false" });
    expect(db2.consentPolicy.phiFailSafe).toBe(true);
  });
});
