# Multi-Video Quiz Playlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 퀴즈 세트에 여러 YouTube 영상과 영상별 재생 구간·문항을 저장하고, 전체화면에서 중앙 영상·중앙 퀴즈 카드·퀴즈 전용 타임라인으로 연속 진행한다.

**Architecture:** 다중 영상 정규화와 시간 계산을 새 순수 모듈 `playlist-core.js`로 분리한다. 기존 단일 영상 문서는 읽을 때 영상 하나짜리 `videos[]`로 정규화하고, 편집기·교사 진행·학생 화면·대시보드는 전체 문항을 안정적인 전역 문항 키로 평탄화해 기존 응답 계약을 유지한다. YouTube 플레이어 DOM은 하나만 유지하고 영상 전환 때 `loadVideoById`로 소스와 시작 시간을 변경한다.

**Tech Stack:** 정적 HTML/CSS/JavaScript, YouTube IFrame API, Firebase Authentication/Firestore compat SDK 10.12.0, Node.js 내장 테스트 러너

**Spec:** `docs/superpowers/specs/2026-08-18-multi-video-quiz-playlist-design.md`

## Global Constraints

- 영상은 전체화면 정중앙에서 원본 16:9 비율을 유지한다.
- 퀴즈·정답·순위는 좌우 분할 없이 영상 위 정중앙 카드에 표시한다.
- `계속 재생`은 중앙 팝업만 제거하고 같은 플레이어·재생 위치·전체화면을 유지한다.
- 문항 `t`, `startSec`, `endSec`는 모두 원본 YouTube 영상 시각을 사용한다.
- 타임라인은 현재 영상의 `[startSec, endSec]`를 0~100%로 환산한다.
- 영상 전환은 세션·학생·응답·점수·Firestore 구독을 재생성하거나 초기화하지 않는다.
- 마지막 영상 완료는 세션을 종료하지 않는다. `진행 종료` 확인만 `store.endSession()`을 호출한다.
- 구형 `videoUrl`, `videoId`, `questions[]` 문서는 읽기 호환을 유지한다.
- Fullscreen API 거부·미지원 시 `.fullscreen-fallback` 동작을 유지한다.

---

### Task 1: 플레이리스트 정규화와 시간 계산 모듈

**Files:**
- Create: `playlist-core.js`
- Create: `tests/playlist-core.test.js`
- Modify: `index.html` (script include only)

**Interfaces:**
- Consumes: 구형 또는 신형 세트 객체
- Produces: `PlaylistCore.normalizeVideos(raw) -> Video[]`
- Produces: `PlaylistCore.flattenQuestions(videos) -> FlatQuestion[]`
- Produces: `PlaylistCore.timelineRatio(time, startSec, endSec) -> number`
- Produces: `PlaylistCore.validateVideo(video, durationSec) -> string[]`
- Produces: `PlaylistCore.nextPlaybackState(videos, videoIndex) -> { done, videoIndex, startSec }`

- [ ] **Step 1: 구형 정규화와 시간 계산의 실패 테스트 작성**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../playlist-core');

test('구형 단일 영상 세트를 영상 하나짜리 배열로 정규화한다', () => {
  assert.deepEqual(core.normalizeVideos({
    videoId: 'abc', videoUrl: 'https://youtu.be/abc',
    questions: [{ t: 90, text: '문항' }]
  }), [{
    videoId: 'abc', videoUrl: 'https://youtu.be/abc',
    startSec: 0, endSec: null,
    questions: [{ t: 90, text: '문항' }]
  }]);
});

