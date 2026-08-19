# 편집 이력·문항 재정렬·퀴즈 발화·전체화면 개선 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 편집기 Ctrl+Z/Ctrl+S와 교차 영상 문항 재정렬을 제공하고, YouTube seek·계속 재생 퀴즈 발화 버그 및 전체화면 레이아웃을 고친다.

**Architecture:** 편집 이력과 퀴즈 발화를 각각 순수 상태 모듈로 분리하고, 기존 `index.html` UI와 player callback이 이 모듈의 명령만 호출하게 한다. 문항 이동은 기존 `PlaylistCore` 데이터 모델에서 처리해 저장·이미지 원자 경로를 그대로 사용하며, 전체화면은 기존 `#pl-stage` 구조에 한 개의 layout mode/class 계산을 적용한다.

**Tech Stack:** 정적 HTML/CSS/JavaScript, YouTube IFrame API, Node `node:test`, Firebase/Firestore 기존 저장 경로

**Spec:** `docs/superpowers/specs/2026-08-19-editor-history-quiz-trigger-fullscreen-design.md`

## Global Constraints

- 기존 Firestore `videos[]`, 세션 snapshot, 학생 응답 및 strict counter/security Rules 구조를 변경하지 않는다.
- 모든 동작 변경은 RED 테스트를 먼저 실행해 의도한 이유로 실패한 것을 확인한다.
- 편집 이력은 최대 50단계이며 저장 성공 뒤 새 기준점으로 초기화한다.
- 다른 영상 이동은 기존 구간 상대 비율을 새 영상 구간에 적용하고 새 구간 안으로 clamp한다.
- 문항 시간은 원본 YouTube 영상 절대 초를 기준으로 저장·비교한다.
- 계속 재생 뒤 같은 문항은 즉시 반복하지 않고, 문항 시각보다 1초 이상 뒤로 이동한 뒤 다시 통과할 때만 재출제한다.
- 실제 브라우저에서 관찰하지 못한 동작을 완료했다고 주장하지 않는다.

---

### Task 1: 편집 이력 순수 모듈

**Files:**
- Create: `editor-history-core.js`
- Create: `tests/editor-history-core.test.js`

**Interfaces:**
- Consumes: JSON 직렬화 가능한 편집기 저장 상태.
- Produces: `EditorHistoryCore.create(initial, options)`, 인스턴스 메서드 `record(next, meta)`, `undo()`, `redo()`, `reset(saved)`, `canUndo()`, `canRedo()`, `current()`.

- [ ] **Step 1: 50단계·undo/redo·reset RED 테스트 작성**

```js
test('편집 이력은 50단계 undo/redo와 저장 기준점 reset을 지킨다', () => {
  const history = EditorHistoryCore.create({ title: '0' }, { limit: 50 });
  for (let i = 1; i <= 55; i++) history.record({ title: String(i) }, { key: 'title' });
  for (let i = 0; i < 50; i++) history.undo();
  assert.equal(history.current().title, '5');
  assert.equal(history.canUndo(), false);
  assert.equal(history.redo().title, '6');
  history.reset({ title: 'saved' });
  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), false);
});
```

- [ ] **Step 2: RED 확인**

Run: `node --test tests/editor-history-core.test.js`

Expected: `Cannot find module '../editor-history-core.js'`로 FAIL.

- [ ] **Step 3: immutable snapshot과 bounded stacks 최소 구현**

```js
function create(initial, { limit = 50 } = {}) {
  let value = clone(initial), undoStack = [], redoStack = [];
  return {
    record(next) {
      undoStack.push(clone(value));
      if (undoStack.length > limit) undoStack.shift();
      value = clone(next); redoStack = []; return clone(value);
    },
    undo() { if (!undoStack.length) return clone(value); redoStack.push(clone(value)); value = undoStack.pop(); return clone(value); },
    redo() { if (!redoStack.length) return clone(value); undoStack.push(clone(value)); value = redoStack.pop(); return clone(value); },
    reset(saved) { value = clone(saved); undoStack = []; redoStack = []; return clone(value); },
    current: () => clone(value), canUndo: () => undoStack.length > 0, canRedo: () => redoStack.length > 0
  };
}
```

- [ ] **Step 4: 같은 필드 연속 입력 coalescing 및 손상 snapshot 방어 테스트·구현**

`meta = { key, at, coalesceMs: 600 }`가 같은 key·시간 창이면 직전 undo snapshot을 추가하지 않는다. clone 실패 시 현재 값을 유지하고 `{ ok:false, error }`를 반환하는 테스트를 추가한다.

- [ ] **Step 5: 검증·커밋**

Run: `node --test tests/editor-history-core.test.js && git diff --check`

```bash
git add editor-history-core.js tests/editor-history-core.test.js
git commit -m "편집기 실행 취소 상태 모듈을 추가"
```

