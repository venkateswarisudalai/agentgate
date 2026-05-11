# Runbook: IaC Security Review

**When to use:** "Review this terraform / Kubernetes manifest / Helm chart / CloudFormation for security issues." Pre-merge or as part of a periodic infra audit.

## 1. Scope (read-only — silent)

- What artifact are you reviewing? (one .tf file, a module, a whole stack, a k8s manifest, a Helm chart)
- What environment? (dev / staging / prod — prod findings are tighter)
- Run the appropriate plan first to see effective state:
  - `terraform plan -out=tfplan && terraform show -json tfplan` — get the actual resource graph
  - `helm template ...` — render to k8s manifests
  - `kustomize build ...` — same

Don't review the templates in isolation — review the rendered output.

## 2. Use iac-scan for blast-radius (read-only — silent)

agentgate ships `@agentgate/iac-scan` — scores the proposed change by blast radius:

```bash
agentgate iac-scan tfplan.json
agentgate iac-scan manifest.yaml
```

It flags: prod-only changes, deletes, IAM widening, public exposure, encryption changes, identity changes. Use it as a prioritization signal — high blast-radius changes need more scrutiny.

## 3. Cloud / Terraform checklist

**IAM**
- Wildcard actions (`"Action": "*"`) — almost never correct outside admin roles
- Wildcard resources (`"Resource": "*"`) — only with corresponding action narrowing
- `AssumeRole` trust policies open to `*` or to a whole org without an `aws:SourceAccount` / `aws:SourceArn` condition
- Inline policies that grant `iam:Pass*`, `iam:Create*`, `sts:AssumeRole` — privilege escalation risk
- Roles with no permissions boundary
- Long-lived access keys in `*.tfvars` (move to OIDC federation / IRSA / Workload Identity)

**Storage**
- S3 buckets without `BlockPublicAcls`, `IgnorePublicAcls`, `BlockPublicPolicy`, `RestrictPublicBuckets`
- S3 without default encryption (`AES256` or `aws:kms`); without bucket versioning; without lifecycle for old versions
- GCS without uniform bucket-level access
- Azure storage without `min_tls_version = "TLS1_2"`, public network access enabled
- Database storage without encryption at rest

**Network**
- Security groups with `0.0.0.0/0` on ports other than 80/443 (and even those need justification on internal services)
- Same for NSGs / firewall rules in GCP / Azure
- Database `publicly_accessible = true` — almost always wrong
- VPC endpoints missing for AWS services that should not egress the internet (S3, KMS, Secrets Manager)
- Missing flow logs on prod VPCs

**Compute**
- EC2 / VMs with public IPs that don't need them
- IMDSv1 enabled (should be IMDSv2-only — `http_tokens = "required"`)
- Container images by tag (`:latest`) instead of digest in prod
- Missing default tags / labels for cost + ownership tracking

**Secrets**
- Secrets in plain text in any `.tf`, `.tfvars`, `.yaml`, `.json` (use Secrets Manager / Parameter Store / Vault and reference)
- `sensitive = true` missing on variables that hold credentials
- State file location (`backend "s3"`) — bucket encrypted? versioned? access-restricted? state-file lock present (DynamoDB / GCS object lock)?

**Logging / detection**
- CloudTrail / Audit Logs enabled in all regions
- GuardDuty / Security Command Center enabled
- KMS key rotation enabled
- CloudWatch / Stackdriver alerts on root login, IAM policy changes, MFA disable

## 4. Kubernetes / Helm checklist

**Pod security**
- `runAsNonRoot: true`, `runAsUser` set to non-zero
- `readOnlyRootFilesystem: true` where possible
- `allowPrivilegeEscalation: false`
- `capabilities.drop: ["ALL"]`, only re-add what's needed
- No `hostNetwork`, `hostPID`, `hostIPC`, `privileged: true` unless justified
- `automountServiceAccountToken: false` unless the pod actually needs the API

**Resources**
- CPU / memory `requests` AND `limits` set — missing limits → noisy-neighbor and DoS surface
- Liveness / readiness probes — missing probes mean failed pods stay in the load-balancer

**RBAC**
- ServiceAccount-bound roles instead of cluster-wide
- No `cluster-admin` bindings to non-admin SAs
- Wildcard `verbs: ["*"]` or `resources: ["*"]` — escalation risk
- `escalate`, `bind`, `impersonate` verbs — almost always wrong outside admin tools

**Network**
- NetworkPolicies present per namespace — deny by default, allow specific egress
- `Service: LoadBalancer` with no `loadBalancerSourceRanges` — public exposure
- `Ingress` without TLS

**Secrets**
- `Secret` objects via Sealed Secrets / external-secrets, not committed plaintext
- No `envFrom: secretRef` of a secret containing more keys than the pod needs

**Image / supply chain**
- Image pinned by digest (`@sha256:...`) in prod, not by tag
- Image from a trusted registry (allow-list)
- Image signed (cosign) and policy-enforced (kyverno / OPA Gatekeeper)
- `imagePullPolicy: Always` in prod is fine; in dev `IfNotPresent` is fine; `Never` is suspicious

**Admission**
- An admission controller (kyverno / OPA Gatekeeper / Pod Security Admission) is enforcing these in cluster, not just in review

## 5. Per-finding output

Same shape as `secure-code-review.md`:
- Title — attacker-facing one-liner ("S3 bucket `customer-exports` is publicly readable")
- Evidence — file:line, resource name, the literal config
- Impact — what does an attacker (or a mistake) cost?
- Likelihood — internet-reachable / requires-prior-foothold / requires-insider
- Confidence
- Remediation — concrete config snippet that fixes it

Composite severity. Don't inflate.

## 6. Propose fixes (with the user)

Order by severity. For each:
- Show the **specific config change** (a diff block)
- Show the **plan output before and after** for terraform / kustomize — proves the change does what you say
- Note whether the fix triggers a real-world side effect (replacing a bucket, recreating a DB, IAM role disruption)

## 7. Execute (gated — human approval required for every apply)

- `terraform apply` is destructive; the gate prompts for human approval; rule pack auto-asks
- `kubectl apply` is destructive; same
- Helm upgrades likewise
- **One change at a time** in prod. Multi-change applies make rollback ambiguous.
- For high-blast-radius changes, do a stage rollout first if possible (apply to dev → staging → prod)

Narrate:
> "Going to apply terraform change to set `block_public_acls = true` on `aws_s3_bucket.customer_exports`. Plan shows: 1 in-place update, no replacement, no other resources affected. Blast radius: any process that currently writes via public ACLs will start failing — we've grepped the org and found zero such callers. Rollback: revert this PR and `terraform apply` (~30s)."

## 8. Verify

- `terraform plan` is empty after apply (confirms convergence)
- `kubectl get <resource>` confirms the post-state
- Cloud-native checks: re-run `aws iam simulate-principal-policy`, `aws s3api get-public-access-block`, `kubectl auth can-i` to prove the new posture

## 9. Document

- For each finding fixed: link the PR in the IaC review doc
- For each finding accepted as risk: who decided, why, re-review date
- Systemic findings → propose a policy check (kyverno / OPA / Sentinel) that prevents the class going forward

## Anti-patterns to avoid

- Reviewing `.tf` files without running `terraform plan` — what's in the file isn't what's deployed
- Approving `apply` on a plan you didn't read
- Treating `0.0.0.0/0` as "allow all the things, we'll narrow later" — narrow before merge
- Inline secrets in `.tfvars` "just for now"
- Helm chart reviews that read the templates but not the rendered output
- Adding `runAsNonRoot: true` without checking the container image supports it (build will be fine; runtime will crashloop)
