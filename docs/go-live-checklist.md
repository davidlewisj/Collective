# Go-Live Checklist

How to take Collective from the **mock-by-default, test-data staging** it runs as today to a
deployment that handles **real users and real PHI**. Steps are ordered so each one is safe on its
own; do them top to bottom. Cross-references: `docs/deploy.md` (topology), `docs/procurement-baa-runbook.md`
(BAA evidence), `docs/design-spec.md` §6 (security) and §8 (phases).

> **The golden rule (§6.6):** a vendor only receives audio/text when its BAA is marked executed on the
> registry. In mock mode nothing leaves the box, so the demo pre-marks all BAAs true. **With a real
> vendor key set, the registry starts all-false and you must flip only the entries you have actually
> signed.** Do not flip a BAA toggle you can't back with paperwork.

---

## 0. Prerequisites — do NOT put real PHI in the app until these are true

- [ ] **HIPAA-eligible hosting with a signed BAA.** The current Render **Free** instance is for
      **test/demo data only** — no hosting BAA, ephemeral disk. Real PHI needs a BAA-covered host
      (the AWS landing zone in `infra/` per PF-1..3, or a hosting plan that will sign a BAA).
- [ ] **Executed subprocessor BAAs**, filed per `docs/procurement-baa-runbook.md`, for every vendor
      that will touch PHI: **AssemblyAI** (transcription), **Anthropic / Claude workspace** (the MCP
      connector), **Microsoft** (sign-in + calendar). Voiceprints stay on the mock engine for now
      (see §3), so no voice-vendor BAA is needed yet.

## 1. Data durability

- [ ] Point **`COLLECTIVE_DATA_DIR`** at a **persistent** disk/volume. It holds the state snapshot,
      the audio files, and the append-only audit journal — on ephemeral storage they vanish on
      restart, which for the audit log is a compliance problem.
- [ ] (Target architecture is Aurora Postgres + S3 + WORM audit, PF-3; the JSON/disk store is the
      dev slice behind the same seam.)

## 2. Public origin & TLS

- [ ] Set **`COLLECTIVE_PUBLIC_URL`** to the public `https://` origin (on Render, `RENDER_EXTERNAL_URL`
      is picked up automatically). It drives the OAuth issuer, the MCP resource URL, the consent-page
      redirect, and the Microsoft callback — they must all agree.
- [ ] Single-origin serving: build the web app and set **`COLLECTIVE_WEB_DIR`** (see `docs/deploy.md`).
- [ ] Set **`COLLECTIVE_ALLOWED_ORIGINS`** to your web origin(s) for CORS.

## 3. Flip vendors from mock → real (each only *after* its BAA)

- [ ] **AssemblyAI** — set **`ASSEMBLYAI_API_KEY`**. This activates the real batch transcriber *and*
      the live-caption relay. Leave `ASSEMBLYAI_STREAMING_URL` and `ASSEMBLYAI_STREAMING_MODE` **unset**
      to keep the shipped defaults (US-pinned host `streaming.us.assemblyai.com`, `mode=balanced`,
      `universal-3-5-pro` + `universal-2` fallback — see decision D16).
- [ ] **Mark the AssemblyAI BAA executed** — Settings → Workspace → BAA registry, or seed at boot with
      `COLLECTIVE_BAA=assemblyai,claudeWorkspace,microsoft`. Until this is on, patient-info-flagged
      meetings are blocked from AssemblyAI (no batch transcript, no live captions) by design.
- [ ] **Claude connector** — mark `claudeWorkspace`; an org admin mints an OAuth client (Settings →
      Workspace → Claude connectors) and adds it in claude.ai. Needs `COLLECTIVE_PUBLIC_URL` reachable.
- [ ] **Microsoft sign-in** — set **`GRAPH_TENANT_ID`**, **`GRAPH_CLIENT_ID`**, **`GRAPH_CLIENT_SECRET`**,
      **`GRAPH_REDIRECT_URI`**; mark `microsoft`. (`GRAPH_REDIRECT_URI` must match the Entra app registration.)