---

### Task 2: 교차 영상 문항 이동과 이미지 키 재매핑

**Files:**
- Modify: `playlist-core.js`
- Modify: `tests/playlist-core.test.js`

**Interfaces:**
- Consumes: `videos[]`, `images` map, `from={videoIndex,questionIndex}`, `to={videoIndex,questionIndex}`.
- Produces: `PlaylistCore.moveQuestion(videos, images, from, to) -> { videos, images, moved }`.

- [ ] **Step 1: 교차 영상 상대 시각·이미지 round-trip RED 테스트**

```js
test('문항을 다른 영상으로 옮기면 상대 시각과 canonical 이미지 키가 함께 이동한다', () => {
  const videos = [
    { start: 10, end: 110, questions: [{ t: 60, q: '중간' }] },
    { start: 200, end: 240, questions: [] }
  ];
  const moved = PlaylistCore.moveQuestion(videos, { v0q0: 'data:image/png;base64,A' },
    { videoIndex: 0, questionIndex: 0 }, { videoIndex: 1, questionIndex: 0 });
  assert.equal(moved.videos[1].questions[0].t, 220);
  assert.equal(moved.images.v1q0, 'data:image/png;base64,A');
  assert.equal(moved.images.v0q0, undefined);
});
```

- [ ] **Step 2: RED 확인**

Run: `node --test --test-name-pattern="다른 영상" tests/playlist-core.test.js`

Expected: `PlaylistCore.moveQuestion is not a function`으로 FAIL.

- [ ] **Step 3: 상대 비율 변환과 canonical 재키잉 구현**

```js
const ratio = (question.t - oldDomain.start) / (oldDomain.end - oldDomain.start);
question.t = Math.round(newDomain.start + clamp(ratio, 0, 1) * (newDomain.end - newDomain.start));
```

이동 전 이미지를 `{ questionObject -> imageData }` 임시 대응으로 보관한 뒤 전체 videos를 순회해 `v{vi}q{qi}` map을 새로 만든다. 입력 객체는 변경하지 않는다.

- [ ] **Step 4: 같은 영상 재정렬·경계 clamp·무효 drop 테스트**

같은 배열에서 아래로 이동할 때 제거 후 index 보정, 빈/무한 구간, 마지막 삽입, 동일 위치 no-op을 각각 검증한다.

- [ ] **Step 5: 검증·커밋**

Run: `node --test tests/playlist-core.test.js && git diff --check`

```bash
git add playlist-core.js tests/playlist-core.test.js
git commit -m "영상 사이 문항 이동과 이미지 재키잉을 추가"
```

---

### Task 3: 편집기 버블 UI와 Ctrl+Z/Ctrl+S 연결

**Files:**
- Modify: `index.html` 편집기 렌더·변경 명령·cleanup 구간
- Modify: `tests/firestore-store.test.js`
- Modify: `tests/release-copy.test.js`

**Interfaces:**
- Consumes: Task 1 `EditorHistoryCore`, Task 2 `PlaylistCore.moveQuestion`.
- Produces: `mkHistoryRecord(key)`, `mkUndo()`, `mkRedo()`, `mkMoveQuestion(fromVi,fromQi,toVi,toQi)`, `mkSaveShortcut(event)`, drag handlers.

- [ ] **Step 1: 버튼·단축키·고정 알림 RED DOM 테스트**

```js
test('Ctrl+S는 기본 동작과 scroll 변경 없이 저장하고 고정 상태 알림을 쓴다', () => {
  assert.match(html, /keydown[\s\S]*ctrlKey[\s\S]*key\.toLowerCase\(\) === 's'/);
  assert.match(html, /preventDefault\(\)/);
  assert.match(html, /position:\s*fixed[\s\S]*저장 완료/);
});
```

undo/redo 버튼 비활성화, IME `isComposing`, stale route token cleanup assertion도 추가한다.

- [ ] **Step 2: RED 확인**

Run: `node --test --test-name-pattern="Ctrl|실행 취소|문항 버블" tests/firestore-store.test.js tests/release-copy.test.js`

Expected: 단축키·버블 selector 부재로 FAIL.

- [ ] **Step 3: 편집 상태 변경 명령에 history boundary 연결**

`mkAddVideo`, `mkDeleteVideo`, `mkMoveVideo`, `mkAddQuestion`, `mkDeleteQuestion`, `mkMove`, 시간·텍스트 변경이 실제 mutation 직전에 `mkHistoryRecord(key)`를 호출한다. undo/redo 복원은 `mk.videos`, `mk.images`, 현재 preview index를 유효 범위로 보정한 뒤 `renderMake()` 한다.

- [ ] **Step 4: 제목 버블 drag·키보드 대체 명령 구현**

