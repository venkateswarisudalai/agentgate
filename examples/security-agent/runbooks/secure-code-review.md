# Runbook: Secure Code Review

**When to use:** "Review this file / PR / module for security issues." Pre-merge, pre-release, or as part of a periodic audit.

## 1. Establish scope (read-only — silent)

- What are you reviewing? (specific file paths, a PR number, a branch diff, a whole service)
- What's the data classification of the inputs it handles? (public, authed user, admin, PII, payment, credentials)
- What's the trust boundary? (where does attacker-controlled data enter?)
- What's the deployment context? (public-internet edge, internal-only, batch job, build-time)

If the user gave you a PR, run `git diff <base>...<head>` first and review only the diff. If they gave you a module, list the files and let them confirm the scope before you read everything.

## 2. Walk the attack surface (read-only — silent)

For each entry point (HTTP handler, queue consumer, CLI flag, file parser, IPC, RPC):
- **Identify the input** — query params, body, headers, cookies, filename, environment, env-var-backed config
- **Trace the data flow** — where does it land? what calls touch it? where does it leave the process?
- **Identify the sinks** — db query, shell, file write, network call, template render, deserializer, regex, auth decision

## 3. Check the catalog (per-finding evidence required)

For each input → sink path, check the relevant class:

**Injection**
- SQL / NoSQL — parameterized queries? ORM in raw-string mode? string concatenation into a query?
- Command — `exec`, `spawn`, `system`, backticks with user-controlled args? `shell=True`?
- Template — Jinja `Template(...).render(user_input)`? `eval()`? `new Function()`?
- LDAP / XPath / HTML / CSS — similar pattern; user input concatenated into a query language

**AuthN / AuthZ**
- Every endpoint that touches non-public data: is it authed? is the auth check **before** the side effect?
- IDOR — does the handler check that the resource belongs to the caller, or just that the caller is *some* user?
- Privilege checks — is `isAdmin` resolved from the JWT / session, or from a request body field the client can set?
- Session lifecycle — rotation on privilege change? invalidation on logout? proper cookie attributes (`HttpOnly`, `Secure`, `SameSite`)?

**SSRF / open redirect**
- Any call that takes a URL from user input and fetches it server-side
- Any `Location:` / 302 with a user-supplied target
- AWS / GCP metadata service exposure (`169.254.169.254`)

**Path traversal / file upload**
- `path.join(userControlledFilename, ...)` without `path.basename` or an allow-list
- Upload handlers that trust `Content-Type` over content sniffing
- Archive extraction without zip-slip protection

**Crypto**
- Hardcoded keys, IVs, salts in source
- `Math.random()` / `rand()` for tokens (should be CSPRNG)
- ECB mode, MD5/SHA1 for password hashing, no key rotation
- JWT alg confusion (`alg: none`, RS256↔HS256), missing `aud` / `iss` checks

**Serialization**
- `pickle.loads`, `yaml.load` (non-safe), `Marshal.load`, native `Java` ObjectInputStream on user data
- Prototype pollution in JS — merge / clone over `__proto__` / `constructor.prototype`

**XXE / DTD**
- XML parsers with external entity loading enabled (varies by lib — flag the lib + version)

**Race conditions**
- TOCTOU patterns — check-then-act on filesystem, database, cache without a transaction or lock
- Idempotency missing on money-moving / state-changing endpoints

**ReDoS**
- Catastrophic-backtracking regex (`(a+)+$`, nested quantifiers) over untrusted strings

**Logging / observability**
- Logging the raw request body or cookie header (leaks secrets / tokens)
- Logging passwords, full credit cards, full session tokens

## 4. Score each finding honestly

For each finding, emit:
- **Title** (one line, attacker-facing: "Unauthenticated IDOR on `/api/orders/:id`")
- **Evidence** — file:line, the literal vulnerable code, the offending data flow
- **Impact** — what does an attacker get?
- **Likelihood** — how reachable is this in production?
- **Confidence** — how sure are you?
- **Remediation** — concrete code change; ideally as a snippet

Composite severity: Critical / High / Medium / Low / Informational. Don't inflate — High everywhere = High nowhere.

## 5. Propose fixes (with the user)

Order findings by severity descending. For each:
- Show the **specific code change** (a diff block)
- Note whether the fix needs a **test** (almost always yes — assert the malicious input is rejected)
- Note whether the fix changes API contract (and if so, who needs to know)

## 6. Execute (gated — human approval required for each PR-worthy change)

- Edits to security-sensitive files (auth middleware, IAM helpers, crypto utils, query builders) trigger the gate; narrate before each call
- Opening the remediation PR is itself a gated action — the PR body must include the finding, the evidence, the chosen fix, and the test added
- Never push directly to `main`. Always feature branch + PR.

## 7. Verify

- New tests pass and fail correctly (delete the fix, watch the test fail; restore, watch it pass)
- Linter / SAST clean on the changed files
- For high-severity classes (authn/authz, RCE), spot-check the deployed version after merge — not just the merged PR

## 8. Document

- Findings file (`SECURITY_REVIEW_<date>.md`) under `docs/` or wherever your team puts them — for repeat reviewers
- Link to the PR(s) that resolved each
- Flag systemic findings as a follow-up issue ("we have N places that do raw SQL concat — let's add a lint rule")

## Anti-patterns to avoid

- "Looks fine" reviews with no negative findings on a 500-line PR
- Finding without evidence — every High needs a payload or data flow
- Telling the user "use a security library" without naming the library and the API
- Mixing findings of different severities in one PR — patch Critical first, on its own
- Reviewing your own diff in isolation — pull in the surrounding context (the caller, the handler chain, the auth middleware) before you judge
