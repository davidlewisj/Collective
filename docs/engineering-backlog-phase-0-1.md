# Collective — Engineering Backlog: Phase 0 & Phase 1 (MVP)

Derived from [design-spec.md](design-spec.md) §8.3. Every story traces to a spec section. Scope is **Phase 0 (compliance foundation)** and **Phase 1 (desktop-first MVP)** only — mobile apps, voice profiles, the Claude.ai MCP connector, the per-meeting PHI flag, and the Teams/Graph module are Phase 1.5/2 and intentionally absent here.

**How to read this document**

- **IDs** are epic-prefixed (`WC-3` = Windows capture, story 3). Reference them in branches/PRs.
- **Size:** S ≤ 3 dev-days · M ≈ 1 week · L ≈ 2–3 weeks. Anything looking like XL has been split.
- **Deps** name story IDs that must land first. Unlisted deps within an epic are implied top-to-bottom.
- **PHI-DoD:** every story marked ⚕ touches PHI paths and carries an extended definition of done — audit events emitted and asserted in tests; encryption at rest/in transit verified; no PHI in logs, traces, or crash reports; access-control tests for deny paths; retention hooks wired.

---

## Milestones

| Gate | Contents | Exit criteria |
|---|---|---|
| **M0 — Foundation gate** (end of Phase 0) | E0.1–E0.5 complete | All BAAs executed and registered; SSO+MFA live; KMS/storage/audit pipeline operational; CI/CD with control checks. **Hard rule from §8.3: nothing records PHI before M0.** |
| **M1 — First capture** (internal alpha) | E1.1–E1.4, minimal E1.6, walking-skeleton UI | A real meeting captured on Windows **and** macOS → live captions → durable audio → async diarized transcript stored as a meeting record; manual speaker labels work |
| **M2 — Trustworthy record** (org-wide dogfood) | E1.5, E1.7, E1.8, full E1.6, audit UI (AR-6) | Attribution v1 names speakers from roster + cues; Bedrock summaries generate on stop; consent workflow gates capture; auditors can trace every access |
| **M3 — MVP GA** | E1.9–E1.12 | Sharing, search, retention automation, hardening/pen-test pass, §7 usability pass (front-desk first-use success), signed installers + auto-update |

**Critical path:** E0.3 → E0.2 → (E1.1 ∥ E1.2) → E1.3 → E1.4 → (E1.5 ∥ E1.7) → M2 → (E1.9 ∥ E1.10) → E1.12.
**De-risk first (§8.2):** the four spike stories (SP-1…SP-4) start in week 1 of Phase 1, before their epics commit to a design.

---

## Spikes (time-boxed de-risking, 1 week each)

| ID | Spike | Question answered | Spec ref |
|---|---|---|---|
| SP-1 | macOS Core Audio taps prototype | Taps on 14.2+ capture per-process call audio reliably across Zoom/Teams/Meet/Safari? TCC prompt UX acceptable? SCK fallback parity? | §2.1.1 |
| SP-2 | Windows per-process loopback prototype | Process-loopback (build 20348+) isolates call apps cleanly? Fallback matrix to whole-device loopback on Win10? | §2.1.1 |
| SP-3 | AEC quality bench | Speaker-bleed cancellation with system channel as reference keeps mic channel "user-only" at usable quality across 3 laptop models? | §2.1.1 |
| SP-4 | Far-field diarization + summary bench | AssemblyAI async diarization error rates on 2–10-speaker room recordings; Bedrock `anthropic.claude-sonnet-5` structured-output reliability on our schema | §2.1.3, §2.2, §6.1 |

---

## Phase 0 epics

### E0.1 Compliance & procurement (owner: Compliance + Eng lead)

