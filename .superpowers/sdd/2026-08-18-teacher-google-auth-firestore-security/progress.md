# SDD ledger — plan: docs/superpowers/plans/2026-08-18-teacher-google-auth-firestore-security.md

## Pre-flight review

Spec: `docs/superpowers/specs/2026-08-18-teacher-google-auth-firestore-security-design.md` (reachable; binding authority).

| Tasks / scope | Producer → consumer or internal consistency | Finding |
|---|---|---|
| Task 1 | AuthCore tests → UMD auth module → login UI | Consistent; teacher auth is separated from student anonymous auth. |
| Task 2 | Rules tests → emulator config/rules | Consistent; package.json is intentionally introduced here. |
| Task 3 | owner fields/UI tests → set CRUD | Consistent; consumes Task 1 teacher state and Task 2 rule helpers. |
| Task 4 | publicQuestion/UID tests → live session writes | Consistent; sanitized projection is the only student-readable question source. |
| Task 5 | migration tests → idempotent legacy ownership migration | Consistent; migration is restricted to approved legacy_owner. |
| Task 6 | regression tests → integrity/limit/cleanup fixes | Consistent; tests cover each named residual defect. |
| Task 7 | documentation → browser acceptance | Consistent; acceptance covers the approved cross-device and 5-student flow. |
| Task 8 | whole-branch review/tests → staged rules/site deployment | Consistent; external merge/push/publish remains a stop requiring explicit authorization. |
| Tasks 1 ↔ 3 | AuthCore teacher state → owner-aware teacher screens | Compatible; Task 3 consumes stable uid/email/role fields. |
| Tasks 1 ↔ 4 | student anonymous auth → UID-bound participation | Compatible; teacher popup is excluded from student flow. |
| Tasks 1 ↔ 5 | approved teacher state → migration eligibility | Compatible; verified email and allowance are available. |
| Tasks 1 ↔ 7 | login UI → browser acceptance/docs | Compatible; same-account cross-device behavior is testable. |
| Tasks 2 ↔ 3 | ownership rules → set CRUD | Compatible; ownership is established before strict writes. |
| Tasks 2 ↔ 4 | default-deny rules → student public projection | Compatible; Task 4 adds only the minimum UID/public paths. |
| Tasks 2 ↔ 5 | strict rules → legacy migration | Compatible under the staged deployment order in Tasks 7–8. |
| Tasks 2 ↔ 8 | emulator-tested rules → production rules deployment | Compatible; deploy occurs only after acceptance. |
| Tasks 3 ↔ 4 | owned set snapshot → sanitized live projection | Compatible; originals remain teacher-only. |
| Tasks 3 ↔ 5 | owner fields → legacy backfill | Compatible; migration supplies the fields new CRUD requires. |
| Tasks 3 ↔ 6 | set/session code → integrity hardening | Compatible; Task 6 preserves the ownership model. |
| Tasks 4 ↔ 6 | session response flow → rollback/queue/limits hardening | Compatible; Task 6 strengthens rather than changes public interfaces. |
| Tasks 4 ↔ 7 | public question/UID flow → 5-student browser scenario | Compatible; pre-reveal secrecy is explicitly verified. |
| Tasks 5 ↔ 7 | migration reporting → documentation/count verification | Compatible; browser/docs consume migration output. |
| Tasks 5 ↔ 8 | migrated documents → strict-rule cutover | Compatible; migration precedes strict rules. |
| Tasks 6 ↔ 7 | hardened runtime → browser regression | Compatible; browser acceptance exercises the repaired paths. |
| Tasks 6 ↔ 8 | safety preflights → release gate | Compatible; all automated checks run before deployment. |
| Tasks 7 ↔ 8 | acceptance report → release decision | Compatible; Task 8 repeats production acceptance after publish. |

Pre-flight result: no contradictions with the Global Constraints or binding spec. No ruling required.

Task 1: minor (deferred): student retry drops the original six-digit code argument.
Task 1: minor (deferred): Google/student separation test is static-only rather than executing the join flow.
Task 1: fix round 1/5 (1 addressed, 2 open — current sign-in provider not verified; route-level auth/clock race; commits 32d3a2e..03b375c).
Task 1: fix round 2/5 (1 addressed, 1 open — async auth observer can apply stale account after a newer callback; commits 03b375c..23ba783).
Task 1: minor (deferred): an already rendered protected screen is not actively rerouted when auth later changes.
Task 1: fix round 3/5 (1 addressed, 0 open — stale auth observer generation guarded; commits 23ba783..e834ff0).
Task 1: complete (commits ef0a49a..e834ff0, review clean).

