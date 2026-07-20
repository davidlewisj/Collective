# CP-2 Enforcement Artifacts — AWS PHI Guardrails

Implements the enforcement half of backlog story **CP-2** ([issue #7](https://github.com/davidlewisj/Collective/issues/7), [runbook §2](../../docs/procurement-baa-runbook.md)). Three files:

| File | What it is | Where it applies |
|---|---|---|
| `scp-phi-service-allowlist.json` | Service control policy denying every AWS service **not** on the PHI allowlist | Attach to the **PHI OU** |
| `scp-bedrock-logging-guard.json` | SCP denying `bedrock:PutModelInvocationLoggingConfiguration`, so Bedrock invocation logging can never be enabled | Attach to the **PHI OU** |
| `bedrock-logging-guard.cfn.yaml` | CloudFormation: EventBridge rule + SNS email alert on any Bedrock logging-configuration change | Deploy in **each PHI account and the management account** (SCPs don't apply to the management account — this alert closes that gap) |

## How the allowlist SCP works — read before attaching

- SCPs never grant access; they set the ceiling. The allowlist uses the standard `Deny` + `NotAction` pattern: any service **not listed is denied**, IAM policies notwithstanding. Leave AWS's default `FullAWSAccess` policy attached alongside it.
- The list mirrors the architecture in design-spec §3 plus operational baseline services (IAM/STS, CloudFormation, SSM, Config, CloudTrail, GuardDuty/Security Hub, Backup, cost management, tagging). **New AWS services are denied by default** — that's the point; extending the list is a deliberate, reviewed act.
- Every listed service must remain on AWS's current **HIPAA-eligible services list** — recheck the list during CP-2 execution and at each annual review, and record the check in the compliance drive.
- **PF-1 owns tuning.** When the landing zone lands, this file moves under IaC management and drift-checks in CI (PF-5).

## Attachment procedure

1. Create (or identify) the **PHI OU**; move designated PHI accounts into it (per the CP-2 checklist, record which accounts these are).
2. **Test first:** attach both SCPs to a sandbox OU containing a scratch account; run a smoke test (deploy a small stack using allowlisted services; verify a non-allowlisted service call is denied; verify `aws bedrock put-model-invocation-logging-configuration` is denied).
3. Attach to the PHI OU. Keep `FullAWSAccess` attached.
4. Deploy `bedrock-logging-guard.cfn.yaml` in each PHI account **and** the management account (parameter: the security alert email). Confirm the subscription email and test by attempting the logging change from the management account — the alert should fire.
5. File evidence for issue #7: SCP attachment screenshots/ARNs, smoke-test output, CloudFormation stack IDs, alert-test email.

## Break-glass

If an emergency legitimately requires a denied action, detach the SCP from the specific account (temporarily move it out of the PHI OU), act, move it back — and record the window in the audit trail. Alternatively, add a `Condition`/`ArnNotLike` carve-out for a dedicated break-glass role to the deny statements; if you do, alert on any use of that role. Do not weaken the base policies for convenience.

## Caveats

- SCPs do **not** apply to the organization management account — never run PHI workloads there; the CloudFormation alert is the compensating control for logging-config changes made from it.
- The EventBridge rule depends on CloudTrail management events being recorded in the deployed region (default for org trails).
- Nothing here creates infrastructure permissions — IAM policies inside each account still follow least privilege (backlog PF-4, spec §4).