| ID | Story | Acceptance criteria | Size | Deps | Spec |
|---|---|---|---|---|---|
| CP-1 | Execute AssemblyAI BAA | Paid account; BAA signed; **Streaming + Sync endpoints enumerated in the executed agreement**; transcript TTL set to 1 h; training opt-out confirmed | S | — | §2.2, §2.6.5 |
| CP-2 | Execute AWS BAA & service allowlist | BAA via AWS Artifact; engineering allowlist of HIPAA-eligible services (incl. Bedrock) enforced via SCP; Bedrock invocation logging confirmed **off** | S | — | §2.6.5, §6.5 |
| CP-3 | Confirm Microsoft BAA coverage | Org's Product Terms/DPA reviewed; Graph/M365 in-scope confirmation filed in BAA registry | S | — | §2.6.5 |
| CP-4 | Anthropic workspace decision record | Decision documented: HIPAA-ready Claude workspace BAA timing for the Phase 1.5 connector (or §6.6 non-PHI mode at launch) | S | — | §6.2, §6.5 |
| CP-5 | HIPAA risk analysis (§164.308(a)(1)) | Risk analysis covering the §4 matrix; findings tracked; sign-off by security officer | M | CP-1..3 | §4 |
| CP-6 | Consent copy with counsel | Recording-consent scripts/disclosures (WA-strict, §2.6.2) and biometric consent text (§2.6.3, held for Phase 1.5) approved by counsel; versioned in repo | M | — | §2.6.2–3 |
| CP-7 | BAA registry (admin console seed) | Registry data model + minimal UI: vendor, surface, execution date, renewal, evidence link; feeds §6.6 gating later | S | PF-4 | §2.6.5 |

### E0.2 Identity & access foundation (owner: Backend)

| ID | Story | Acceptance criteria | Size | Deps | Spec |
|---|---|---|---|---|---|
| ID-1 | OIDC SSO against Entra ID | Auth-code + PKCE; MFA enforced via conditional-access check; no local passwords | M | PF-1 | §2.6.1 |
| ID-2 | RBAC model & policy decision point | Roles (Org Admin, Entity Admin, Compliance Auditor, Member, Guest-viewer); additive scoped grants; deny-by-default; policy unit-tested | L | ID-1 | §2.6.1 |
| ID-3 | Session management | Idle timeout (default 15 min, configurable 5–60); refresh expiry; org-wide revocation | M | ID-1 | §2.6.1 |
| ID-4 | SCIM deprovisioning | Entra ID SCIM feed disables users + revokes sessions/devices within 5 min | M | ID-1 | §2.6.1 |
| ID-5 | Device registry ⚕ | Device ID + attestation (App Attest/Play Integrity/desktop cert) bound to user at first sign-in; token device-binding; self-service + admin list; deregistration wipes app data; audit events | L | ID-1, AR-1 | §2.6.1, §4 r16 |

### E0.3 Platform foundation (owner: DevOps)

| ID | Story | Acceptance criteria | Size | Deps | Spec |
|---|---|---|---|---|---|
| PF-1 | AWS landing zone (IaC) | VPC, private subnets, VPC endpoints (S3, Bedrock, KMS); dev/stage/prod; all IaC; single-entity config per Q1 | L | CP-2 | §3.3 |
| PF-2 | KMS key hierarchy | Entity CMK set (one configured), separate voice-profile CMK reserved; rotation policy; key-retirement runbook | M | PF-1 | §2.6.1, §3.3 |
| PF-3 | Data stores | Aurora PostgreSQL (RLS scaffolding), S3 buckets w/ SSE-KMS + lifecycle hooks, OpenSearch encrypted; backups cross-AZ | L | PF-2 | §3.3 |
| PF-4 | Service skeleton & API gateway | Service template (authN middleware, audit emitter, PHI-scrubbed logging), gateway with TLS 1.3, cert-pinning support for clients | M | PF-1 | §3.1 |
| PF-5 | CI/CD with control gates | Pipelines run tests, token-contrast audit (§7.2.2), dependency scanning, IaC drift check; prod deploys require review | M | PF-4 | §7.2.2 |

### E0.4 Audit & retention infrastructure (owner: Backend)

