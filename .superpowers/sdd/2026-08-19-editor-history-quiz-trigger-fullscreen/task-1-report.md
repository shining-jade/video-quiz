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

## Fix Round 1

- RED: 정상 상태 `{ ok: false, error: 'valid' }` 회귀 테스트를 추가하고 `node --test tests/editor-history-core.test.js` 실행. 기존 구현이 clone 결과와 사용자 상태를 같은 표식으로 해석해 `create()`에서 `'valid'`를 예외로 던지며 1개 실패.
- GREEN: 내부 clone 결과를 `{ success, value/error }` wrapper로 분리하고 외부 실패 계약만 `{ ok:false, error }`로 유지.
- GREEN verification: `node --test tests/editor-history-core.test.js` — 6 passed, 0 failed; `git diff --check` passed.
- Fix commit: `c1f0c24`
