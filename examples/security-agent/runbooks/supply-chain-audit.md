# Runbook: Supply-Chain Audit

**When to use:** "Should I install this package?" / "Audit our dependencies." / "Why did `npm install` just want to run a postinstall script?" Covers pre-install checks and periodic dep hygiene.

## 1. Inputs (read-only — silent)

For a single package:
- Package name, version range, ecosystem (npm / pip / cargo / go / gem / maven)
- Whether you're adding it (`npm install <pkg>`) or it's already in the lockfile
- Whether it's a direct dep or transitive

For a whole project:
- All lockfiles in the repo (`rg --files | rg 'lock|requirements|Pipfile|Cargo|go.sum|Gemfile|gradle'`)
- Recent dep adds in `git log -p package*.json` (last 30 days)

## 2. Use pkg-scan first

agentgate ships `@agentgate/pkg-scan` — a pre-install supply-chain scanner. Always run it before any install command:

```bash
agentgate pkg-scan <pkg>@<version>
```

It flags: typosquats, brand-new packages, packages with sudden version jumps, packages with install scripts that touch network or filesystem, suspicious maintainer changes, suspicious tarball contents.

If pkg-scan flags something, **do not install** until the user has reviewed the flag and explicitly approved.

## 3. Per-package risk checklist (read-only — silent)

For each candidate dep:

**Identity**
- Spelled like a popular package? (`reqeusts`, `loadsh`, `expreess`)
- Brand-new (< 30 days)? Disproportionately popular for its age?
- Maintainer changed recently? Was the package handed off?
- Provenance — does the registry show a signed publish (`npm sigstore`, `pip provenance`)? Match the GitHub repo it claims?

**Code**
- Postinstall scripts? What do they do? (Network calls, filesystem writes, env reads — all are red flags)
- Tarball content matches the repo's published source? (sometimes the tarball has extra files)
- Any obfuscated / minified files that aren't expected to be?
- Reads env vars / reads from `~/.aws`, `~/.ssh`, etc.?

**Maintenance**
- Last commit / last release age
- Issues to PRs ratio — abandoned?
- Number of maintainers — single-maintainer packages are higher risk for both abandonment and account-takeover
- Security advisory history — does the maintainer respond to disclosures?

**Need**
- What does this package actually do for us? Could we write the function ourselves in N lines? (For trivial utilities, vendor or write — fewer trust roots is fewer risks.)
- Is there a more popular / better-maintained alternative?

## 4. Install (gated — human approval required)

If the package passes:
- `npm install <pkg>@<exact-version>` (or equivalent) — narrate first
- The gate triggers because installs are destructive; the approval pauses for human
- **Pin to an exact version** (no `^` / `~`) — review every bump consciously
- Commit the lockfile

Narrate:
> "Installing `lodash@4.17.21` as a direct dep. Need: `_.template` for the admin email renderer. pkg-scan: clean (well-known package, current version, no install scripts, signed publish). Alternatives considered: handlebars (heavier), native template literals (insufficient — we need partial rendering). Blast radius: lockfile + node_modules; runtime adds ~75KB. Rollback: `npm uninstall lodash`."

## 5. Whole-project audit (read-only — silent)

Run periodically (quarterly or per release):

- **`npm audit` / `pip-audit` / `cargo audit` / `gosec` / `bundler-audit`** — known-CVE pass over the lockfile
- **License audit** — `license-checker`, `pip-licenses` — flag any GPL / AGPL / unknown in a proprietary product
- **Unused deps** — `depcheck`, `pip-extra-reqs`, `cargo udeps` — anything you import that you don't use is risk surface
- **Direct-but-unpinned deps** — anything still on `^` / `~` in `package.json` while the lockfile is correct → bump and pin
- **Outdated deps** — `npm outdated`, `pip list --outdated`. Anything more than 2 major versions behind is decision-point work

Produce a report: `docs/security/dep-audit-<date>.md`. Per-finding: severity, recommendation, owner.

## 6. Lockfile hygiene

Enforce these in CI:
- Lockfile present and committed
- Lockfile resolved against the public registry (`registry-url` set explicitly)
- No `file:` / `git+` dependencies in `package.json` unless explicitly approved (these bypass the registry)
- Integrity hashes in the lockfile match the registry (catches lockfile tampering)

## 7. Document

- For each rejected or replaced package: one-line entry in `docs/security/dep-decisions.md` with the date and reason
- For the periodic audit: link the report from the release postmortem / quarterly security review
- For the install of any non-trivial dep: a one-line note in the PR description ("Adding `<pkg>` for <reason>; pkg-scan clean.")

## Anti-patterns to avoid

- `npm install` without checking the diff to the lockfile
- Skipping pkg-scan because "I trust this package" — trust is what attackers exploit
- Letting `^`/`~` ranges into the lockfile after install (it can happen with manual `package.json` edits)
- Adding a 200KB dep to use 10 lines of utility code
- Auto-merging Dependabot PRs without per-PR review
- Treating "many downloads" as a security signal — popular packages have been compromised
