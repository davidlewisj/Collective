# Collective — Project Context

HIPAA-compliant meeting transcription and notes app for a healthcare organization (single entity, Washington State, all staff shared). No meeting bot — capture happens on the user's device. This file is the durable context for anyone (human or AI) continuing the work.

## Read these first, in order

1. `STATUS.md` — what is implemented & tested vs. needs vendors/hardware vs. human-only. **The honest ground truth.**
2. `docs/design-spec.md` — the complete design authority. All 7 open questions are RESOLVED (see §0/§8.1); do not re-litigate them.
3. `docs/engineering-backlog-phase-0-1.md` — story-level backlog; CP/ID stories are tracked as GitHub issues #6–#9, #11–#15.
4. `docs/api.md` — the HTTP + MCP contract the server and web client implement.

## Resolved decisions (do not undo without the owner's say-so)

- **Q1** single entity, all staff shared (multi-entity machinery stays dormant in schema)
- **Q2 (revised)** archive Q&A ships via **Claude.ai custom connector → our MCP server**; in-app assistant is v2
- **Q3** records are purely internal operational notes — no EHR export, no designated-record-set handling
- **Q4** BYOD allowed **with device registration** (attestation-backed, wipe on deregistration)
- **Q5** all backend Claude calls via **Amazon Bedrock** under the AWS BAA (`anthropic.claude-sonnet-5`); direct Anthropic API is the wired contingency
- **Q6** consent posture is **WA-strict everywhere** (all-party; attestation gates capture)
- **Q7** Teams module metered-Graph budget chosen in the admin setup wizard
- **§6.6 PHI flag**: facilitator-set per-meeting "Contains patient info?"; when a required BAA is missing, flagged meetings are excluded from Claude egress (summaries skipped, invisible to MCP); unanswered + fail-safe = treated as flagged

## Non-negotiable engineering invariants

- Every content read goes through the RBAC PDP (`apps/server/src/rbac.ts`) — deny by default; **audio is a distinct permission**; org_admin gets NO implicit content access; notes are readable only by their author, ever.
- Every content access emits a hash-chained audit event (`audit.ts`). New endpoints must emit or they don't merge.
- Capture cannot start before the consent policy is satisfied (`policy.ts`).
- Vendor egress is gated on the BAA registry (`policy.ts` → `insightEgressAllowed`/`mcpEgressAllowed`). Mock adapters are the default; real adapters activate via env **only after the corresponding BAA is executed** (runbook: `docs/procurement-baa-runbook.md`).
- UI styling uses design tokens only (`packages/tokens`); the CI contrast audit and the no-hex grep are release gates. Honor `prefers-reduced-motion`.
- Stories marked ⚕ in the backlog carry the PHI definition-of-done (audit asserted in tests, encryption verified, no PHI in logs, deny-path tests).

## Commands

```bash
npm install
npm run build --workspace packages/tokens   # tokens → CSS (required before web)
npm run dev:server                          # :4000 — API + MCP; mock adapters by default
npm run dev:web                             # :5173 — sign in as dana@collective.dev
npm test  --workspace apps/server           # 19 compliance-core tests
npm run typecheck --workspaces --if-present
```

Dev users: `dana@` (org_admin) · `omar@` / `priya@` (members) · `casey@` (compliance_auditor), all `@collective.dev`.

## Where the seams are (for the next phase of work)

- **Persistence**: `apps/server/src/persist.ts` — durable local stores (JSON snapshot, disk audio, append-only audit journal) under `COLLECTIVE_DATA_DIR`; the seam's production target is Aurora Postgres + RLS, S3, WORM audit (PF-3).
- **Auth**: Entra ID sign-in implemented (`msgraph.ts`, confidential-client flow; dev-login retained for tests/dev); remaining: JWKS signature verification, SCIM, device registry (issues #14–#15).
- **Live captions**: mock SSE in `pipeline.ts` → AssemblyAI v3 WebSocket relay (IN-2).
- **Desktop capture**: `apps/desktop` has loopback plumbing; per-process WASAPI + macOS Core Audio taps need native modules on real hardware (`docs/desktop-capture.md`).
- **MCP**: works over Streamable HTTP with bearer auth; the OAuth 2.1 AS/resource-server front (RFC 9728/8414 discovery, PKCE, RFC 8707 audience binding, allowlisted admin-minted clients, `oauth.ts`) is built + tested — claude.ai end-to-end just needs a public HTTPS deploy (`COLLECTIVE_PUBLIC_URL`) since Claude connects from Anthropic's cloud (spec §6.4).
- **infra/policies/**: AWS SCPs + Bedrock logging guard, ready to attach per the README there.

## Process conventions

- Branch: `claude/healthcare-transcription-hipaa-2j1cbr`; PRs to `main`; CI must be green.
- Spec changes: edit `docs/design-spec.md` and record decision + date in §8.1's table (it is the decision record).
- BAA state changes: update the runtime registry via `/admin/baa-registry` AND file evidence per the runbook.