| ID | Story | Acceptance criteria | Size | Deps | Spec |
|---|---|---|---|---|---|
| AR-1 | Append-only audit pipeline ⚕ | Event schema (actor, action, record, layer, client, IP); Kinesis → S3 Object Lock (WORM); hash-chained batches; 6-year retention | L | PF-3 | §2.6.1, §3.3 |
| AR-2 | Audit emit SDK | One-line emit from any service; delivery guaranteed (outbox); coverage lint rule for PHI endpoints | M | AR-1 | §4 r7 |
| AR-3 | Retention clock engine ⚕ | Per-layer clocks (audio 90 d, transcript 7 y defaults); policy CRUD (admin); clock evaluation job | M | PF-3 | §2.6.4 |
| AR-4 | Deletion pipeline ⚕ | Soft-delete (30 d) → hard-delete cascade across DB, S3, search indexes, caches; backup-expiry alignment; deletion certificates | L | AR-3 | §2.6.4 |
| AR-5 | Legal hold | Per-record/matter holds override clocks; Compliance-only visibility; audit-logged | S | AR-3 | §2.6.4 |
| AR-6 | Auditor query UI | Compliance role can query by user/record/date; export; per-record access reconstruction | M | AR-1, ID-2 | §4 r14 |

### E0.5 Observability, PHI-safe (owner: DevOps)

| ID | Story | Acceptance criteria | Size | Deps | Spec |
|---|---|---|---|---|---|
| OB-1 | PHI-scrubbed telemetry | Log/trace/crash pipelines with scrubbing middleware; red-team test proves no transcript/name leakage | M | PF-4 | §4 r16 |
| OB-2 | Golden signals & alerting | Dashboards + paging for capture-pipeline health, vendor latency/errors, cost (streaming session minutes, Bedrock tokens) | M | OB-1 | §8.2 |

---

## Phase 1 epics

### E1.1 Desktop capture — Windows (owner: native eng Win)

| ID | Story | Acceptance criteria | Size | Deps | Spec |
|---|---|---|---|---|---|
| WC-1 | Mic capture + device model | WASAPI input w/ device selection, hot-swap follow, gap markers on route change | M | SP-2 | §2.1.1 |
| WC-2 | System-audio loopback | Whole-device WASAPI loopback (shared mode); per-process loopback on build 20348+ targeting detected call app; automatic fallback matrix | L | SP-2 | §2.1.1 |
| WC-3 | AEC + headset detect | System-channel-referenced AEC on mic channel; bypass on headset; meets SP-3 quality bar | L | SP-3, WC-1..2 | §2.1.1 |
| WC-4 | Encrypted local buffer ⚕ | Ring buffer → encrypted local file (keystore-wrapped key); survives crash/network loss; purge on sign-out/wipe | M | WC-1 | §2.1.1, §3.3 |
| WC-5 | Call detection nudge | Sustained bidirectional call-audio detection for known apps → non-intrusive "Start capture?" nudge; never auto-records | M | WC-2 | §2.1.1 |

### E1.2 Desktop capture — macOS (owner: native eng Mac)

| ID | Story | Acceptance criteria | Size | Deps | Spec |
|---|---|---|---|---|---|
| MC-1 | Mic capture + device model | Parity with WC-1 (AVAudioEngine/Core Audio) | M | SP-1 | §2.1.1 |
| MC-2 | Process taps + SCK fallback | Core Audio taps (14.2+) primary; ScreenCaptureKit audio (13+) fallback; `NSAudioCaptureUsageDescription`; guided TCC walkthrough incl. macOS 15 "Screen & System Audio Recording" pane and re-authorization handling | L | SP-1 | §2.1.1 |
| MC-3 | AEC + headset detect | Parity with WC-3 | L | SP-3, MC-1..2 | §2.1.1 |
| MC-4 | Encrypted local buffer ⚕ | Parity with WC-4 (Keychain-wrapped) | M | MC-1 | §2.1.1 |
| MC-5 | Call detection nudge | Parity with WC-5 | M | MC-2 | §2.1.1 |

### E1.3 Ingest & streaming relay (owner: Backend)

