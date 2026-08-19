# Task 1 report — editor history core

## Result

- Implemented `EditorHistoryCore.create(initial, options)` in `editor-history-core.js`.
- Added bounded 50-step undo/redo stacks, `reset`, `current`, and capability checks.
- Added immutable JSON snapshots so callers cannot mutate internal history.
- Added same-field/time-window (default 600ms) input coalescing via `meta.key`, `meta.at`, and `meta.coalesceMs`.
- Invalid/circular snapshots return `{ ok: false, error }` and preserve the current state.

## Verification

- `node --test tests/editor-history-core.test.js`: 5 passed, 0 failed.
- `git diff --check`: passed.

## Commit

`220f9e7` — `편집기 실행 취소 상태 모듈을 추가`
