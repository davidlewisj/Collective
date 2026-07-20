# Collective — Implementation Status

Honest, story-level map of what exists in this repository versus the design spec and the Phase 0/1 backlog. Legend:

- ✅ **implemented & tested** in this repo (dev slice; automated tests pass)
- 🔶 **implemented, needs real-world validation** (vendor account, OS hardware, or cloud deploy required — cannot be exercised in this environment)
- 🚧 **not built yet** (designed; tracked in the backlog)
- ⛔ **human-only** (legal/procurement actions no codebase can perform)

## What runs today, end-to-end (verified live)

`npm install && npm run dev:server && npm run dev:web` gives a working product on mock adapters: sign in (dev auth) → consent-gated capture → live captions (SSE) → stop → diarized, name-attributed transcript → title/summary/action items → private notes → per-layer sharing → search → audit trail → MCP server answering `search_meetings` / `get_transcript` / … over Streamable HTTP. 19 server tests cover the compliance core; the token contrast audit enforces WCAG AA in CI.

## Compliance core

| Capability | Spec | State |
|---|---|---|
| RBAC policy decision point, deny-by-default, audio as distinct permission | §2.6.1, §2.7.2 | ✅ (`rbac.ts`; deny paths tested incl. admin-no-content, attendee-no-layers) |
| Hash-chained append-only audit of every content access | §2.6.1, §3.3 | ✅ (`audit.ts`; tamper detection tested) — 🚧 WORM/S3 Object Lock store (AR-1 prod target) |
| Consent policy engine, WA-strict default, objection path | §2.6.2 | ✅ (start blocked until attestation; objection deletes audio, keeps notes) |
| Per-meeting PHI flag + BAA-registry egress gating (insight, MCP, **and** real-vendor transcription) + fail-safe + owner reprocess after registry changes | §6.6 | ✅ (all three gates tested; pulled forward from Phase 1.5) |
| Retention clocks + deletion cascade | §2.6.4 | ✅ sweep tested — 🚧 soft-delete window, backup expiry, deletion certificates |
| Session idle timeout | §2.6.1 | ✅ server-side — 🚧 client lock UX |
| Microsoft Entra ID sign-in (ID-1): confidential-client code flow, email link-or-provision (least privilege), role management endpoint, `amr` (MFA) recorded per sign-in | §2.6.1 (#11) | ✅ flow tested against a faked token endpoint — 🔶 live-tenant validation pending; JWKS signature verification is prod hardening. MFA enforcement = tenant conditional access. SCIM + device registry still 🚧 (#14/#15) |
| Durable local persistence (meetings/transcripts/notes/shares/policies survive restarts; audio on disk; append-only audit journal chain-verified at boot) | §3.3 dev slice | ✅ behind the storage seam (`persist.ts`); sessions intentionally ephemeral |
| Encryption at rest w/ per-entity KMS keys + Postgres/RLS + WORM audit | §3.3 | 🚧 the production stores (PF-1..3) swap in behind the same seam; SCP guardrails already in `infra/policies/` |
| BAAs (AssemblyAI, AWS, Microsoft, Anthropic workspace) | §2.6.5 | ⛔ human signatures — runbook + issues #6/#7/#8/#9; server's BAA registry mirrors them at runtime |

## Product pipeline

| Capability | Spec | State |
|---|---|---|
| Meeting record (audio/transcript/notes/AI), notes private-by-default | §2.4 | ✅ |
| Diarized transcription — mock adapter | §2.2 | ✅ deterministic dev engine |
| Diarized transcription — AssemblyAI async (`speaker_labels`, eager delete) | §2.2 | 🔶 real REST adapter written; needs a keyed account + BAA to validate |
| Voice memos — Sync API | §2.2 | 🔶 same |
| Live captions — streaming relay to AssemblyAI v3 (`speaker_labels`, PCM16 relay, §6.6-gated, idle cost guard) | §2.2 (IN-2) | ✅ mock mode + real relay — validated against the live AssemblyAI endpoint on a keyed deployment (2026-07-20): captions render in real time while speaking |
| Calendar naming — Microsoft Graph calendar (signed-in users) with per-user ICS feed fallback; untitled captures named from the current event, attendees matched by email | AT-3 | ✅ both paths tested (Graph via faked API; ICS parser/matching); precedence Graph → ICS → untitled |
| Claude connector tokens — long-lived, revocable, MCP-surface-only bearer tokens + in-app "Connect Claude" setup card (Claude Desktop via mcp-remote today; claude.ai when publicly deployed) | §6.2 (revised: connector-first AI) | ✅ tested (mint/use/scope/revoke) |
| Attribution v1: mic-channel identity, roster name cues, margin rule, corrections, unknown speakers | §2.3.1, §2.3.4 | ✅ tested |
| Insight — mock heuristic + fallback | §6.1 | ✅ |
| Insight — Claude on Bedrock (`anthropic.claude-sonnet-5`, assignee validation, minimum-necessary payload) | §6.1, §6.5 | 🔶 adapter written; needs AWS account under BAA |
| MCP server (5 tools, per-caller ACL, PHI gating, audit) | §6.2–6.4 | ✅ verified live over Streamable HTTP — 🚧 OAuth 2.1 resource-server front (RFC 9728/8707) before claude.ai exposure |
| Search with query-time ACL + instant revocation | §3.3 | ✅ tested |

## Clients

| Capability | Spec | State |
|---|---|---|
| Design tokens (5-color system, semantic states, speaker ramp, type/motion scales) + CI contrast audit | §7.2 | ✅ |
| Web app (meeting list, consent-gated live capture w/ waveform + SSE captions, meeting detail w/ PHI chip + corrections, share sheet, admin) | §7.3 | ✅ built against the same API (see apps/web) — visual QA on real devices pending |
| Desktop shell (Electron): window/tray/hotkey, **system-audio loopback plumbing** via `setDisplayMediaRequestHandler` | §2.1.1, §2.7.1 | 🔶 source-verified; Windows loopback + macOS behavior require real hardware (checklist in docs/desktop-capture.md) |
| Per-process WASAPI loopback, macOS Core Audio taps, AEC | §2.1.1 | 🚧 native modules (WC-2/3, MC-2/3) — Linux CI cannot build or exercise them |
| Mobile apps (iOS/Android in-person capture) | §2.1.2 | 🚧 Phase 1.5; requires Xcode/Android toolchains + device testing |
| Voice profiles / speaker-ID service | §2.3.3, §5 | 🚧 Phase 1.5 (GPU inference service) |
| Teams/Graph attribution module | §2.3.2 | 🚧 Phase 2 (tenant admin prerequisites) |

## The gap to production, in one paragraph

The compliance logic, data model, pipeline, MCP surface, UI, and vendor adapters are real and tested here; what stands between this repo and a deployable product is exactly the work that requires things a codebase cannot contain: executed BAAs (issues #6–#9), an AWS landing zone with KMS/Postgres/WORM storage behind the committed SCPs (PF-1..3), Entra ID OIDC + SCIM + device attestation (#11–#15), real-vendor validation of the AssemblyAI/Bedrock adapters, native capture modules exercised on Windows/macOS hardware, and mobile clients. Each is tracked, designed, and has its seam already cut in this codebase.
