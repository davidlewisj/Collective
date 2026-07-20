# Procurement Runbook — BAA Stories CP-1…CP-4

Step-by-step execution guide for the four Phase 0 procurement stories in [engineering-backlog-phase-0-1.md](engineering-backlog-phase-0-1.md) (Epic E0.1). Owners: Compliance + Eng lead. Vendor mechanics below were verified against vendor documentation on 2026-07-19 (see design-spec §2.9 / Appendix A); if a dashboard has moved, trust the vendor's current docs and note the drift here.

**M0 rule:** none of these are optional — the spec's foundation gate (§8.3) forbids recording PHI before CP-1…CP-3 are evidenced. CP-4 is a decision record and can close any time before the Phase 1.5 connector ships.

**Evidence convention:** every story files its artifacts (signed PDFs, written confirmations, config screenshots) in the compliance drive under `BAA/<vendor>/`, and gets a registry entry when CP-7 (BAA registry) lands. Interim: a simple index doc in the drive.

---

## 1. CP-1 — AssemblyAI BAA (tracking issue #6)

Why: AssemblyAI receives meeting audio and produces transcripts (spec §2.2). BAA is self-serve on paid accounts — no sales cycle, no premium pricing.

1. **Upgrade to paid.** Dashboard → billing → add payment method. (The BAA requires a paid account.)
2. **Sign the BAA from the dashboard.** AssemblyAI's standard BAA is signable in minutes. Signing automatically opts the account out of model training — after signing, verify the training opt-out shows active on the account.
3. **Get endpoint coverage in writing.** AssemblyAI publishes no list of BAA-covered services, and we depend on three: async (`api.assemblyai.com/v2/transcript`), Streaming v3 (`wss://streaming.assemblyai.com/v3/ws`), and Sync (`sync.assemblyai.com/transcribe`). Send support/legal this request and file the reply:
   > "We are executing your standard BAA under account [ID]. Please confirm in writing that the BAA covers PHI processed through (1) the async transcription API, (2) the v3 Streaming API, and (3) the Sync transcription API, and describe retention behavior for each. We also intend to set transcript retention to the 1-hour minimum."
   If any endpoint is *not* covered, stop and escalate — spec §2.6.5 flags this as the contingency (route that workload through the async API only until resolved).
4. **Set transcript TTL to 1 hour.** BAA accounts default to a 72-hour transcript TTL; configure the minimum (1 h). Screenshot the setting.
5. **Verify deletion mechanics.** Confirm audio deletion begins within ~24–48 h of upload, and run one live test of `DELETE /v2/transcript/{id}` from our account (the orchestrator will call this after every ingest — story TO-3).
6. **File evidence:** executed BAA, endpoint confirmation, TTL screenshot, deletion-test note.

**Done when** all six steps are evidenced. Unblocks IN-2, TO-1, TO-5.

## 2. CP-2 — AWS BAA + service allowlist (tracking issue #7)

Why: AWS holds everything at rest and serves all backend Claude calls via Bedrock (spec §3.3, §6.5 — Q5 resolution).

1. **Accept the BAA in AWS Artifact.** From the organization management account: Artifact → Agreements → accept the AWS BAA (org-level acceptance covers member accounts — record which OU/accounts are designated for PHI).
2. **Write the PHI service allowlist.** Cross-check each service the architecture uses against AWS's current HIPAA-eligible services list: S3, Aurora PostgreSQL, OpenSearch, KMS, Kinesis, Secrets Manager, **Bedrock**, CloudWatch, ECS/Fargate or Lambda, plus anything PF-1 adds. Any service not on the list may not touch PHI — no exceptions without a documented compensating decision.
3. **Enforce with an SCP.** Attach a service-control policy to the PHI OU denying all services outside the allowlist. Commit the SCP JSON to the infra repo when PF-1 lands.
4. **Lock Bedrock retention posture.** Model-invocation logging is **off by default — keep it off** for PHI accounts. Add an AWS Config rule (or SCP deny on `bedrock:PutModelInvocationLoggingConfiguration`) so it cannot be enabled silently; alert to the security channel. Optionally adopt the AWS-documented zero-data-retention SCP pattern for Bedrock.
5. **File evidence:** Artifact acceptance record, allowlist doc, SCP, Config rule.

