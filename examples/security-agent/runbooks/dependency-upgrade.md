# Runbook: Dependency Upgrade

**When to use:** you've decided (via `vuln-triage.md` or `supply-chain-audit.md`) to upgrade a dependency, and now you need to do it safely. Especially for major-version bumps or for deps deep in the application.

## 1. Map the upgrade (read-only — silent)

- **Current version → target version** — exact, from the lockfile
- **Release notes between them** — read every `BREAKING` line; skim `feat` / `fix`
- **Direct callers in our code** — `rg "from ['\"]<pkg>"` (or per-lang); know every import site
- **Transitive consumers** — `npm ls <pkg>` / `pip show <pkg>` — anything else relying on this version?
- **Peer-dep constraints** — does this bump force other deps to also bump?

If it's a major bump, expect breaking changes. If the notes are vague, expect surprises in tests.

## 2. Identify the risk areas

For each direct call site:
- Does the upgrade rename / remove the function we use?
- Does it change defaults? (e.g., a parser that previously accepted lenient input becomes strict)
- Does it change types / shapes of return values?
- Does it add new deprecation warnings we'll log in prod?

Score each call site: green / yellow / red. Yellow and red need a test before the bump.

## 3. Branch and bump (gated — human approval required)

- New feature branch: `chore/upgrade-<pkg>-<oldver>-to-<newver>`
- `npm install <pkg>@<newver>` — gate triggers, narrate before approving
- Commit lockfile changes separately from any code changes — keep blame readable

## 4. Adapt the code (gated for security-sensitive paths)

For each red / yellow call site:
- Update the call to the new API
- If the old behavior matters for security (input sanitization, escaping defaults, parser strictness), **add a test that asserts the new behavior is correct** before changing the code

For each green call site:
- Leave alone, let CI prove it

## 5. Run the full test suite

- Unit tests
- Integration tests
- E2E if you have them
- Security regression tests — the one(s) you added for this advisory (per `vuln-triage.md`)
- For runtime-sensitive deps (parsers, crypto, http clients, db drivers): add a smoke script that exercises the real API surface, not just mocks

## 6. Check for behavior changes (read-only — silent)

Before merging, look for:
- New warnings / deprecation logs in test output
- Performance changes (the new version may be slower; benchmark if perf-sensitive)
- New CVEs against the **new** version (rare, but it happens — re-run `npm audit`)

## 7. Stage the rollout (with the user)

For high-blast-radius deps (crypto libs, db drivers, http servers, ORM):
- Deploy to dev → bake for a day
- Deploy to staging → bake for a day
- Deploy to prod canary → 5% → 50% → 100% with metric watches in between

For low-risk deps:
- Standard CI → merge → deploy

Either way, deploy via your service's normal deploy flow (e.g. `examples/devops-agent/runbooks/deploy.md`) — agentgate gates the apply.

## 8. Watch post-deploy

- Error rates and latency for 30 minutes minimum
- Any new error signatures matching the dep name?
- Memory / CPU baseline shifts?

If anything regresses, follow the deploy/rollback playbook for your service (e.g. `examples/devops-agent/runbooks/rollback.md` if you use that persona too) — the lockfile revert is a clean rollback for most deps.

## 9. Document

- PR body: advisory ID (if any), old version, new version, breaking changes addressed, tests added
- Update `docs/security/dep-decisions.md` with the date + reason

## Anti-patterns to avoid

- Bumping multiple deps in one PR
- Bumping a major version "while you're in there" alongside an unrelated change
- Skipping the test add — the test is the only thing that catches a silent behavior regression next time
- Auto-merging the bump from a bot without reading the changelog
- Bumping and deploying directly to prod without staging — even small deps can break in surprising ways