- [ ] **Voiceprints — leave on mock.** Do **not** set `VOICE_API_KEY`: the real voice engine is a stub
      that intentionally throws (`D14`), and the `voice` BAA stays off until a real speaker-ID vendor is
      integrated. Enrollment/matching keep working against the deterministic mock in the meantime.

## 4. PHI gating posture

- [ ] Leave **`COLLECTIVE_PHI_FAILSAFE`** at its default (**on**): an *unanswered* "contains patient
      info?" flag is treated as PHI. Only set `COLLECTIVE_PHI_FAILSAFE=0` if the sponsor explicitly
      accepts the looser posture (Q6 is WA-strict; don't loosen without sign-off).

## 5. Security hardening — before real users sign in

- [ ] **Lock down dev-login. ⚠ Needs a small code change, not just config.** `POST /auth/dev-login`
      currently mints a session for any known email with no password — fine for local/dev, unacceptable
      on a public URL. It must be disabled in production (e.g. off whenever Microsoft sign-in is
      configured, or behind an explicit allow flag). **This is not yet gated in the code** — track it as
      a required pre-launch task. *(I can implement this gate as a one-PR change on request.)*
- [ ] **MFA + device registration** (issues #14–#15) and **SCIM** per spec §6 — required for the full
      access-control posture; scope with the sponsor.
- [ ] Confirm the idle-session timeout (15 min, §2.6.1) and the RBAC/audit invariants are intact
      (they are in-code; no config needed).

## 6. Verify the switch actually flipped

- [ ] Server boot log should **not** say `dev mode: mock transcriber`. With a real key it logs the real
      adapter and the relay factory is live.
- [ ] Run one **non-PHI** meeting end to end: capture → live captions → stop → diarized transcript.
- [ ] Confirm a **PHI-flagged** meeting with a **missing** BAA is blocked (the deny path): it should
      show the "transcript unavailable — no BAA on file" notice, not silently egress.
- [ ] Confirm the audit journal is being written to the persistent disk from §1.

## 7. Rollback (fast + safe)

- [ ] Unset **`ASSEMBLYAI_API_KEY`** → the app drops straight back to the mock transcriber; no vendor
      traffic, no cost.
- [ ] Flip a BAA entry **off** on the registry → that vendor's egress is blocked immediately (gating is
      evaluated per request), without redeploying.

---

### Environment variables at a glance

| Variable | Purpose | Go-live value |
|---|---|---|
| `ASSEMBLYAI_API_KEY` | Activates real transcription + live relay | set (after BAA) |
| `ASSEMBLYAI_STREAMING_URL` | Override streaming host | unset (defaults US-pinned) |
| `ASSEMBLYAI_STREAMING_MODE` | Streaming latency/accuracy preset | unset (defaults `balanced`) |
| `VOICE_API_KEY` | Real voice-ID vendor | **leave unset** (stub not ready) |
| `COLLECTIVE_DATA_DIR` | Durable state/audio/audit path | persistent disk path |
| `COLLECTIVE_PUBLIC_URL` | Public origin (OAuth/MCP/callbacks) | your `https://` URL |
| `COLLECTIVE_WEB_DIR` | Built web app for single-origin serving | built `apps/web/dist` |
| `COLLECTIVE_ALLOWED_ORIGINS` | CORS allowlist | your web origin(s) |
| `COLLECTIVE_BAA` | Seed executed BAAs at boot | `assemblyai,claudeWorkspace,microsoft` (only signed ones) |
| `COLLECTIVE_PHI_FAILSAFE` | `0` loosens the unanswered-flag rule | unset (fail-safe on) |
| `GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET` / `GRAPH_REDIRECT_URI` | Microsoft Entra sign-in + calendar | set (after BAA) |
| `OAUTH_SCOPES` | MCP connector scope set | optional (has a default) |
