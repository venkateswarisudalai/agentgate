# Runbook: Threat Model

**When to use:** "Threat-model this design / system / new feature." Before significant launches, around big architecture changes, or as a periodic refresh of a high-value system.

## 1. Pin down the system (read-only — silent)

Get four artifacts; don't proceed without them:
- **One-paragraph system description** — what does it do, who uses it
- **Data flow diagram** — components + the data crossing between them (even a hand-drawn one is fine; ask the user if there isn't one)
- **Trust boundaries** — where does data cross from one trust level to another? (internet → edge, edge → app, app → db, app → third-party API, user → admin, tenant → tenant)
- **Asset inventory** — what's worth protecting? (customer PII, payment data, source code, signing keys, ML model weights, business logic, availability)

If any of these is missing, ask before guessing.

## 2. Pick a model — STRIDE per element

For each component / data flow, walk STRIDE:

| Threat | Question |
|---|---|
| **S**poofing | Can an entity claim to be a different identity? (forged JWT, fake service identity, replay) |
| **T**ampering | Can data in transit / at rest be modified? (MITM, integrity, replay with tampering) |
| **R**epudiation | Can a user deny an action they performed? (missing audit log, mutable log, shared identity) |
| **I**nfo disclosure | Can data leak to an unauthorized observer? (logs, error messages, side channels, IDOR, over-fetching) |
| **D**enial of service | Can an attacker make this unavailable? (resource exhaustion, lock contention, amplification, ReDoS) |
| **E**oP | Can a user gain higher privileges than intended? (admin endpoint without check, deserialization RCE, container escape) |

For each (component, STRIDE letter) cell that's plausible, write one threat. Be specific:

> **T-1 [Tampering, edge → app]** — webhook receiver does not verify HMAC; an attacker who learns the URL can post crafted events that the app trusts.

## 3. Rank

For each threat:
- **Impact** — what does an attacker gain / what does the org lose?
- **Likelihood** — how reachable is it? (un-authed-public > authed-customer > authed-employee > physical)
- **Confidence** — how well do you understand the system? (low confidence threats deserve a read-only investigation, not a decision)

Combine into a single severity (Critical / High / Medium / Low). Rank the list.

## 4. Recommend controls

For each High+ threat, propose 1–2 controls. Prefer controls in this order:

1. **Eliminate** — remove the surface (don't accept this input at all; don't expose this endpoint; don't store this field)
2. **Reduce** — narrow it (auth, allow-list, rate limit, scope, smaller IAM, mTLS)
3. **Mitigate** — make exploitation expensive or noisy (WAF, anomaly detection, alerting)
4. **Transfer** — push to a provider that has primary responsibility (managed KMS, managed auth)
5. **Accept** — document, with a written decision-maker and a re-review date

Each control gets:
- **Implementation cost** (engineering effort + ongoing cost)
- **Coverage** (does it address the whole class or just one variant?)
- **Side effects** (latency, complexity, false positives)

## 5. Identify what you didn't model

State the limits of the threat model honestly:
- "I didn't model the build pipeline." / "I didn't model insider threat from the on-call engineer." / "I didn't model the third-party SDK in detail."
- These aren't failures — they're scope. Make them explicit so the next reviewer knows what to pick up.

## 6. Produce the artifact

A single document:
- System description
- Diagram (text-based is fine — ASCII or mermaid)
- Trust boundaries
- Asset list
- Threat table — sorted by severity
- Control recommendations — sorted by severity
- Out-of-scope notes
- Re-review trigger (date or event)

Save it under `docs/security/threat-model-<system>.md` or wherever your team puts these.

## 7. Drive the work

For each High+ threat without an existing control:
- File a ticket linking back to the threat model
- Tag the owning team
- Set a target date matching the severity

The threat model isn't done when the doc is written. It's done when the controls are in place or accepted.

## Anti-patterns to avoid

- 50-threat tables where every threat is "Medium" — distinguish or merge
- Controls without owners or dates — they don't happen
- Threat-modeling the implementation when you should be threat-modeling the design (and vice versa)
- Letting the developer team threat-model their own system without an outside voice
- Treating the threat model as a one-time artifact instead of a re-reviewable document