```html
<button class="mk-question-bubble" draggable="true"
  data-video="0" data-question="0" aria-label="문항 1 이동: 화상을 입었을 때…">
  <b>1</b><span>화상을 입었을 때…</span><time>2:54</time>
</button>
```

drop 때 한 번만 `PlaylistCore.moveQuestion`을 호출하고, pointer 취소·동일 위치는 history를 만들지 않는다. `위/아래/이전 영상/다음 영상` 메뉴도 동일 명령을 호출한다.

- [ ] **Step 5: Ctrl+S 저장 상태와 이력 reset 구현**

저장 직전 scrollX/scrollY와 activeElement를 기록하고 `mkSave(false)`를 호출한다. 저장 Promise 성공 때 `history.reset(currentPersistedState)`와 fixed toast를 갱신하며 scroll/focus를 강제로 이동하지 않는다. 실패 때 history는 유지한다.

- [ ] **Step 6: 전체 Node 검증·커밋**

Run: `node --test tests/*.test.js && git diff --check`

```bash
git add index.html tests/firestore-store.test.js tests/release-copy.test.js
git commit -m "문항 버블 재정렬과 편집 단축키를 연결"
```

---

### Task 4: 퀴즈 발화 root cause 재현과 상태 엔진

**Files:**
- Create: `quiz-trigger-core.js`
- Create: `tests/quiz-trigger-core.test.js`
- Modify: `index.html` player tick·seek·queue·continue 구간
- Modify: `tests/firestore-store.test.js`

**Interfaces:**
- Consumes: `{ questions, videoIndex, previousTime, currentTime, event, openIndex }`와 문항별 상태.
- Produces: `QuizTriggerCore.create(questions, options)`, `advance(input) -> { state, enqueue, rearmed }`, `complete(index)`, `resetVideo(videoIndex)`.

- [ ] **Step 1: 현재 버그를 설명하는 진단 RED 테스트 작성**

```js
test('continue 직후 같은 시각 tick은 완료 문항을 다시 queue하지 않는다', () => {
  const trigger = QuizTriggerCore.create([{ t: 174, videoIndex: 0 }]);
  assert.deepEqual(trigger.advance({ videoIndex: 0, previousTime: 173.5, currentTime: 174.1, event: 'tick' }).enqueue, [0]);
  trigger.complete(0);
  assert.deepEqual(trigger.advance({ videoIndex: 0, previousTime: 174.1, currentTime: 174.2, event: 'tick' }).enqueue, []);
});
```

현재 `fired` boolean이 되감기·continue·seek를 동시에 표현해 `pl.fired[i]=false`가 같은 위치 재발화를 만드는 것이 root cause임을 task report에 기록한다.

- [ ] **Step 2: RED 확인**

Run: `node --test tests/quiz-trigger-core.test.js`

Expected: 모듈 부재로 FAIL.

- [ ] **Step 3: upcoming/queued/open/completed/rearmed 상태 최소 구현**

forward crossing은 `(previousTime < t && t <= currentTime)`를 사용한다. seek는 도착 범위까지 통과한 문항을 정렬해 반환한다. completed는 `currentTime <= t - 1`이 관찰될 때만 rearmed로 바뀐다.

- [ ] **Step 4: 시간 정규화·seek·같은 시각 queue 테스트**

시작 시각이 15초인 영상의 원본 문항 174초, forward seek, backward 0.9초/1.0초 경계, 두 문항 같은 시각, 영상 전환 queue 분리를 검증한다.

- [ ] **Step 5: player runtime을 상태 엔진에 연결**

`plTick`은 currentTime을 한 번 읽어 엔진에 전달하고 반환된 index만 `dueQuestions`에 넣는다. `plOpenNextDue`는 `open`, `plCloseQuestion` 성공은 `complete`를 호출한다. 기존 `fired`는 timeline 표시 호환 projection으로만 계산하고 발화 진실 원천으로 사용하지 않는다.

- [ ] **Step 6: overlay 정리→재생 순서 RED/GREEN 테스트**

`plCloseQuestion` 성공 뒤 `plSetQuizOpen(false)`, overlay 비우기, timer 취소, dim class 제거가 먼저 완료되고 player `playVideo()`가 호출되는 순서를 assertion 한다. 실패하면 complete하지 않고 due 재시도를 유지한다.

- [ ] **Step 7: 검증·커밋**

Run: `node --test tests/quiz-trigger-core.test.js tests/firestore-store.test.js && git diff --check`

```bash
git add quiz-trigger-core.js tests/quiz-trigger-core.test.js index.html tests/firestore-store.test.js
git commit -m "seek와 계속 재생 퀴즈 발화 상태를 분리"
```

---

### Task 5: 전체화면 responsive geometry