| ID | Story | Acceptance criteria | Size | Deps | Spec |
|---|---|---|---|---|---|
| IN-1 | Chunked upload ⚕ | Resumable encrypted chunk upload → S3; integrity checks; tolerates offline; final assembly | L | PF-3, WC-4/MC-4 | §3.1 |
| IN-2 | Streaming relay ⚕ | Client WS → backend relay → AssemblyAI v3 WS (`speaker_labels: true`); vendor creds server-side only; live turns fanned back ≤ 500 ms added latency | L | PF-4, CP-1 | §2.2, §3.2 |
| IN-3 | Session lifecycle & cost guard | Sessions closed on stop/crash (billing is per session duration); orphan reaper; per-org concurrency limits; cost telemetry to OB-2 | M | IN-2 | §2.2, §8.2 |
| IN-4 | In-person capture profile | 16 kHz mono far-field profile, voice-processing input mode, AGC; room-placement coach signal (SNR hint API for UI) | M | IN-1 | §2.1.3 |

### E1.4 Transcription orchestrator (owner: Backend)

| ID | Story | Acceptance criteria | Size | Deps | Spec |
|---|---|---|---|---|---|
| TO-1 | Async job state machine ⚕ | Submit `/v2/transcript` (`speaker_labels`, `min/max_speakers_expected` from roster); webhook receipt; retries/backoff; idempotent | M | IN-1, CP-1 | §2.2 |
| TO-2 | Normalization & storage ⚕ | Utterances + per-word speaker/timing/confidence normalized to schema; immutable base + overlay model | M | TO-1 | §2.4, §3.3 |
| TO-3 | Eager vendor deletion ⚕ | `DELETE /v2/transcript/{id}` post-ingest; verified by follow-up GET; failure alarms | S | TO-1 | §2.2 |
| TO-4 | Streaming→final swap | Live transcript replaced by polished async result; UI-visible state transitions (§7.3.3 skeleton contract) | M | TO-2, IN-2 | §2.2 |
| TO-5 | Voice-memo Sync path ⚕ | ≤120 s WAV/PCM → Sync API → text in note; >120 s auto-falls back to async; audio discard setting honored | M | CP-1, PF-4 | §2.2, §3.2 |

### E1.5 Attribution v1 (owner: ML/speech eng)

| ID | Story | Acceptance criteria | Size | Deps | Spec |
|---|---|---|---|---|---|
| AT-1 | Evidence & attribution schema ⚕ | Cluster→person hypotheses with source + score persisted per line; renders in hover ("Matched by calendar · 0.84") | M | TO-2 | §2.3.1 |
| AT-2 | Mic-channel identity | Virtual-desktop mic channel auto-attributed to signed-in user; AEC-bleed guard flag | S | TO-2 | §2.3.1 |
| AT-3 | Calendar roster ingestion | Graph calendar read (delegated) for the user's meetings; attendee names/count feed candidate set + diarization hints; linkage stored on record | M | ID-1 | §2.3.1, §2.4 |
| AT-4 | Name-cue LLM pass ⚕ | Bedrock pass mines address/introduction cues → hypotheses with confidence; never auto-assigns below threshold+margin rule | M | AT-1, SUM-1 | §2.3.1 |
| AT-5 | Correction UX & scoping | "Who said this?" flow; scope this-line/all-lines-by-voice; retroactive re-render; corrections are audit events | M | AT-1, DS-4 | §2.3.1, §7.3.3 |
| AT-6 | Unknown/guest handling | Stable gray "Unknown speaker n" chips; meeting-scoped free-text naming (no directory link); post-meeting "2 speakers need names" nudge | S | AT-5 | §2.3.4 |

### E1.6 Meeting record & notes (owner: Backend + Frontend)

| ID | Story | Acceptance criteria | Size | Deps | Spec |
|---|---|---|---|---|---|
| MR-1 | Meeting record model ⚕ | Four layers (audio/transcript/notes/AI outputs) + metadata (consent artifacts, sharing state, retention clock, calendar linkage); RLS enforced | L | PF-3, ID-2 | §2.4 |
| MR-2 | Notes editor ⚕ | Low-friction rich text (lists, checkboxes); timestamp gutter linked to transcript; private-by-default with "Only you" badge; keystrokes isolated from transcript rendering thread | L | MR-1, DS-2 | §2.4, §7.3.2 |
| MR-3 | Audio playback service ⚕ | Stream-only playback via short-lived signed URLs bound to audited grants; transcript-follows-audio highlighting; no-download default | M | MR-1, IN-1 | §2.7.2, §7.3.3 |
| MR-4 | Marker/flag-moment | In-capture marker creates timestamped anchor visible in detail view | S | MR-1 | §7.3.2 |

