# OX answer submission repair

User authorized correction, deployment, and a fresh actual student test. Preserve session-record protection commit 8bb0800; do not change rules, authentication, quiz content/settings, or existing classroom records.

1. Reproduce the actual student submission failure before implementation. RED evidence: ox-submit-red.log, seven failures, all caused by unsupported ox validation.
2. Accept exactly binary integer answers for two-choice OX questions; retain existing validation for every other type. Version the script URL so cached browsers load the correction.
3. Verify O/X correct/incorrect combinations through actual student functions, store, private grading, score construction, rejoin, and session-end retention. Verify empty responses, duplicate clicks, deadline drafts, and late clicks. Exercise existing rules for both choices, stale revisions, and expired grace without changing rules.
4. Run full unit/emulator suites and one independent review. Compare origin/main, commit only this repair, and deploy to the existing Pages main after green verification.
5. Verify public code hash, then create a separate TEST session and test actual OX response saving/scoring/rejoin/ending. Keep records. Use only independent supported browser contexts and report actual one-student coverage separately from unavailable three-student coverage.

Browser investigation: current inventory contains one Chrome extension profile and one in-app browser context. Management windows.create supports normal non-incognito windows only. It cannot create profiles or isolated student identities. Three same-profile tabs are not three students. No native URL-policy refusal is bypassed.

Pre-deploy verification: focused RED 7 failures -> GREEN 7 passes; full unit suite 933 passed, zero failed, 112 emulator-gated skips; separate Firestore emulator suite 489 passed, zero failed/skipped. One independent read-only reviewer found no important defect and independently confirmed seven focused passes plus diff check. The reviewer correctly noted that actual browser rejoin remains separate from the local restored-answer test; that will be checked in the new TEST session after deployment.
