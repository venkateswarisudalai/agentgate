# Runbook: Vulnerability Triage

**When to use:** a CVE, advisory, Dependabot alert, Snyk finding, or internal report has landed and you need to decide *how urgent* and *what to do*.

## 1. Capture the advisory (read-only — silent)

Pin down the inputs before judging:
- **CVE / advisory ID** (e.g., `GHSA-xxxx-yyyy-zzzz`, `CVE-2026-12345`)
- **Affected package + version range** (`lodash < 4.17.21`)
- **Vulnerability class** (RCE, prototype pollution, SSRF, ReDoS, etc.)
- **Vector** (network / local / supply-chain), **auth required**, **user interaction required**
- **Public PoC / exploit?** (search the advisory, the issue tracker, the project's release notes)

## 2. Locate the dep in the repo (read-only — silent)

- `npm ls <pkg>` / `pip show <pkg>` / `cargo tree -p <pkg>` / `go list -m all | rg <pkg>` — get the **actual resolved version**, not just the manifest pin
- `rg --files-with-matches "<pkg>" package*.json yarn.lock pnpm-lock.yaml requirements*.txt Pipfile.lock go.sum Cargo.lock` — locate every lockfile entry
- Note whether the dep is a **direct** (your code imports it) or **transitive** (something else imports it) dependency — affects fix path

## 3. Determine reachability (read-only — silent)

The CVE matters only if the vulnerable function is reachable from an attacker-controllable input:

- `rg "from ['\"]<pkg>" -t ts -t js` (or per-lang equivalent) — every import site
- For each import: which exported function is used? Does the advisory implicate **that specific function** or only some surface of the library?
- Trace data flow from the call site backward to the closest user-controlled input (HTTP body, query param, file upload, env var)
- Flag whether the path requires auth — un-authed reachable paths are much worse

If reachability is non-obvious, write a small reproducer (read-only — no commits) in `scratch/` and **say so in chat**. Don't fabricate exploitability.

## 4. Score honestly

Always state four numbers, not one CVSS:
- **Impact** — what does an attacker gain? (RCE in worker process = high; ReDoS in admin-only path = low)
- **Likelihood** — how reachable is it from an attacker position? (Un-authed, public endpoint = high; internal-only with mTLS = low)
- **Confidence** — how sure are you the bug is real in *your* code path?
- **Remediation cost** — minor version bump (low), major bump w/ breaking changes (med), code refactor (high)

Composite verdict: **Patch now / Patch in next sprint / Accept and document / Not exploitable here**.

## 5. Choose remediation (least-blast-radius first)

In order of preference:
1. **Patch version bump** — `npm install <pkg>@<fixed-version>` or equivalent. Run tests.
2. **Override / resolution** — `npm overrides`, `yarn resolutions`, `pip constraints` to pin the transitive fix without upgrading the parent.
3. **Workaround in our code** — sanitize input upstream of the bug, or stop calling the affected function.
4. **Remove the dep** — only if it's small and replaceable.
5. **Fork / vendor + patch** — last resort, has its own supply-chain cost.

## 6. Execute (gated — human approval required)

The actions that mutate state and pause for approval:
- **`npm install` / `pip install` / `cargo update`** — agentgate's pkg-scan runs first; the gate then prompts for human approval on the version delta
- **Editing the lockfile** — destructive edit to a security-sensitive file; approval required
- **`git push`** of the upgrade branch — separate approval; never `--force`
- **Opening the PR** — through `gh pr create`; the PR body must include the advisory ID + the four scores above

Narrate before each call:
> "I'm going to bump `lodash` from 4.17.20 → 4.17.21 to fix GHSA-xxxx. This advisory is reachable from the `/api/search` handler at `src/api/search.ts:42` via `_.template`. Blast radius: dev-only lockfile change, tests pass, no runtime config change. Rollback: revert the lockfile commit. Approving will install the new version."

## 7. Verify

- All tests green, including the security regression test (add one if there isn't one — assertion that the vulnerable input is now rejected)
- `npm audit` / `pip-audit` no longer flags the advisory
- For runtime-affecting fixes: smoke test the changed code path
- For RCE-class fixes that involve a deploy: watch error rates and latency for 30 minutes post-deploy

## 8. Document

- Close the Dependabot alert / Snyk issue with a link to the PR
- Add a line to the security log / changelog: advisory ID, affected version, fixed version, date, reachability assessment
- If the fix exposed a missing control (e.g., no input validation upstream), file a follow-up ticket — don't just patch the symptom

## Anti-patterns to avoid

- Patching by CVSS score alone, without checking reachability
- "Critical" findings that nobody validates and that block releases for weeks
- Bulk-patching dozens of advisories in one PR — if one regresses, you can't tell which
- Editing `package.json` without re-running the lockfile resolver
- Marking "won't fix" without writing down *why* — that note is the only thing the next auditor has