### E1.7 Claude summarization on Bedrock (owner: Backend)

| ID | Story | Acceptance criteria | Size | Deps | Spec |
|---|---|---|---|---|---|
| SUM-1 | Bedrock client + guardrails ⚕ | `anthropic.claude-sonnet-5` via Converse; US-region routing; invocation logging off verified; minimum-necessary payload allowlist enforced in code | M | CP-2, PF-4 | §6.1, §6.5 |
| SUM-2 | Summary job ⚕ | On transcript-ready: title ≤ 60 chars, one-paragraph summary, action items with assignees **validated against attendee list**; untraceable items get "verify" marker; versioned prompt templates | L | SUM-1, TO-2 | §6.1 |
| SUM-3 | Per-user variants & regenerate | Author-notes-grounded personal summaries; organizer/no-notes default; regenerate action; post-correction re-run offer | M | SUM-2, MR-2 | §6.1 |
| SUM-4 | Failure fallback | Vendor failure → local heuristic title (calendar title + roster) + honest status copy; retry queue | S | SUM-2 | §7.5 |

### E1.8 Consent workflow v1 (owner: Backend + Frontend)

| ID | Story | Acceptance criteria | Size | Deps | Spec |
|---|---|---|---|---|---|
| CN-1 | Consent policy engine ⚕ | WA-strict org-wide (Q6): required mechanisms configured per policy; **record button disabled until preconditions met**; policy versioned | M | MR-1 | §2.6.2 |
| CN-2 | Consent sheet & attestation | Pre-capture sheet: announcement script + "I announced it" attestation; audible tone option; non-dismissable consent chip while recording | M | CN-1, DS-3 | §2.6.2, §7.3.2 |
| CN-3 | Invite disclosure | Calendar integration inserts disclosure block when capture is armed for an event; insertion recorded as artifact | M | AT-3, CN-1 | §2.6.2 |
| CN-4 | Consent artifacts ⚕ | Attestations, tone events, disclosures, acknowledgments stored immutably on the record; visible in audit view | M | CN-1, AR-2 | §2.6.2 |
| CN-5 | Objection path ⚕ | One-tap stop with "delete audio, keep my typed notes"; executes deletion pipeline for the audio layer | S | CN-1, AR-4 | §2.6.2 |

### E1.9 Sharing & permissions (owner: Backend + Frontend)

| ID | Story | Acceptance criteria | Size | Deps | Spec |
|---|---|---|---|---|---|
| SH-1 | Per-layer share model ⚕ | Grants per layer (summary/notes/transcript/audio) with view/edit where applicable; most-restricted defaults; org-internal only (no public links); optional expiry | L | MR-1, ID-2 | §2.7.2 |
| SH-2 | Share sheet UI | Four-row layered sheet with plain-language PHI hints, audience picker, who-has-access faces + one-tap revoke; state chips (`Private`/`Shared`) | M | SH-1, DS-3 | §7.3.4 |
| SH-3 | Revocation propagation ⚕ | Revoke removes visibility everywhere **including search indexes, synchronously**; notification to owner list; audit events | M | SH-1, SR-1 | §2.7.2 |
| SH-4 | Audio access gating ⚕ | Audio layer requires distinct permission + owner grant; playback-only; export behind entity-admin policy + audit reason | M | SH-1, MR-3 | §2.7.2 |

### E1.10 Search (owner: Backend)

| ID | Story | Acceptance criteria | Size | Deps | Spec |
|---|---|---|---|---|---|
| SR-1 | Indexing pipeline ⚕ | Titles/summaries/transcripts/notes indexed per layer; index entries carry ACL scope; deletion/revocation hooks (AR-4, SH-3) | L | PF-3, TO-2 | §3.3 |
| SR-2 | Query API + global search UI | ACL-filtered results grouped by meeting with matched lines in context; audit event per content hit | M | SR-1, DS-3 | §7.3.1 |
| SR-3 | In-transcript search | Match minimap; keyboard navigation | S | DS-4 | §7.3.3 |