Task 2: Ruling: approved teachers/admin may read shared quiz-set originals and images for lesson use/copy, while only the owner may edit/hide/replace images — the detailed binding spec and approved user intent override the plan Global Constraints shorthand saying teachers only view their own sets — cost if wrong: answers/explanations/private set images are visible to every approved teacher account, though never to students or unapproved users.
Task 2: fix round 1/5 (5 addressed, 2 open — publicAnswer.accept nested validation; malformed stored live read validation; commits 0e00b0b..cf9de05).
Task 2: fix round 2/5 (2 addressed, 0 open — bounded accept validation and stored projection read validation; commits cf9de05..b6e4776).
Task 2: complete (commits e834ff0..b6e4776, review clean).
Task 3: minor (deferred): owned-copy API test should directly include images rather than relying on the shared batch helper coverage.
Task 3: fix round 1/5 (1 addressed, 3 open — server-only auth probe; post-image/save authorization recheck; image-only copy revision race; commits 5d6c3e1..7bd5beb).
Task 3: fix round 2/5 (3 addressed, 0 open — server-only probes, current authorization save gates, parent contentRevision copy invariant; commits 7bd5beb..a1b6dc7).
Task 3: complete (commits b6e4776..a1b6dc7, review clean).
Task 4: minor (deferred): ensureAnonymousStudent should return the pinned user after clock synchronization.
Task 4: minor (deferred): public image rules need size and permitted-scheme constraints.
Task 4: minor (deferred): response answer validation should be type/size-aware against publicQuestion.
Task 4: fix round 1/5 (5 addressed, 3 open — owner response UID/root invariant; correctness leakage via readable response ok; close/response TOCTOU freeze; commits e258fe2..b97c1d0).
Task 4: Ruling: legacy response `ok`/`score` sanitization is a mandatory Task 5 migration/deployment gate, not a Task 4 runtime rewrite — Task 5 already owns legacy response migration and can remove or move those fields idempotently before strict-rule deployment — cost if wrong: any legacy response left unsanitized exposes correctness to its owning student through direct Firestore reads.
Task 4: fix round 2/5 (2 addressed, 3 open — timer grace q-change bypass; swallowed grade/board close errors; concurrent close calls; commits b97c1d0..adfa3da).
Task 4: fix round 3/5 (3 addressed, 1 open — cross-client stale freeze/final close writes need server compare-and-set; commits adfa3da..61f340b).
Task 4: fix round 4/5 (1 addressed, 0 open — liveToken transactional CAS prevents cross-client stale mutation; commits 61f340b..107f31f).
Task 4: complete (commits a1b6dc7..107f31f, review clean; legacy response sanitization carried to Task 5 by ruling).
Task 5: Ruling: replace the planned browser/staged-rules migration with a Firebase Admin SDK local operator command — client rules cannot safely authorize arbitrary legacy response rewrites or produce an unforgeable complete audit, while the spec requires a trusted administrator environment — cost if wrong: migration is less convenient and requires administrator credentials/terminal access, but no production credential or write is used during implementation.
Task 5: fix round 1/5 (4 prior areas passed, 6 Important open — numeric ambiguous errors; unmatched collection-group paths; lossy snapshot image normalization; emulator env binding; owner provision overwrite/removal; report reservation before writes; commits 48b6413..8dd6987).
Task 5: fix round 2/5 (4 addressed, 3 open — >MAX_SAFE_INTEGER image key loss; owner removal post-delete audit freshness; crash-safe atomic report replacement; commits 8dd6987..a14bf0a).
Task 5: fix round 3/5 (1 addressed, 2 open — no-replace report publication race; preserve valid reserved artifact on directory-fsync failure; commits a14bf0a..4c1fde9).
Task 5: fix round 4/5 (2 addressed, 0 open — atomic no-replace hard-link publication and persistent reserved companion; commits 4c1fde9..9a49e04).
Task 5: complete (commits 107f31f..9a49e04, review clean; production migration not run and strict deploy gate remains closed).
Task 6: minor (deferred): due-queue tests should cover publication failure followed by successful retry, though current failure preservation/manual de-dup logic passed review.
Task 6: fix round 1/5 (3 addressed, 3 open — activation/auth stale joinable orphan; durable owner cleanup recovery; overwrite old index-entry preflight; commits bc3809b..09a2986).
Task 6: fix round 2/5 (1 addressed, 2 open — registered-student read continuity across lease/end; overlapping stale heartbeat backlog; commits 09a2986..b180959).
Task 6: fix round 3/5 (2 addressed, 1 open — atomic whole-session end during active timer grace denied by accepting transition rule; commits b180959..d626fe1).
Task 6: fix round 4/5 (1 addressed, 0 open — atomic owner-authorized exact ended projection now succeeds during active grace; forged/live-only/non-owner variants remain denied; commits d626fe1..de30c67).
Task 6: complete (commits 9a49e04..de30c67, scoped re-review clean; Node 363 total/318 pass/45 emulator-only skip, Rules+Admin Emulator 411/411 pass).
Task 7: fix round 1/5 (1 Important and 3 Minor addressed — release-state contradiction, obsolete admin-password/auth comments, owner-only edit wording; commits 3717cec..e662616).
Task 7: complete with browser concern (commits de30c67..e662616, scoped re-review clean; Node 365 total/320 pass/45 emulator-only skip, Rules+Admin Emulator 411/411 pass; real-browser matrix remains blocked by Browser plugin trusted-path initialization error and is a pre-deploy gate).
Task 8: final fix wave complete locally (2 Important + 5 Minor addressed; Node 372 total/325 pass/47 emulator-only skip, Rules+Admin Emulator 421/421 pass; no deploy/migrate/push; Task 7 real-browser acceptance remains a release blocker).
