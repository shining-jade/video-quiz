# Task 8 report — final review fix wave

## Scope and release state

- Addressed both final-review Important findings and all five bounded Minor findings in one wave.
- No production migration, deployment, push, merge, credential use, or external data mutation was performed.
- The real-browser acceptance gate from Task 7 remains open and therefore production release remains blocked.

## Important fixes

1. Auth-observer changes now retract a protected teacher/admin screen immediately when the UID disappears or changes. After the current generation finishes, signed-out and downgraded users are sent home, account A→B reloads the same teacher route under B, and a same-user token refresh leaves the screen intact. Existing auth-generation checks still prevent stale token/allowance completions from routing.
2. Student response Rules now validate `answer` against the current `meta/live.publicQuestion`: zero-based integer choice index, bounded unique multi-choice indices, 100-character short text, and 1,000-character long text. The client uses the same validator before sending. Public question text/choice/image and public answer explanation are bounded; image schemes are limited to HTTPS and `data:image/`.

## Minor fixes and direct regression coverage

- Student join retry retains its original six-digit code.
- Anonymous identity is pinned across `ensureClock`; a replacement/current mismatch is rejected.
- Public projection boundary and Emulator abuse tests cover text, choices, image scheme, and accepted maximum values.
- Existing direct due-queue test verifies failure followed by success consumes exactly once.
- Owned-copy API coverage now directly copies multiple images; existing image-only revision-race coverage verifies retry to one current revision.

## TDD evidence

- Client/auth RED: 5 selected tests, 0 pass / 5 fail for missing bounds, missing validator, lost anonymous return, lost retry code, and missing route reconciliation.
- Client/auth GREEN: same 5 selected tests, 5 pass / 0 fail.
- Rules mutation RED: with the type-aware predicate temporarily removed, the focused response-shape suite failed all seven abuse cases because writes succeeded; the normal boundary remained successful.
- Rules GREEN: the restored focused cases and the complete Rules/Admin Emulator suite passed.

## Verification

- Node suite: 372 tests, 325 pass, 47 Emulator-only skip, 0 fail.
- Rules/Admin Emulator suite: 421 tests, 421 pass, 0 fail, 0 skip.
- `git diff --check`: no whitespace errors (line-ending notices only).
- `node --check firestore-store.js`: pass.

## Compatibility decision

- Kept legacy `mc` as an alias for `choice`.
- Kept the editor's 20 accepted short-answer aliases and 100-character per-alias limit; Rules branches were reordered to stay within the 1,000-expression budget.
- Public question limits are 1,000 characters for prompt text, 200 per choice, six choices, and 380,100 characters for HTTPS or `data:image/` image projections. Student text answers retain the existing client limits of 100/1,000 characters.