### E1.11 Design system & app shell (owner: Frontend + Design)

| ID | Story | Acceptance criteria | Size | Deps | Spec |
|---|---|---|---|---|---|
| DS-1 | Token package | §7.2 tokens (color/semantic/speaker ramp/type/spacing/radius/elevation/motion) as platform-neutral JSON compiled to desktop targets; CI contrast audit both modes | M | PF-5 | §7.2 |
| DS-2 | App shell (Electron) + hotkey | Shared React UI shell; global hotkey + tray/menubar quick-start; auto-update plumbing (disabled until HD-3); Tauri decision checkpoint recorded | L | DS-1 | §2.7.1, §7.3.1 |
| DS-3 | Meeting list + first-run | Home per §7.3.1 (date groups, capture pill, calendar-aware rows, state badges); first-run flow: SSO → MFA → consent education → calendar connect (voice enrollment deferred) | L | DS-2, ID-1 | §7.3.1, §7.3.5 |
| DS-4 | Live capture surface | Signature choreography per §7.3.2: waveform (60 fps, dual-channel), materializing transcript lines, attribution upgrades, pinned auto-scroll + "Jump to live", consent chip, notes split view; reduced-motion parity | L | DS-2, IN-2 | §7.3.2, §7.4 |
| DS-5 | Meeting detail | §7.3.3 hierarchy (title→summary→actions→notes→transcript→audio), skeleton→staggered settle, speaker timeline scrubber, correction entry points | L | DS-2, TO-4, SUM-2 | §7.3.3 |
| DS-6 | Accessibility pass | WCAG 2.1 AA audit: keyboard, screen reader live regions (rate-limited), focus rings, hit targets, dynamic type; violations = release blockers | M | DS-3..5 | §7.6 |

### E1.12 Hardening & release (owner: all + SecOps)

| ID | Story | Acceptance criteria | Size | Deps | Spec |
|---|---|---|---|---|---|
| HD-1 | §4 control verification | Each matrix row 1–17 (Phase-1-relevant) demonstrated with evidence; gaps ticketed and closed | M | M2 scope | §4 |
| HD-2 | Penetration test & fixes | External pen test on backend + desktop clients; criticals/highs fixed; report filed | L | HD-1 | §4 |
| HD-3 | Signed installers + auto-update | Win (signed MSIX/NSIS) + macOS (notarized); staged auto-update channel | M | DS-2 | §2.7.1 |
| HD-4 | Performance budget | Front-desk-class hardware: capture start < 2 s, UI never blocks on transcription, memory ceiling agreed; regression suite in CI | M | DS-4..5 | §7.1, §8.2 |
| HD-5 | Usability pass | 5-user study with front-desk/clinical staff: first capture unaided; copy per §7.5 reading-level check; findings triaged | M | DS-3..5 | §7.1, §7.5 |

---

## Suggested team shape

1 native audio engineer per platform (Windows, macOS) · 2 backend · 1 frontend/design-system · 1 ML/speech (orchestrator + attribution) · 0.5 DevOps/SecOps · design + PM · compliance officer part-time. Phase 0 is backend/DevOps/compliance-heavy and runs while the audio spikes (SP-1…SP-3) execute, so the native engineers are productive from week 1 without waiting on M0.

## Notes for the backlog owner

- Sizes assume the team above; L stories should get a design doc reviewed before code.
- The spike outcomes (SP-1..SP-4) may resize WC-2/MC-2/WC-3/MC-3 and AT-4 — re-estimate at spike close.
- Anything ⚕ cannot merge without the PHI-DoD checklist in the PR description.
- Phase 1.5 pull-forward candidates, if M3 lands early: TO-5 already ships memos; the §6.6 PHI flag (small: MR-1 field + chip + gate checks) is the highest-value next item given the Claude.ai connector decision.