test('재생 구간을 퀴즈 타임라인 비율로 환산한다', () => {
  assert.equal(core.timelineRatio(120, 120, 630), 0);
  assert.equal(core.timelineRatio(375, 120, 630), 0.5);
  assert.equal(core.timelineRatio(630, 120, 630), 1);
});
```

- [ ] **Step 2: 테스트를 실행해 RED 확인**

Run: `node --test tests/playlist-core.test.js`
Expected: FAIL with `Cannot find module '../playlist-core'`

- [ ] **Step 3: UMD 순수 모듈의 최소 구현 작성**

```js
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlaylistCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const n = value => Math.max(0, Number(value) || 0);
  function normalizeVideos(raw) {
    const source = Array.isArray(raw && raw.videos) && raw.videos.length
      ? raw.videos
      : [{ videoUrl: raw && raw.videoUrl, videoId: raw && raw.videoId,
           questions: raw && raw.questions }];
    return source.map(video => ({
      videoUrl: video.videoUrl || '', videoId: video.videoId || '',
      startSec: n(video.startSec),
      endSec: video.endSec == null || video.endSec === '' ? null : n(video.endSec),
      questions: (video.questions || []).filter(Boolean).map(q => Object.assign({}, q))
    }));
  }
  function timelineRatio(time, startSec, endSec) {
    const start = n(startSec), end = Math.max(start, n(endSec));
    if (end === start) return 0;
    return Math.max(0, Math.min(1, (n(time) - start) / (end - start)));
  }
  return { normalizeVideos, timelineRatio };
});
```

- [ ] **Step 4: 전역 문항 키와 검증·전환 테스트 추가**

```js
test('영상별 문항을 전역 번호와 안정적인 키로 평탄화한다', () => {
  const flat = core.flattenQuestions([
    { questions: [{ t: 10 }, { t: 20 }] },
    { questions: [{ t: 30 }] }
  ]);
  assert.deepEqual(flat.map(q => [q.key, q.number, q.videoIndex, q.questionIndex]), [
    ['v0q0', 1, 0, 0], ['v0q1', 2, 0, 1], ['v1q0', 3, 1, 0]
  ]);
});