**Done when** the BAA is accepted and the allowlist + Bedrock guard are enforced in the org (not just documented). Unblocks PF-1, SUM-1.

## 3. CP-3 — Microsoft BAA coverage confirmation (tracking issue #9)

Why: Phase 1 reads Exchange calendars for attendee rosters (AT-3); Phase 2 retrieves Teams transcripts via Graph. Microsoft incorporates its HIPAA BAA **by default** in the Product Terms / DPA for covered organizations — nothing to sign; this story verifies and evidences.

1. **Locate the governing agreement.** Identify the org's Microsoft licensing agreement (volume licensing / CSP subscription) and the DPA / Product Terms version it incorporates.
2. **Confirm scope.** Verify the HIPAA BAA provisions apply to our tenant and that the services we use — Exchange Online (calendar), Teams, Microsoft Graph — are in-scope Online Services under that agreement.
3. **Note the Phase 2 dependency.** Graph transcript retrieval (spec §2.3.2) rides these same in-scope services; record that the Teams-module rollout needs no *additional* Microsoft agreement, only the tenant toggles and metered billing described in the spec.
4. **File evidence:** agreement excerpt / DPA reference and a one-paragraph coverage memo.

**Done when** the memo and excerpts are filed. Unblocks AT-3; pre-clears the Phase 2 module.

## 4. CP-4 — Anthropic workspace decision record (tracking issue #8)

Why: backend Claude calls are on Bedrock (Q5), so the **only** Anthropic surface in the product is the v1 Claude.ai chat connector (revised Q2). Anthropic's BAA mechanism for that surface is the HIPAA-ready Claude workspace/Enterprise plan. The decision is *when* to execute it.

### Decision record (complete and commit)

- **Date:** ____ **Decider:** ____ (Compliance + Product)
- **Context:** the connector ships in Phase 1.5. Per spec §6.6, every meeting carries a facilitator-set PHI flag; without the workspace BAA the connector runs in non-PHI mode (flagged meetings excluded from results).
- **Option (a) — BAA before connector launch.** Engage Anthropic sales for the HIPAA-ready Claude Enterprise workspace now; connector serves PHI-flagged meetings from day one. Cost: Enterprise seats + procurement lead time. Choose if staff will routinely ask Claude about patient-adjacent meetings.
- **Option (b) — launch in non-PHI mode.** Ship the connector under the org's existing Claude workspace; PHI-flagged meetings are excluded until the BAA lands. **Requirement if chosen:** enable the §6.6 unanswered-prompt fail-safe (unanswered = treated as flagged) so forgetting the chip never leaks PHI-bearing content. Choose for fastest launch.
- **Recommendation (architect):** (a) if Enterprise procurement can complete before M3; otherwise (b) with the fail-safe on, upgrading to (a) as soon as the agreement executes — the switch is a registry entry, no code change.
- **Decision:** ____ **Consequences accepted:** ____
- **Revisit triggers:** BAA executed (flip registry, exit non-PHI mode); pilot shows heavy PHI flagging (accelerate (a)); Anthropic changes BAA mechanics.

**Done when** the record above is completed, signed off, and committed (amend this file or add `docs/decisions/`).

---

## Sequencing note

All four stories are independent and can run this week in parallel. CP-1 and CP-2 gate the most engineering (streaming relay, orchestrator, landing zone, summarization) — start those first. Expected wall-clock: CP-1 ~2–3 days including the written confirmation round-trip; CP-2 ~2 days of admin + IaC review; CP-3 ~1 day of licensing archaeology; CP-4 as fast as the meeting to decide it.
