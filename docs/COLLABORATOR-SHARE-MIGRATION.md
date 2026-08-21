# Collaborator share-index migration

This trusted Firebase Admin migration repairs the self-addressed discovery index introduced at
`quiz_set_shares/{email}/sets/{setId}`. It is for valid pre-FixRound2 records that already have both
`quiz_sets/{setId}` and an exact `quiz_sets/{setId}/collaborators/{email}` document, but no share-index
document.

Do not grant a client repair permission. Current client add/remove/purge operations keep the parent,
collaborator, and index atomic; the migration uses Admin transactions only. No production migration
was run while implementing this tool.

## Safety boundary

- The CLI defaults to dry-run.
- Apply requires an exact `--confirm-project` matching `--project`.
- Production mode refuses stale emulator environment variables. Emulator mode requires a `demo-*`
  project and `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`.
- Each collection-group scan is capped by `--max-documents` (default 5,000; maximum 10,000) and fails
  closed if the cap is exceeded.
- Every planned pair is re-read in a transaction. A concurrent exact client add/remove is preserved;
  a missing or malformed authoritative collaborator never receives an index.
- Expected indexes are written with exactly `{email, setId}`. Malformed expected indexes are
  normalized, and indexes with no valid parent/collaborator pair are deleted.
- A final authoritative rescan sets `safeToUseShareIndex`. Orphan or malformed collaborators remain
  findings for manual remediation and keep that value false.
- The output uses the existing exclusive reserved-report writer. It never overwrites an existing
  report and preserves a fail-closed `.reserved` artifact if publication cannot complete.

Serialize trusted Admin repair jobs. Normal strict client mutations may continue because they already
maintain the three-document invariant atomically; another Admin process must not bypass that invariant
while this audit is running.

## Production dry-run

Choose a new report path outside Git and restrict access because findings can contain teacher email and
set identifiers.

```powershell
pnpm migrate:collaborator-shares -- --project video-quiz-65798 --target-mode production --output collaborator-shares-dry-run.json
```

Inspect these fields before apply:

- `status` must be `complete`.
- `plannedUpsertCount` is the number of missing or malformed expected indexes.
- `plannedDeleteCount` is the number of stale indexes.
- `audit.orphanCollaboratorCount` and `audit.malformedCollaboratorCount` require manual remediation.
- `safeToUseShareIndex` is true only when the dry-run already finds no work or unresolved findings.

## Production apply

Use a new output path and repeat the exact project ID:

```powershell
pnpm migrate:collaborator-shares -- --project video-quiz-65798 --target-mode production --apply --confirm-project video-quiz-65798 --output collaborator-shares-apply.json
```

Stop unless the durable report has `status: "complete"` and `safeToUseShareIndex: true`. A
`partial-failure` or `failed` report is not release evidence. Preserve it, remediate the listed records,
and rerun with a new output path; the operation is idempotent.

After a successful apply, run a new dry-run and require zero planned writes/deletes and
`safeToUseShareIndex: true`.

## Local Emulator verification

Start the Firestore Emulator through the repository test command. The automated Admin test exercises
dry-run, apply, exact-schema normalization, stale cleanup, idempotence, and orphan fail-closed audit:

```powershell
pnpm test:rules
```