**Files:**
- Modify: `index.html` `#pl-stage`, overlay, timeline CSS와 fullscreen handlers
- Modify: `tests/firestore-store.test.js`
- Modify: `tests/release-copy.test.js`

**Interfaces:**
- Consumes: stage `getBoundingClientRect()`, Fullscreen API 상태, CSS fallback class.
- Produces: `plLayoutMode(rect) -> { compact, overlayMaxWidth, overlayMaxHeight }`, `plApplyStageLayout()`.

- [ ] **Step 1: viewport geometry RED 테스트**

작은 1024×640 stage에서 overlay가 timeline safe area를 침범하지 않고, 1920×1080에서 중앙 최대 폭을 사용하며, fullscreen 해제 시 inline 변수와 scroll lock이 제거되는 assertion을 추가한다.

- [ ] **Step 2: RED 확인**

Run: `node --test --test-name-pattern="전체화면|overlay geometry|fullscreen 해제" tests/firestore-store.test.js tests/release-copy.test.js`

Expected: layout 함수·CSS 변수 부재로 FAIL.

- [ ] **Step 3: stage CSS 변수와 내부 scroll 구현**

```css
#pl-stage { --quiz-max-w:min(920px,calc(100% - 32px)); --quiz-max-h:calc(100% - 128px); }
#pl-stage #overlay { width:var(--quiz-max-w); max-height:var(--quiz-max-h); overflow:hidden; }
#pl-stage #overlay .quiz-body { min-height:0; overflow:auto; }
```

상단 상태와 하단 actions는 flex 고정, 본문만 scroll한다. timeline 높이를 safe area 계산에 포함한다.

- [ ] **Step 4: 한 개의 layout lifecycle 연결**

`fullscreenchange`, fallback 진입·해제, `resize`, `orientationchange`, overlay open/close가 모두 `plApplyStageLayout()`을 호출한다. cleanup은 listener, inline CSS variables, body scroll lock을 제거한다.

- [ ] **Step 5: 일반/Fullscreen/fallback/해제 회귀 검증·커밋**

Run: `node --test tests/*.test.js && git diff --check`

```bash
git add index.html tests/firestore-store.test.js tests/release-copy.test.js
git commit -m "전체화면 퀴즈 레이아웃을 viewport에 맞춤"
```

---

### Task 6: 통합 리뷰·브라우저 수용·배포

**Files:**
- Modify: `README.md`
- Modify: `docs/HANDOFF-2026-08-14.md`
- Modify: `tests/release-copy.test.js`

**Interfaces:**
- Consumes: Tasks 1–5의 clean commits.
- Produces: 검토된 `main`, GitHub Pages 배포, 관찰 근거가 포함된 handoff.

- [ ] **Step 1: 사용자 안내 RED 테스트와 문서 갱신**

README에 `Ctrl+Z`, `Ctrl+Shift+Z/Ctrl+Y`, `Ctrl+S`, 교차 영상 drag, seek 재출제 규칙을 설명한다. release-copy test가 정확한 문구를 검증한다.

- [ ] **Step 2: 전체 자동 검증**

Run:

```powershell
node --test tests/*.test.js
firebase emulators:exec --only firestore --project demo-video-quiz "node --test --test-concurrency=1 tests/firestore-rules.test.js tests/legacy-migration-admin-emulator.test.js"
git diff --check
git status --short
```

Expected: fail 0, tracked worktree clean. 운영 migration report JSON은 untracked 상태로 보존한다.

- [ ] **Step 3: 전체 브랜치 독립 리뷰**

base..HEAD에서 undo snapshot 데이터 손실, 이미지 키 오매핑, seek 반복/누락, stale player callback, fullscreen exit 잔여 class/scroll lock을 Critical/Important로 검토한다. 모든 finding은 TDD 수정 후 scoped re-review CLEAN을 받아야 한다.

- [ ] **Step 4: 실제 브라우저 수용**

로컬 또는 disposable 세트에서 Ctrl+Z/redo/save scroll 유지, 같은·다른 영상 drag, marker seek, continue 반복 방지, 1초 backward rearm, Fullscreen API와 CSS fallback 진입·해제를 확인한다. 앱 console error와 YouTube/extension error를 구분한다.

- [ ] **Step 5: 병합·배포**

`main`에 fast-forward 병합하고 병합 tree 전체 테스트를 재실행한다. 통과하면 `git push origin main`; GitHub Pages 캐시 우회 HTTP 200과 새 UI 문자열을 확인한다. Firestore Rules나 데이터 모델을 변경하지 않았으므로 Rules 재배포와 migration은 하지 않는다.

- [ ] **Step 6: 최종 기록 커밋**

```bash
git add README.md docs/HANDOFF-2026-08-14.md tests/release-copy.test.js
git commit -m "편집과 퀴즈 발화 개선 검증 결과를 기록"
git push origin main
```
