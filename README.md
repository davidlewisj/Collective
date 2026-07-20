# Collective

HIPAA-compliant meeting transcription and note-taking for healthcare teams — Otter/Granola-class capture and notes, rebuilt around PHI-safe defaults, with **no meeting bot**.

## Run it

```bash
npm install
npm run build --workspace packages/tokens   # design tokens → CSS
npm run dev:server                          # API + MCP on :4000 (mock adapters, no data leaves the machine)
npm run dev:web                             # web app on :5173
```

Sign in as `dana@collective.dev` (org admin), `omar@` / `priya@` (members), or `casey@` (compliance auditor). With no environment configuration the server runs on deterministic mock adapters; real vendors switch on via `apps/server/.env.example` — **only after the corresponding BAA is executed** (issues #6–#9).

Desktop shell (optional, needs the Electron binary): see `apps/desktop/README.md`.

## What's here

| Path | Contents |
|---|---|
| `docs/design-spec.md` | The complete product design specification (architecture, HIPAA matrix, speaker-ID design, Claude/MCP integration, UI system) — all decisions resolved |
| `docs/engineering-backlog-phase-0-1.md` | Story-level Phase 0/1 backlog with milestones and spikes |
| `docs/procurement-baa-runbook.md` | Step-by-step BAA execution guide (CP-1…CP-4) |
| `docs/api.md` | HTTP + MCP API contract |
| `docs/desktop-capture.md` | Desktop audio-capture engineering note (WASAPI / Core Audio taps roadmap) |
| `STATUS.md` | **Honest implementation status** — what's tested, what needs vendors/hardware, what's human-only |
| `packages/tokens` | Design tokens + WCAG AA contrast audit (CI-enforced) |
| `packages/shared` | Shared domain types |
| `apps/server` | API, compliance core (RBAC · audit chain · consent · PHI-flag gating · retention), transcription/insight adapters, MCP server — 19 tests |
| `apps/web` | Web client (meeting list, consent-gated live capture, meeting detail, sharing, admin) |
| `apps/desktop` | Electron shell with system-audio loopback plumbing |
| `infra/policies` | AWS SCPs + Bedrock logging guard (CP-2 enforcement artifacts) |

## Compliance posture

Security and privacy controls are structural: deny-by-default RBAC with audio as a distinct permission, hash-chained audit of every content access, WA-strict consent gating before capture, per-meeting PHI flag with BAA-aware egress gating (§6.6), per-entity retention clocks with deletion cascade, and notes that are private to their author, always. See `docs/design-spec.md` §4 for the full HIPAA compliance matrix and `STATUS.md` for exactly which controls are live in this repo versus pending infrastructure.
