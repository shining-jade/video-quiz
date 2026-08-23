# R23 Evidence Broad-Review Fixes Design

## Scope and safety boundary

This fix wave closes four production blockers without making any live request: the broken default commit readback, ambiguous R1 release PATCH outcomes, unverified deny-all Ruleset source identity, and missing authoritative Email/Password-provider-OFF evidence. All network behavior remains dependency-injected in tests. Production code may perform only the documented read-only provider/Rules GETs and the fixed Rules release PATCH/rollback operations during a separately authorized window.

No implementation path may create a Ruleset, mutate Firestore data or Auth configuration, enable a provider, deploy, merge, or push.

## Branch commit binding

GitHub Pages deploys the pushed branch, so the reviewed deploy identity is the whole HEAD commit rather than a hosted-file allowlist. `readCurrentCommit()` will read `git rev-parse HEAD` once and return that exact 40-character lowercase commit as both `sourceCommit` and `staticCommit`. The existing whole-repository staged/unstaged tracked cleanliness gate remains mandatory.

A regression test will call the real `productionDependencies().readCurrentCommit()` from the actual worktree. It will independently read HEAD and require both returned identities to equal it, catching undefined symbols or a return to partial-path commit calculation.

## R1 deny source and baseline preflight

Before the R1 release PATCH, the tool performs these steps after the authoritative Functions/Scheduler inventory:

1. GET the fixed deny-all Ruleset `projects/video-quiz-65798/rulesets/9a4258c3-12ed-4ee6-82aa-f596645a4466`.
2. Require the exact resource name, exactly one source file, readable string content, and SHA-256 `cd5089e4e5116dbb994013dc5fd5e7e411ec348935b8d06d13acd00173cca15b`. This is the pinned hash of the canonical 164-byte LF deny-all source.
3. GET the exact `cloud.firestore` release and require an exact name, project-local Ruleset name, and valid full-precision `updateTime`.
4. GET that exact pre-PATCH immutable Ruleset, require a single readable source file, and record its source SHA-256. This snapshot is the only permitted rollback target.

Any missing, malformed, wrong-name, wrong-hash, permission-denied, timeout, or transport result stops before PATCH.

The successful R1 report and manifest quiescence gate bind the pinned deny source SHA and exact source readback. The report also records the pre-PATCH release identity and immutable prior Ruleset source hash.

## R1 PATCH reconciliation state machine

The tool attempts the fixed deny-all PATCH exactly once, then performs an authoritative release GET even when the PATCH returns non-2xx or loses its transport response.

The outcome classifications are:

- `response-success`: PATCH returned 2xx and GET reads the exact deny Ruleset with a valid update time.
- `landed-reconciled`: PATCH returned non-2xx or lost its response, but GET reads the exact deny Ruleset. The deny barrier is authoritative despite the missing/failed PATCH response, so anonymous HTTP 403 verification may continue.
- `definitely-not-landed`: PATCH returned a settled non-2xx response and GET reads the exact pre-PATCH Ruleset with the exact pre-PATCH update time. No rollback PATCH is needed.
- `mismatch-rolled-back`: PATCH had a settled response, but GET reads a known state other than the exact deny target or exact unchanged baseline. The tool PATCHes only the captured pre-PATCH Ruleset and requires exact GET readback.
- `mismatch-rollback-failed`: the known-mismatch rollback PATCH/readback does not prove the captured prior Ruleset active.
- `mutation-outcome-unknown`: the PATCH transport was lost and reconciliation does not read the exact deny target, or reconciliation itself is unavailable/malformed. The tool performs no speculative rollback and makes no final-state claim.

A 2xx PATCH followed by a readable non-target release is a known mismatch and uses the same exact rollback path. A transport-lost PATCH is considered reconciled only when GET reads the exact deny target; any other result remains unknown to avoid racing a request that may still land.

Rollback performs one PATCH to the captured pre-PATCH Ruleset and one exact release GET. A lost rollback response is reconciled by the GET: exact prior readback proves rollback state, while any other/unreadable result remains a failed or unknown rollback. Reports preserve truthful provider-inventory, source-readback, PATCH response, reconciliation, rollback, final Ruleset, update-time, and `mutationOutcomeUnknown` fields. A failed report may truthfully retain completed provider/source observations, but its status/outcome/error fields can never satisfy the R1 success contract consumed by adoption.

## Authoritative Email/Password OFF evidence

A dedicated schema-v2 GET-only CLI reads:

`GET https://identitytoolkit.googleapis.com/admin/v2/projects/video-quiz-65798/config`

The official endpoint requires `firebaseauth.configs.get`. Success requires HTTP 2xx, exact config resource name `projects/video-quiz-65798/config`, an explicit `signIn.email.enabled === false`, report-authored window/control identity, `writeCount: 0`, and `error: null`. HTTP 403, missing/defaulted fields, malformed JSON, enabled state, timeout, or transport loss produces only a fail-closed report. The report never serializes the raw Auth config or credentials.

This report becomes `r0AuthProviderOff`, ordered after the other R0 evidence and before R1. The sealed manifest gains an exact `authProvider` gate that binds the config name, OFF state, evidence window/control IDs, and capture time. Old manifests and manual/stale provider claims fail evidence validation.

Adoption also performs the same authoritative GET immediately before any Rules target/rollback/readback or release PATCH. If the provider is enabled or the read is unavailable/malformed, adoption stops without PATCH. Only an adoption report with `providerStateVerified: true`, `providerStillOff: true`, and the validated fresh evidence may set `safeForStaticDeployment: true`; Auth is never mutated.

## Contract and runbook changes

The evidence contract expands from 18 to 19 exact reports and validates the new provider report schema. R0 timing rules apply to the provider report. The R1 schema validates the deny-source pin and permits successful `response-success` or `landed-reconciled` outcomes only when authoritative release and anonymous readbacks are exact, rollback was not attempted, and mutation outcome is known.

The release manifest exact-key validator adds `authProvider`, and the quiescence object adds the pinned deny source SHA. The runbook adds the new package command, required IAM permission, report/manifest fields, immediate adoption re-read, R1 outcome semantics, and fail-closed handling. It also states that both release commit identities are the reviewed branch HEAD.

## Test strategy

Each production change follows RED/GREEN TDD:

- real production-default commit dependency regression;
- deny Ruleset wrong name/source/hash and prior release/source failures before PATCH;
- R1 ordinary 2xx success;
- server-landed lost response;
- settled definitely-not-landed response;
- indeterminate transport/reconciliation;
- known mismatch rollback success and rollback failure;
- provider CLI success plus 403/missing/malformed/enabled failures;
- manifest missing/stale/manual provider evidence;
- adoption immediate provider 403/enabled/malformed failures before Rules PATCH and verified-OFF success.

Final verification includes focused evidence/adoption tests, full `pnpm test`, local demo `pnpm test:rules`, syntax checks for all changed JavaScript, forbidden create/POST searches, GET-only provider/R8 searches, and Git diff checks.