test('시작 종료 역전과 범위 밖 문항을 검증한다', () => {
  assert.deepEqual(core.validateVideo({
    startSec: 100, endSec: 90, questions: [{ t: 95 }]
  }, 120), ['종료 시간은 시작 시간보다 뒤여야 합니다.']);
  assert.deepEqual(core.validateVideo({
    startSec: 10, endSec: 90, questions: [{ t: 95 }]
  }, 120), ['1번 문항이 재생 구간 밖에 있습니다.']);
});
```

- [ ] **Step 5: 누락 인터페이스 구현 후 전체 테스트 실행**

다음 구현을 모듈에 추가한다.

```js
function flattenQuestions(videos) {
  const flat = [];
  (videos || []).forEach((video, videoIndex) => {
    (video.questions || []).forEach((question, questionIndex) => flat.push(Object.assign({}, question, {
      key: `v${videoIndex}q${questionIndex}`,
      number: flat.length + 1, videoIndex, questionIndex
    })));
  });
  return flat;
}
function validateVideo(video, durationSec) {
  const start = n(video.startSec), end = video.endSec == null ? Number(durationSec) : n(video.endSec);
  if (Number.isFinite(end) && end <= start) return ['종료 시간은 시작 시간보다 뒤여야 합니다.'];
  if (Number.isFinite(durationSec) && end > durationSec) return ['종료 시간이 영상 길이를 넘습니다.'];
  const outside = (video.questions || []).findIndex(q => n(q.t) < start || (Number.isFinite(end) && n(q.t) > end));
  return outside < 0 ? [] : [`${outside + 1}번 문항이 재생 구간 밖에 있습니다.`];
}
function nextPlaybackState(videos, videoIndex) {
  const next = videoIndex + 1;
  return next >= (videos || []).length
    ? { done: true, videoIndex, startSec: null }
    : { done: false, videoIndex: next, startSec: n(videos[next].startSec) };
}
```

Run: `node --test tests/playlist-core.test.js tests/*.test.js`
Expected: all PASS

- [ ] **Step 6: 브라우저 전역 include와 커밋**

`teacher-stage.js`와 애플리케이션 스크립트 사이에 `<script src="playlist-core.js"></script>`를 추가한다.

```bash
git add playlist-core.js tests/playlist-core.test.js index.html
git commit -m "다중 영상 정규화와 시간 계산을 추가"
```

---

### Task 2: 구형·신형 세트 저장과 이미지 키 호환

**Files:**
- Modify: `index.html` (`normSet`, `setImportOne`, 편집 payload, 초안 필드)
- Modify: `editor-draft.js`
- Modify: `firestore-store.js`
- Modify: `tests/firestore-core.test.js`
- Modify: `tests/firestore-store.test.js`

**Interfaces:**
- Consumes: `PlaylistCore.normalizeVideos(raw)`와 `flattenQuestions(videos)`
- Produces: `normSet(raw).videos`
- Produces: 이미지 키 `v{videoIndex}q{questionIndex}`
- Produces: Firestore 세트 문서의 `videos[]`

- [ ] **Step 1: 구형·신형 저장 왕복과 초안 실패 테스트 작성**

```js
test('편집 초안은 다중 영상과 영상별 문항을 보존한다', () => {
  const model = { title: '세트', videos: [
    { videoId: 'a', startSec: 10, endSec: 20, questions: [{ t: 15 }] },
    { videoId: 'b', startSec: 30, endSec: 60, questions: [{ t: 40 }] }
  ] };
  draft.write(storage, 'set-a', model, 1000);
  assert.deepEqual(draft.read(storage, 'set-a').model.videos, model.videos);
});
```

`tests/firestore-store.test.js`에 다음 테스트를 추가한다.

```js
test('다중 영상 세트와 영상별 이미지 키를 보존한다', async () => {
  const videos = [
    { videoId: 'a', questions: [{ text: 'A' }] },
    { videoId: 'b', questions: [{ text: 'B' }] }
  ];
  await store.saveQuizSet('set1', { title: '세트', videos });
  await store.replaceImages('set1', { v0q0: 'img-a', v1q0: 'img-b' });
  assert.deepEqual(fake.value('quiz_sets/set1').videos, videos);
  assert.equal(fake.value('images/set1/q/v0q0').data, 'img-a');
  assert.equal(fake.value('images/set1/q/v1q0').data, 'img-b');
});
```

- [ ] **Step 2: 관련 테스트 RED 확인**

Run: `node --test tests/firestore-core.test.js tests/firestore-store.test.js`
Expected: FAIL because draft whitelist and image keys only support top-level questions

- [ ] **Step 3: 정규 세트 구조와 초안 whitelist 변경**

`normSet`은 다음 계약을 사용한다.

```js
function normSet(raw) {
  if (!raw) return null;
  const videos = PlaylistCore.normalizeVideos(raw).map(video => Object.assign({}, video, {
    questions: normQuestions(video.questions)
  }));
  return {
    title: raw.title || '제목 없음', author: raw.author || '',
    createdAt: raw.createdAt || 0, updatedAt: raw.updatedAt || 0,
    archived: !!raw.archived, settings: normSettings(raw.settings), videos
  };
}
```

`EditorDraft` 저장 필드는 `title`, `author`, `settings`, `videos`, `createdAt`, `archived`로 제한한다.

- [ ] **Step 4: 이미지 읽기·저장 키를 다중 영상 기준으로 변경**

신형 저장은 `v{videoIndex}q{questionIndex}`를 사용한다. 구형 이미지 문서 `0`, `1`은 영상 0의 `v0q0`, `v0q1`로 읽기 호환한다. `setImportOne`, 복제, 전체 내보내기에서도 같은 변환 함수를 사용한다.

- [ ] **Step 5: 관련 테스트와 전체 테스트 GREEN 확인**

Run: `node --test tests/firestore-core.test.js tests/firestore-store.test.js tests/playlist-core.test.js`
Expected: PASS

Run: `node --test tests/*.test.js`
Expected: all PASS

- [ ] **Step 6: 커밋**

```bash
git add index.html editor-draft.js firestore-store.js tests/firestore-core.test.js tests/firestore-store.test.js
git commit -m "다중 영상 세트 저장 호환을 추가"
```

---

### Task 3: 영상별 세로 카드 편집기와 구간 조절

**Files:**
- Modify: `index.html` (editor CSS, `screenMake`, `renderMake`, editor handlers)
- Modify: `tests/firestore-store.test.js`

**Interfaces:**
- Consumes: `mk.videos[]`, `PlaylistCore.validateVideo`, `timelineRatio`
- Produces: `mkAddVideo()`, `mkRemoveVideo(i)`, `mkMoveVideo(i, delta)`, `mkSetRange(i, edge, value)`, `mkSetQuestionTime(videoIndex, questionIndex, time)`
- Produces: 영상별 `YT.Player` 미리보기는 선택 카드 하나에만 생성

- [ ] **Step 1: 편집 상태와 렌더링 실패 테스트 작성**

```js
test('다중 영상 편집기는 영상 카드와 추가 버튼을 렌더링한다', () => {
  const ctx = loadEditorFunctions(['renderMake'], {
    mk: { id: null, title: '세트', author: '', settings: {}, videos: [
      { videoId: 'a', videoUrl: 'a', startSec: 10, endSec: 60, questions: [] },
      { videoId: 'b', videoUrl: 'b', startSec: 0, endSec: null, questions: [] }
    ] }
  });
  ctx.renderMake();
  assert.match(ctx.APP().innerHTML, /data-video-index="0"/);
  assert.match(ctx.APP().innerHTML, /data-video-index="1"/);
  assert.match(ctx.APP().innerHTML, /다음 YouTube 영상 추가/);
});
```

- [ ] **Step 2: 편집 테스트 RED 확인**

Run: `node --test --test-name-pattern="다중 영상 편집기" tests/firestore-store.test.js`
Expected: FAIL because editor still renders one global video and question list

- [ ] **Step 3: `mk` 상태를 `videos[]` 중심으로 변경**

새 세트 기본값:

```js
videos: [{ videoUrl: '', videoId: '', startSec: 0, endSec: null,
           durationSec: null, questions: [blankQuestion(0)] }],
activeVideo: 0
```

제목·작성자·공통 설정은 상단 카드에 두고, 각 영상은 `.mk-video-card[data-video-index]`로 렌더링한다.

- [ ] **Step 4: 입력·슬라이더·퀴즈 점 동기화 실패 테스트 작성**

```js
test('구간 손잡이와 직접 입력은 같은 초 값을 갱신한다', () => {
  const ctx = loadEditorFunctions(['mkSetRange'], {
    mk: { videos: [{ startSec: 10, endSec: 90, durationSec: 120 }] },
    renderMake() {}
  });
  ctx.mkSetRange(0, 'start', '00:20');
  ctx.mkSetRange(0, 'end', 100);
  assert.deepEqual([ctx.mk.videos[0].startSec, ctx.mk.videos[0].endSec], [20, 100]);
});
```

- [ ] **Step 5: 시간 입력·범위 슬라이더·퀴즈 드래그 구현**

직접 입력은 기존 `parseTime`을 사용한다. 범위 슬라이더는 두 개의 `input[type=range]`를 같은 트랙 위에 두고, 최소 간격 1초를 강제한다. 퀴즈 점의 `pointermove`는 카드 타임라인 폭과 `timelineRatio`의 역변환으로 원본 `t`를 갱신한다.

- [ ] **Step 6: 저장 검증과 반응형 CSS 구현**

`mkValidate`는 모든 영상에 대해 `validateVideo`를 호출하고 `영상 2: 1번 문항이 재생 구간 밖에 있습니다.`처럼 위치를 포함한다. 900px 미만에서는 미리보기와 구간 편집을 한 열로 쌓는다.

- [ ] **Step 7: 테스트와 커밋**

Run: `node --test tests/firestore-store.test.js tests/playlist-core.test.js`
Expected: PASS

```bash
git add index.html tests/firestore-store.test.js
git commit -m "영상별 카드와 재생 구간 편집을 추가"
```

---

### Task 4: 전역 문항 계약과 다중 영상 교사 재생

**Files:**
- Modify: `index.html` (`screenPlay`, `plTick`, question render/open/close, YouTube events)
- Modify: `tests/firestore-store.test.js`

**Interfaces:**
- Consumes: `pl.set.videos`, `PlaylistCore.flattenQuestions`
- Produces: `pl.videoIndex`, `pl.flatQuestions`, `plLoadVideo(index, autoplay)`, `plAdvanceVideo()`, `plCompletePlaylist()`
- Firestore `live.q`는 전체 평탄화 배열 인덱스를 계속 사용

- [ ] **Step 1: 전역 문항 번호와 영상 로딩 실패 테스트 작성**

```js
test('다음 영상은 같은 플레이어에 시작 시각으로 로드된다', () => {
  const calls = [];
  const ctx = loadStageFunctions(['plLoadVideo'], {
    pl: { videoIndex: 0, set: { videos: [
      { videoId: 'a', startSec: 10 }, { videoId: 'b', startSec: 30 }
    ] }, player: { loadVideoById(o) { calls.push(o); } } }
  });
  ctx.plLoadVideo(1, true);
  assert.deepEqual(calls, [{ videoId: 'b', startSeconds: 30 }]);
  assert.equal(ctx.pl.videoIndex, 1);
});
```

- [ ] **Step 2: RED 확인**

Run: `node --test --test-name-pattern="다음 영상" tests/firestore-store.test.js`
Expected: FAIL because `plLoadVideo` does not exist

- [ ] **Step 3: `pl` 재생 상태와 단일 플레이어 전환 구현**

`screenPlay`은 `videos`, `flatQuestions`, `videoIndex: 0`, `playlistDone: false`, `transitionUntil: 0`를 초기화한다. `YT.Player`는 첫 영상 한 번만 만들고 `plLoadVideo`는 이후 `loadVideoById({ videoId, startSeconds })`를 호출한다.

- [ ] **Step 4: 종료 시각·3초 전환·마지막 완료 실패 테스트 작성**

```js
test('영상 종료 후 3초 안내를 거쳐 다음 영상으로 이동한다', () => {
  const loaded = [];
  const ctx = loadStageFunctions(['plTick'], {
    pl: {
      videoIndex: 0, transitionUntil: 0, live: { q: -1 },
      set: { videos: [
        { startSec: 10, endSec: 40, questions: [] },
        { startSec: 20, endSec: 50, questions: [] }
      ] },
      player: { getCurrentTime() { return 40; } }
    },
    Date: { now() { return 1000; } },
    plLoadVideo(index, autoplay) { loaded.push([index, autoplay]); },
    plRenderTransition() {}
  });
  ctx.plTick();
  assert.equal(ctx.pl.transitionUntil, 4000);
  ctx.Date.now = () => 4000;
  ctx.plTick();
  assert.deepEqual(loaded, [[1, true]]);
});

test('마지막 영상 완료는 세션을 종료하지 않는다', () => {
  let ended = 0;
  const ctx = loadStageFunctions(['plCompletePlaylist'], {
    pl: { playlistDone: false, player: { pauseVideo() {} } },
    store: { endSession() { ended++; } },
    plRenderCompletion() {}
  });
  ctx.plCompletePlaylist();
  assert.equal(ctx.pl.playlistDone, true);
  assert.equal(ended, 0);
});
```

- [ ] **Step 5: `plTick` 전환 상태 머신 구현**

`plTick`은 현재 영상의 `startSec/endSec`만 검사한다. 열린 문항이 있으면 전환을 보류한다. 종료 도달 시 3초 안내 오버레이를 표시하고, 만료 후 다음 영상을 로드한다. 마지막 영상이면 `plCompletePlaylist()`가 완료 메뉴를 표시하고 플레이어를 정지한다.

- [ ] **Step 6: 기존 교사 기능을 평탄화 문항으로 전환**

문항 목록, 자동 문항 감지, `plOpenQuestion`, 점수판, 순위는 `pl.flatQuestions`를 사용한다. 각 평탄 문항의 `videoIndex`가 현재 영상과 같을 때만 자동 실행한다. `live.q`와 응답 문서 키는 전체 인덱스 문자열을 유지해 학생·대시보드 계약을 보존한다.

- [ ] **Step 7: 전체 테스트와 커밋**

Run: `node --test tests/firestore-store.test.js tests/playlist-core.test.js`
Expected: PASS

```bash
git add index.html tests/firestore-store.test.js
git commit -m "여러 영상을 같은 교사 플레이어에서 이어 재생"
```

---

### Task 5: 중앙 영상·중앙 퀴즈 카드와 퀴즈 전용 타임라인

**Files:**
- Modify: `index.html` (fullscreen CSS, stage markup, overlay, timeline render)
- Modify: `tests/firestore-store.test.js`

**Interfaces:**
- Consumes: `pl.videoIndex`, 현재 영상 구간, `PlaylistCore.timelineRatio`
- Produces: `#pl-quiz-timeline`, `.pl-timeline-progress`, `.pl-timeline-marker`
- Produces: `plRenderTimeline()`, `plRenderCenteredOverlay()`

- [ ] **Step 1: 중앙 배치와 타임라인 구조 실패 테스트 작성**

```js
test('전체화면 영상과 퀴즈 카드는 화면 중앙에 겹쳐 표시된다', () => {
  const html = readIndex();
  assert.match(html, /#pl-stage:fullscreen \.player-box[\s\S]*margin:\s*auto/);
  assert.match(html, /#pl-stage\.quiz-open #overlay[\s\S]*left:\s*50%[\s\S]*translate\(-50%,\s*-50%\)/);
  assert.doesNotMatch(html, /#pl-stage\.quiz-open #overlay\s*\{[^}]*left:\s*53vw/s);
});

test('퀴즈 타임라인은 현재 영상 구간과 문항 마커를 렌더링한다', () => {
  // startSec=120, endSec=620, now=220, 문항 t=370이면 진행 20%, 마커 50% 확인
});
```

- [ ] **Step 2: RED 확인**

Run: `node --test --test-name-pattern="화면 중앙|퀴즈 타임라인" tests/firestore-store.test.js`
Expected: FAIL because current CSS is split-screen and no quiz timeline exists

- [ ] **Step 3: 영상 중앙 레이아웃 구현**

전체화면 `.player-box`는 `width:min(92vw, calc(92vh * 16 / 9)); aspect-ratio:16/9; margin:auto`를 사용한다. `quiz-open`에서도 플레이어의 위치와 크기를 바꾸지 않고 `filter:brightness(.42)`만 적용한다.

- [ ] **Step 4: 중앙 카드 오버레이 구현**

`#overlay`는 전체화면에서 `position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:min(64vw,960px)`를 사용한다. 900px 미만에서는 `width:calc(100% - 32px)`를 사용한다. 정답·순위 카드도 같은 중앙 컨테이너 규칙을 공유한다.

- [ ] **Step 5: 퀴즈 전용 타임라인 구현**

타임라인은 하단 안전 영역에 현재 영상 진행, 완료 문항, 다음 문항 마커를 표시한다. `plTick`에서 DOM을 재생성하지 않고 폭·상태·텍스트만 갱신한다. 접근성 라이브 영역은 다음 문항 변경과 영상 전환만 알리고 200ms 진행률은 읽지 않는다.

- [ ] **Step 6: `계속 재생`, QR, 도구 겹침 회귀 테스트**

중앙 카드 닫기 후 같은 iframe/src와 전체화면 클래스가 유지되는지, QR 버블과 상단 도구가 카드 위에서 조작 가능한지, 타임라인이 카드의 주요 버튼을 가리지 않는지 테스트한다.

- [ ] **Step 7: 테스트와 커밋**

Run: `node --test tests/firestore-store.test.js`
Expected: PASS

```bash
git add index.html tests/firestore-store.test.js
git commit -m "중앙 퀴즈 카드와 퀴즈 타임라인을 추가"
```

---

### Task 6: 학생·대시보드·CSV의 다중 영상 문항 통합

**Files:**
- Modify: `index.html` (student, dashboard, CSV question access)
- Modify: `tests/firestore-store.test.js`

**Interfaces:**
- Consumes: `PlaylistCore.flattenQuestions(set.videos)`
- Produces: 학생·대시보드 공통 `flatQuestions`
- Produces: `studentQuestionView(flatQuestions, live) -> { number, total, question }`
- Produces: `dashCsvRows(set, students, responses) -> string[][]`
- 기존 응답 키 `"0"`, `"1"`은 전체 문항 인덱스로 유지

- [ ] **Step 1: 학생과 대시보드 평탄 문항 실패 테스트 작성**

```js
test('학생은 두 번째 영상 문항을 전체 번호로 표시한다', () => {
  const flat = PlaylistCore.flattenQuestions([
    { questions: [{ text: '1' }, { text: '2' }] },
    { questions: [{ text: '3' }] }
  ]);
  assert.deepEqual(studentQuestionView(flat, { q: 2 }), {
    number: 3, total: 3, question: flat[2]
  });
});

test('대시보드와 CSV는 모든 영상 문항을 합산한다', () => {
  const set = { videos: [
    { title: '영상 1', questions: [{ text: 'A' }, { text: 'B' }] },
    { title: '영상 2', questions: [{ text: 'C' }] }
  ] };
  const rows = dashCsvRows(set, {}, {});
  assert.match(rows[0].join(','), /영상 1 · 문항 1/);
  assert.match(rows[0].join(','), /영상 2 · 문항 3/);
});
```

- [ ] **Step 2: RED 확인**

Run: `node --test --test-name-pattern="두 번째 영상|모든 영상" tests/firestore-store.test.js`
Expected: FAIL because student/dashboard read `set.questions`

- [ ] **Step 3: 학생 화면의 문항 접근 변경**

세트 로드 직후 `st.flatQuestions = PlaylistCore.flattenQuestions(set.videos)`를 만든다. `live.q`, 타이머, 제출, 다시 고르기는 `flatQuestions[live.q]`를 사용한다. 영상 URL이나 플레이어 상태는 학생에게 전송하지 않는다.

- [ ] **Step 4: 대시보드·관리자·CSV 변경**

대시보드와 관리자 조회는 동일한 평탄화 결과로 헤더, 점수, 정답률, CSV를 만든다. CSV 문항 헤더는 `영상 2 · 문항 4`처럼 영상과 전체 번호를 함께 표시한다.

- [ ] **Step 5: 전체 회귀 테스트와 커밋**

Run: `node --test tests/*.test.js`
Expected: all PASS

```bash
git add index.html tests/firestore-store.test.js
git commit -m "학생과 대시보드에 다중 영상 문항을 통합"
```

---

### Task 7: 문서, 실제 브라우저 회귀, 통합과 배포

**Files:**
- Modify: `README.md`
- Modify: `docs/HANDOFF-2026-08-14.md`

**Interfaces:**
- Consumes: Tasks 1-6의 완성된 기능
- Produces: 사용자 안내와 공개 GitHub Pages 버전

- [ ] **Step 1: 사용자 문서 갱신**

README에 영상 추가, 순서 변경, 시작·종료 직접 입력/슬라이더, 영상별 퀴즈 타임라인, 마지막 영상 완료 메뉴를 설명한다. 인수인계 문서에는 `videos[]` 호환 구조, 이미지 키, 주요 함수, 테스트 수를 기록한다.

- [ ] **Step 2: 정적·자동 검증**

Run: `node --test tests/*.test.js`
Expected: all PASS

Run: `git diff --check`
Expected: no output

- [ ] **Step 3: 로컬 실제 브라우저 시나리오**

영상 2개 세트를 만든다. 영상 1은 시작·종료를 `0:10~0:40`, 영상 2는 `0:20~0:50`으로 지정하고 각 영상에 문항을 하나 이상 둔다. 교사 1명과 학생 5명으로 다음을 확인한다.

1. 영상 1이 0:10부터 시작한다.
2. 영상과 퀴즈 카드가 모두 전체화면 중앙에 위치한다.
3. 타임라인 현재 위치와 문항 마커가 구간 계산과 일치한다.
4. QR 열기·닫기·드래그가 재생과 타이머를 바꾸지 않는다.
5. 제출 1/미제출 4에서 마감 후 제출 5/미제출 0으로 바뀐다.
6. `계속 재생` 후 같은 플레이어와 위치가 유지된다.
7. 영상 1 종료 후 3초 안내와 함께 영상 2가 0:20부터 시작한다.
8. 영상 2의 문항 번호가 전체 번호로 이어진다.
9. 마지막 영상 완료 메뉴에서 순위·대시보드·처음부터 재생이 동작한다.
10. 완료 상태에서 세션이 유지되고 `진행 종료`에서만 종료된다.
11. 앱 출처 콘솔 오류·경고가 0건이다. 브라우저 확장 프로그램 출처 로그는 별도로 기록한다.

- [ ] **Step 4: 문서 커밋**

```bash
git add README.md docs/HANDOFF-2026-08-14.md
git commit -m "다중 영상 퀴즈 사용법을 문서화"
```

- [ ] **Step 5: 최종 전체 브랜치 리뷰**

설계와 이 계획을 기준으로 전체 diff를 독립 리뷰한다. Critical/Important finding을 수정하고 전체 테스트를 다시 실행한다.

- [ ] **Step 6: 메인 병합과 공개 배포 검증**

기능 브랜치를 `main`에 병합한 뒤 전체 테스트를 다시 실행하고 `main`을 원격에 푸시한다. `https://shining-jade.github.io/video-quiz/`에서 영상 2개 재생, 중앙 영상·퀴즈 카드, 퀴즈 타임라인, 영상 자동 전환, 마지막 완료, 진행 종료를 재검증한다.
