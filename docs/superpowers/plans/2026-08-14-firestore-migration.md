# Firestore 이전 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 화면과 사용법을 유지하면서 영상 퀴즈의 RTDB 저장소를 Firestore로 완전히 이전하고 Firebase 콘솔 설정부터 GitHub Pages 배포 검증까지 마친다.

**Architecture:** Firebase compat SDK를 유지하되 Firestore 전용 저장소 모듈과 순수 데이터 변환 모듈을 추가한다. 화면 코드는 의미가 명확한 저장소 API만 호출하며, 학생은 live 문서 하나만 구독하고 서버 시각·응답·board·관리자 삭제는 Firestore 문서 모델에 맞게 처리한다.

**Tech Stack:** HTML/CSS/vanilla JavaScript, Firebase App/Auth/Firestore compat 10.12.0, Node.js 내장 `node:test`, Firebase Console, GitHub Pages

## Global Constraints

- 화면, URL, 한국어 문구와 사용법을 변경하지 않는다.
- 학생은 `sessions/{sessionId}/meta/live` 문서 하나만 실시간 구독한다.
- 다른 학생의 응답을 학생 클라이언트로 내려보내지 않는다.
- board는 문항이 닫힐 때 한 번만 갱신한다.
- `openedAt`은 Firestore 서버 타임스탬프이며 타이머는 보정된 서버 시각을 사용한다.
- 퀴즈 세트 삭제는 금지하고 `archived: true`만 사용한다.
- 이미지 문서는 `images/{setId}/q/{questionIndex}`에 하나씩 저장한다.
- 커밋 메시지는 한국어로 작성한다.
- 개인정보가 기존보다 더 노출되는 화면이나 로그를 추가하지 않는다.

---

## 파일 구조

- Create: `firestore-core.js` — Firebase와 DOM에 의존하지 않는 Timestamp 변환, 서버 오프셋, 응답 변환, 점수판 및 batch 분할 함수
- Create: `firestore-store.js` — Firestore 문서 경로, CRUD, 구독, 트랜잭션, 서버 시각 동기화 및 관리자 삭제 저장소 API
- Create: `tests/firestore-core.test.js` — 순수 함수 단위 테스트
- Create: `tests/firestore-store.test.js` — 메모리형 Firestore fake로 저장소 계약과 구독 범위를 검증
- Create: `firestore.rules` — 인증 사용자 기반 Firestore 보안 규칙
- Modify: `index.html` — Firestore SDK/모듈 로드와 모든 화면의 저장소 호출 교체
- Modify: `README.md` — Firestore 설정, 구조, 할당량, 운영 및 데이터 이전 안내
- Modify: `FIRESTORE-MIGRATION.md` — 실제 완료 상태와 콘솔/배포 검증 결과 기록
- Delete: `database.rules.json` — RTDB 사용이 완전히 제거되고 배포 검증까지 통과한 마지막 단계에서 삭제

---

### Task 1: 순수 Firestore 데이터 변환과 시간 계산

**Files:**
- Create: `firestore-core.js`
- Create: `tests/firestore-core.test.js`

**Interfaces:**
- Produces: `timestampMillis(value): number|null`
- Produces: `offsetFromRoundTrip(serverMillis, startedAt, finishedAt): number`
- Produces: `responseDocsToQuestionMaps(docs): Record<string, Record<string, object>>`
- Produces: `buildBoard(students, responseDocs): Record<string, number>`
- Produces: `chunk(items, size): Array<Array<unknown>>`

- [ ] **Step 1: 시간과 응답 변환의 실패 테스트 작성**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../firestore-core.js');

test('Timestamp와 왕복 중간값으로 서버 시각 오프셋을 계산한다', () => {
  const ts = { toMillis: () => 10_250 };
  assert.equal(core.timestampMillis(ts), 10_250);
  assert.equal(core.offsetFromRoundTrip(10_250, 10_000, 10_100), 200);
});

test('학생별 응답 문서를 기존 문항별 화면 형태로 바꾼다', () => {
  const docs = {
    s1: { answers: { '0': { c: 1, ok: true }, '2': { txt: '답' } } },
    s2: { answers: { '0': { c: 0, ok: false } } }
  };
  assert.deepEqual(core.responseDocsToQuestionMaps(docs), {
    '0': { s1: { c: 1, ok: true }, s2: { c: 0, ok: false } },
    '2': { s1: { txt: '답' } }
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/firestore-core.test.js`

Expected: FAIL with `Cannot find module '../firestore-core.js'`.

- [ ] **Step 3: 최소 모듈과 시간·응답 변환 구현**

```js
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FirestoreCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function timestampMillis(value) {
    if (value == null) return null;
    if (typeof value === 'number') return value;
    if (typeof value.toMillis === 'function') return value.toMillis();
    return null;
  }
  function offsetFromRoundTrip(serverMillis, startedAt, finishedAt) {
    return serverMillis - (startedAt + finishedAt) / 2;
  }
  function responseDocsToQuestionMaps(docs) {
    const out = {};
    Object.keys(docs || {}).forEach(studentId => {
      Object.entries((docs[studentId] && docs[studentId].answers) || {}).forEach(([q, answer]) => {
        (out[q] || (out[q] = {}))[studentId] = answer;
      });
    });
    return out;
  }
  return { timestampMillis, offsetFromRoundTrip, responseDocsToQuestionMaps };
});
```

- [ ] **Step 4: 시간·응답 테스트 통과 확인**

Run: `node --test tests/firestore-core.test.js`

Expected: 2 tests PASS.

- [ ] **Step 5: 점수판·미채점·batch 분할 실패 테스트 추가**

```js
test('미채점 응답은 점수에서 빼고 등록 학생 모두의 점수를 만든다', () => {
  assert.deepEqual(core.buildBoard(
    { s1: { name: '가' }, s2: { name: '나' } },
    {
      s1: { answers: { '0': { ok: true }, '1': { txt: '서술' }, '2': { ok: false } } },
      s2: { answers: { '0': { ok: true }, '1': { ok: true } } }
    }
  ), { s1: 1, s2: 2 });
});

test('관리자 삭제 작업을 지정 크기로 나눈다', () => {
  assert.deepEqual(core.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.throws(() => core.chunk([1], 0), /양수/);
});
```

- [ ] **Step 6: 점수판과 분할 최소 구현 후 전체 테스트 통과**

```js
function buildBoard(students, responseDocs) {
  const board = {};
  Object.keys(students || {}).forEach(id => {
    const answers = (responseDocs[id] && responseDocs[id].answers) || {};
    board[id] = Object.values(answers).filter(answer => answer && answer.ok === true).length;
  });
  return board;
}
function chunk(items, size) {
  if (!Number.isInteger(size) || size < 1) throw new Error('분할 크기는 양수여야 합니다.');
  const groups = [];
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
  return groups;
}
```

Run: `node --test tests/firestore-core.test.js`

Expected: 4 tests PASS.

- [ ] **Step 7: 커밋**

```bash
git add firestore-core.js tests/firestore-core.test.js
git commit -m "Firestore 데이터 변환과 서버 시각 계산을 테스트로 고정"
```

---

### Task 2: Firestore 저장소 계약과 실시간 구독 범위

**Files:**
- Create: `firestore-store.js`
- Create: `tests/firestore-store.test.js`
- Modify: `index.html:526-565`

**Interfaces:**
- Consumes: `FirestoreCore.timestampMillis`, `offsetFromRoundTrip`, `chunk`
- Produces: `createFirestoreStore(db, fieldValue, nowFn)`
- Produces store methods: `getDoc`, `setDoc`, `mergeDoc`, `deleteDoc`, `getCollection`, `subscribeDoc`, `subscribeCollection`, `syncClock`, `serverNow`, `claimSessionCode`

- [ ] **Step 1: 경로·구독·정리 계약의 실패 테스트 작성**

메모리 fake는 실제 compat API 모양인 `db.doc(path)`와 `db.collection(path)`을 제공하고 호출 경로를 기록한다. 테스트는 mock 호출 횟수가 아니라 store가 반환한 데이터와 구독 해제라는 사용자 관찰 가능 결과를 검증한다.

```js
test('학생 live 구독은 정확히 한 문서를 구독하고 해제할 수 있다', async () => {
  const fake = makeFirestoreFake({
    'sessions/a/meta/live': { q: 2, revealed: false }
  });
  const store = createFirestoreStore(fake.db, fake.fieldValue, () => 1000);
  let received;
  const stop = store.subscribeDoc('sessions/a/meta/live', value => { received = value; });
  await fake.flush();
  assert.deepEqual(received, { q: 2, revealed: false });
  stop();
  fake.emit('sessions/a/meta/live', { q: 3 });
  assert.deepEqual(received, { q: 2, revealed: false });
  assert.deepEqual(fake.subscribedPaths(), ['sessions/a/meta/live']);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/firestore-store.test.js`

Expected: FAIL because `createFirestoreStore` is missing.

- [ ] **Step 3: 기본 CRUD·구독 구현**

```js
function createFirestoreStore(db, fieldValue, nowFn) {
  let serverOffset = 0;
  const snapshotValue = snap => snap.exists ? ({ id: snap.id, ...snap.data() }) : null;
  return {
    getDoc: path => db.doc(path).get().then(snapshotValue),
    setDoc: (path, value) => db.doc(path).set(value),
    mergeDoc: (path, value) => db.doc(path).set(value, { merge: true }),
    deleteDoc: path => db.doc(path).delete(),
    getCollection: path => db.collection(path).get().then(q => Object.fromEntries(q.docs.map(d => [d.id, d.data()]))),
    subscribeDoc(path, next, error) {
      return db.doc(path).onSnapshot(s => next(snapshotValue(s)), error);
    },
    subscribeCollection(path, next, error) {
      return db.collection(path).onSnapshot(q => next(Object.fromEntries(q.docs.map(d => [d.id, d.data()]))), error);
    },
    serverNow: () => nowFn() + serverOffset
  };
}
```

- [ ] **Step 4: CRUD·구독 테스트 통과 확인**

Run: `node --test tests/firestore-store.test.js`

Expected: subscription test PASS.

- [ ] **Step 5: 서버 시각 보정과 코드 충돌 테스트 추가**

```js
test('서버 Timestamp를 되읽어 오프셋을 캐시한다', async () => {
  const fake = makeFirestoreFake({}, { committedServerMillis: 10_250 });
  const times = [10_000, 10_100];
  const store = createFirestoreStore(fake.db, fake.fieldValue, () => times.shift() ?? 10_100);
  await store.syncClock('clock/sample-a');
  assert.equal(store.serverNow(), 10_300);
});

test('이미 존재하는 반 코드는 덮어쓰지 않는다', async () => {
  const fake = makeFirestoreFake({ 'codes/ABC234': { sessionId: 'old' } });
  const store = createFirestoreStore(fake.db, fake.fieldValue, () => 1_000);
  assert.equal(await store.claimSessionCode('ABC234', 'new', { setId: 'set1' }), false);
  assert.deepEqual(fake.value('codes/ABC234'), { sessionId: 'old' });
});
```

- [ ] **Step 6: `syncClock`과 `runTransaction` 기반 코드 선점 구현**

`syncClock(path)`은 호출마다 충돌하지 않는 `clock/{sampleId}` 경로를 받아 `fieldValue.serverTimestamp()`를 기록하고 확정된 값을 되읽은 뒤 임시 문서를 삭제한다. `claimSessionCode`는 하나의 트랜잭션에서 code 존재 확인 후 `codes/{code}`, `sessions/{sessionId}`, `sessions/{sessionId}/meta/live`, `meta/board`를 생성한다. 기존 code가 있으면 아무것도 쓰지 않고 `false`를 반환한다.

Run: `node --test tests/firestore-store.test.js`

Expected: all store tests PASS.

- [ ] **Step 7: SDK와 모듈 로드 교체**

`index.html`에서 `firebase-database-compat.js`, `firebase.database()`, `ServerValue.TIMESTAMP`, `.info/serverTimeOffset`를 제거하고 아래 순서로 로드한다.

```html
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js"></script>
<script src="firestore-core.js"></script>
<script src="firestore-store.js"></script>
```

```js
const db = firebase.firestore();
const store = FirestoreStore.createFirestoreStore(db, firebase.firestore.FieldValue, () => Date.now());
function serverNow() { return store.serverNow(); }
```

- [ ] **Step 8: 전체 자동 테스트와 정적 확인**

Run: `node --test tests/*.test.js`

Expected: all tests PASS.

Run: `rg -n "firebase-database|firebase\.database|ServerValue|serverTimeOffset" index.html firestore-*.js`

Expected: no matches.

- [ ] **Step 9: 커밋**

```bash
git add index.html firestore-store.js tests/firestore-store.test.js
git commit -m "Firestore 저장소와 정확한 실시간 구독 경계를 추가"
```

---

### Task 3: 퀴즈 세트와 문항 이미지 이전

**Files:**
- Modify: `firestore-store.js`
- Modify: `tests/firestore-store.test.js`
- Modify: `index.html:1014-2060`

**Interfaces:**
- Produces store methods: `listQuizSets`, `getQuizSet`, `saveQuizSet`, `patchQuizSet`, `getQuestionImage`, `getImages`, `replaceImages`, `copyQuizSet`
- Image object contract: existing screen format `{ "0": dataUri, "2": dataUri }`

- [ ] **Step 1: 이미지 하위 컬렉션 왕복 실패 테스트 작성**

```js
test('이미지를 문항별 문서로 교체하고 기존 화면 형태로 읽는다', async () => {
  const fake = makeFirestoreFake({
    'images/set1/q/0': { data: 'old' },
    'images/set1/q/3': { data: 'remove-me' }
  });
  const store = createStore(fake);
  await store.replaceImages('set1', { '0': 'new', '2': 'third' });
  assert.deepEqual(await store.getImages('set1'), { '0': 'new', '2': 'third' });
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/firestore-store.test.js --test-name-pattern="이미지"`

Expected: FAIL because `replaceImages` is missing.

- [ ] **Step 3: 세트·이미지 저장소 메서드 최소 구현**

`replaceImages`는 기존 `images/{setId}/q` 문서 ID와 새 키를 비교해 batch로 set/delete한다. `getImages`는 각 문서의 `data`만 기존 객체로 되돌린다. `saveQuizSet`은 문서 ID를 데이터에 중복 저장하지 않고 `questions` 배열을 그대로 보존한다.

- [ ] **Step 4: 세트 목록·숨김·복제 실패 테스트와 구현**

테스트는 `archived` 병합이 다른 필드를 보존하고, 복제가 새 세트 문서와 모든 이미지 문서를 만들며 원본을 바꾸지 않는지 검증한다.

Run: `node --test tests/firestore-store.test.js`

Expected: all tests PASS.

- [ ] **Step 5: 화면 호출 교체**

다음 함수의 `R(...).once/set` 호출을 저장소 API로 교체한다: `loadQuestionImage`, `screenSetList`, `setArchive`, `setExport`, `setExportAll`, `setImportOne`, `setDuplicate`, `screenMake`, `mkSave`, `screenPlay`.

내보내기 파일 형태 `{ version, exportedAt, sets: [{ data, images }] }`는 바꾸지 않는다. 저장·복제 시 이미지가 없는 문항의 이전 문서를 삭제한다.

- [ ] **Step 6: 자동 테스트와 로컬 브라우저 검증**

Run: `node --test tests/*.test.js`

Expected: all tests PASS.

브라우저에서 새 세트의 5종 문항 저장·재편집, 업로드 이미지 표시, 복제, JSON 내보내기/가져오기를 확인한다.

- [ ] **Step 7: 커밋**

```bash
git add index.html firestore-store.js tests/firestore-store.test.js
git commit -m "퀴즈 세트와 이미지를 Firestore 문서 구조로 이전"
```

---

### Task 4: 세션·응답·점수판과 교사 화면 이전

**Files:**
- Modify: `firestore-core.js`
- Modify: `firestore-store.js`
- Modify: `tests/firestore-core.test.js`
- Modify: `tests/firestore-store.test.js`
- Modify: `index.html:2091-2648`

**Interfaces:**
- Produces store methods: `startSession`, `subscribeStudents`, `subscribeResponses`, `subscribeLive`, `setLive`, `endSession`, `writeBoard`
- `subscribeResponses` returns student-doc shape; screen converts it with `responseDocsToQuestionMaps`

- [ ] **Step 1: 고유 코드 재시도 실패 테스트 작성**

```js
test('충돌한 반 코드를 건너뛰고 다음 코드를 사용한다', async () => {
  const attempts = [];
  const claim = async code => { attempts.push(code); return code === 'NEW234'; };
  const result = await core.claimFirstAvailableCode(['OLD234', 'NEW234'], claim);
  assert.equal(result, 'NEW234');
  assert.deepEqual(attempts, ['OLD234', 'NEW234']);
});
```

- [ ] **Step 2: 실패 확인 후 최소 구현**

```js
async function claimFirstAvailableCode(codes, claim) {
  for (const code of codes) if (await claim(code)) return code;
  throw new Error('사용 가능한 반 코드를 만들지 못했습니다. 다시 시도해 주세요.');
}
```

Run: `node --test tests/firestore-core.test.js`

Expected: all tests PASS.

- [ ] **Step 3: 세션 저장소 API 구현과 테스트**

`startSession`은 최대 10개 후보를 생성하고 `claimSessionCode`로 선점한다. `setLive`는 항상 `sessions/{id}/meta/live` 문서 전체를 쓴다. `endSession`은 세션 상태와 종료 시각을 병합한 뒤 live를 대기 상태로 쓴다.

테스트는 학생/응답 구독이 각각 `students`, `responses` 컬렉션만 구독하고 live는 `meta/live` 문서만 구독하는지 실제 반환 데이터로 검증한다.

- [ ] **Step 4: 교사 재생 화면 호출 교체**

`plStartSession`, `renderPlayRun`, `plOpenQuestion`, `plReveal`, `plCloseQuestion`, `plEndSession`을 저장소 API로 바꾼다. `pl.responses`는 화면 호환을 위해 `responseDocsToQuestionMaps` 결과를 사용한다.

`plPushBoard`를 응답 구독 콜백에서 제거하고 `plCloseQuestion`에서 live를 닫기 직전에 한 번 호출해 `meta/board`에 `{ scores: board }`를 쓴다.

- [ ] **Step 5: 공개 전 정보 은닉 회귀 확인**

기존 `plRenderOverlay`, `plRenderOverlayCounts`, `plRevealed` 분기를 변경하지 않고, 테스트용 fixture로 `revealed: false`일 때 정답 라벨과 보기별 수가 렌더 문자열에 없는지 확인한다. 브라우저에서도 교사 화면에 제출 인원만 보이는지 확인한다.

- [ ] **Step 6: 테스트 통과와 커밋**

Run: `node --test tests/*.test.js`

Expected: all tests PASS.

```bash
git add index.html firestore-core.js firestore-store.js tests
git commit -m "수업 세션과 교사 대시보드를 Firestore 실시간 구조로 이전"
```

---

### Task 5: 학생 참여·본인 응답·서버 기준 타이머 이전

**Files:**
- Modify: `firestore-store.js`
- Modify: `tests/firestore-store.test.js`
- Modify: `index.html:2658-3135,3866-3878`

**Interfaces:**
- Produces store methods: `getCode`, `getSession`, `getStudent`, `saveStudent`, `getOwnResponses`, `mergeAnswer`, `getBoard`, `subscribeLive`, `syncClock`
- `mergeAnswer(sessionId, studentId, questionIndex, answer)` stores `answers.<questionIndex>` with merge semantics

- [ ] **Step 1: 본인 응답 병합 실패 테스트 작성**

```js
test('새 답은 같은 학생 문서의 다른 문항 답을 보존한다', async () => {
  const fake = makeFirestoreFake({
    'sessions/a/responses/s1': { answers: { '0': { c: 1, ok: true } } }
  });
  const store = createStore(fake);
  await store.mergeAnswer('a', 's1', 2, { txt: '서술', at: 123, ms: 456 });
  assert.deepEqual(await store.getOwnResponses('a', 's1'), {
    '0': { c: 1, ok: true },
    '2': { txt: '서술', at: 123, ms: 456 }
  });
});
```

- [ ] **Step 2: 실패 확인과 최소 구현**

`mergeAnswer`은 FieldPath 충돌을 피하도록 전체 기존 문서를 읽지 않고 `set({ answers: { [String(i)]: answer } }, { merge: true })`가 중첩 map을 보존하는지 emulator/fake에서 확인한다. compat merge가 중첩 map 전체를 덮는 동작이면 `update({ ['answers.' + i]: answer })`를 사용한다.

Run: `node --test tests/firestore-store.test.js --test-name-pattern="새 답"`

Expected: PASS after implementation.

- [ ] **Step 3: 학생 화면은 live 하나만 구독하도록 교체**

`stLookupCode`는 code/session/set을 단발 조회한다. `stJoin`은 본인 학생 문서와 본인 응답 문서만 단발 조회한다. `stStartWatching`에서는 live 문서 구독 하나만 남긴다. 세션 종료 상태는 live에 `status: 'ended'`를 포함시키거나 q=-1 전환과 함께 세션을 단발 재조회해 처리하며 별도 status 구독은 두지 않는다. board는 live가 문항 상태에서 대기 상태로 바뀐 직후 `getBoard`로 한 번 읽는다.

- [ ] **Step 4: 서버 시각 보정 실패 시 수업 차단 구현**

`bootWithAuth`는 익명 인증 후 인증 UID와 `rid(8)`로 만든 고유 경로를 넘겨 `await store.syncClock('clock/' + user.uid + '-' + rid(8))`이 성공해야 router를 시작한다. 실패하면 기존 연결 오류 영역에 `서버 시각을 확인하지 못했습니다. 새로고침해 주세요.`를 표시하고 수업 시작 버튼을 활성화하지 않는다.

live의 `openedAt` Timestamp는 `timestampMillis`로 바꾸고 `stTick`, `stLocked`, `stLeftRatio`, `plTick`, `plTimerTick`은 모두 `serverNow()`를 사용한다.

- [ ] **Step 5: 학생 정보 격리 정적·동작 검증**

Run: `rg -n "subscribe(Collection|Doc)|watch\(" index.html firestore-store.js`

Expected: 학생 코드 경로에는 `subscribeLive` 한 번만 존재하고 responses/students/session/board 구독이 없다.

브라우저 네트워크/Firestore 사용 상태에서 학생 창이 다른 학생 응답 문서를 읽지 않는지 확인한다.

- [ ] **Step 6: 두 창 타이머 검증과 커밋**

교사와 학생 창에서 제한 시간 문항을 열고 5초 이상 관찰해 남은 시간이 매 초 1초 이내로 일치하는지 확인한다.

Run: `node --test tests/*.test.js`

Expected: all tests PASS.

```bash
git add index.html firestore-store.js tests/firestore-store.test.js
git commit -m "학생 응답을 격리하고 Firestore 서버 시각으로 타이머를 동기화"
```

---

### Task 6: 실시간 대시보드·서술형 채점·관리자 삭제 이전

**Files:**
- Modify: `firestore-store.js`
- Modify: `tests/firestore-store.test.js`
- Modify: `index.html:3143-3858`

**Interfaces:**
- Produces store methods: `gradeAnswer`, `listSessions`, `purgeSessions`
- `purgeSessions(sessionIds)` deletes subcollection docs, session docs, and matching code docs in chunks of at most 450 operations

- [ ] **Step 1: 서술형 채점 병합 실패 테스트 작성**

```js
test('서술형 채점은 답안 내용을 보존하고 ok만 변경한다', async () => {
  const fake = makeFirestoreFake({
    'sessions/a/responses/s1': { answers: { '3': { txt: '학생 글', at: 10, ms: 20 } } }
  });
  const store = createStore(fake);
  await store.gradeAnswer('a', 's1', 3, true);
  assert.deepEqual((await store.getOwnResponses('a', 's1'))['3'], {
    txt: '학생 글', at: 10, ms: 20, ok: true
  });
});
```

- [ ] **Step 2: 실패 확인과 최소 구현**

Run: `node --test tests/firestore-store.test.js --test-name-pattern="서술형 채점"`

Expected: FAIL before and PASS after `gradeAnswer` implementation.

- [ ] **Step 3: 대시보드 호출 교체**

`screenDashboard`는 세션/세트를 단발 조회하고 students/responses 컬렉션만 구독한다. 응답 문서는 `responseDocsToQuestionMaps`로 기존 `dash.answers` 형태에 맞춘다. status는 별도 구독하지 않고 live 또는 세션 상태 갱신 시 필요한 시점에 단발 조회한다. `dashGrade`는 `gradeAnswer`를 호출한다.

- [ ] **Step 4: 관리자 삭제 대상과 batch 경계 실패 테스트 작성**

```js
test('기간 삭제는 세션 하위 문서와 연결 코드만 지운다', async () => {
  const fake = makeFirestoreFake({
    'codes/CODE23': { sessionId: 's1' },
    'sessions/s1': { setId: 'set1' },
    'sessions/s1/meta/live': { q: -1 },
    'sessions/s1/students/a': { name: '가' },
    'sessions/s1/responses/a': { answers: {} },
    'quiz_sets/set1': { title: '보존' }
  });
  await createStore(fake).purgeSessions(['s1']);
  assert.equal(fake.value('sessions/s1'), undefined);
  assert.equal(fake.value('codes/CODE23'), undefined);
  assert.deepEqual(fake.value('quiz_sets/set1'), { title: '보존' });
});
```

- [ ] **Step 5: 관리자 단발 조회와 삭제 구현**

`admLoad`는 sessions 컬렉션을 단발 조회한 뒤 각 세션의 students/responses 컬렉션을 단발 조회한다. `admLogin`/`admChangePw`는 `config/app.adminHash`를 사용한다. `admPurge`는 화면에서 RTDB 다중 경로 update를 만들지 않고 `purgeSessions(ids)`를 호출한다.

`purgeSessions`는 각 세션의 meta/students/responses와 해당 `sessionId`를 가진 codes를 조회해 문서 참조를 모으고, 최대 450개씩 batch commit한다. 실패 시 남은 문서를 재조회할 수 있도록 오류를 그대로 반환한다.

- [ ] **Step 6: 자동 테스트와 CSV 회귀 검증**

Run: `node --test tests/*.test.js`

Expected: all tests PASS.

실제 대시보드에서 서술형 O/X/미채점 전환, 점수·정답률 반영, CSV의 텍스트와 `미채점` 표시를 확인한다.

- [ ] **Step 7: 커밋**

```bash
git add index.html firestore-store.js tests/firestore-store.test.js
git commit -m "대시보드 채점과 관리자 조회 삭제를 Firestore로 이전"
```

---

### Task 7: 보안 규칙·문서와 RTDB 잔재 제거

**Files:**
- Create: `firestore.rules`
- Modify: `README.md`
- Modify: `FIRESTORE-MIGRATION.md`
- Modify: `index.html`
- Delete: `database.rules.json`

**Interfaces:**
- Security contract: authenticated users can access required Firestore paths; quiz set delete is denied

- [ ] **Step 1: Firestore 규칙 작성**

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function signedIn() { return request.auth != null; }
    match /quiz_sets/{setId} {
      allow read, create, update: if signedIn();
      allow delete: if false;
    }
    match /images/{setId}/q/{questionIndex} {
      allow read, write: if signedIn();
    }
    match /codes/{code} {
      allow read, write: if signedIn();
    }
    match /sessions/{sessionId} {
      allow read, write: if signedIn();
      match /{document=**} { allow read, write: if signedIn(); }
    }
    match /config/{doc} {
      allow read, write: if signedIn();
    }
    match /clock/{sampleId} {
      allow read, write: if signedIn();
    }
  }
}
```

- [ ] **Step 2: RTDB 잔재 정적 검사**

Run: `rg -n "databaseURL|firebase-database|firebase\.database|ServerValue|serverTimeOffset|function R\(|\.once\('value'\)|\.transaction\(" index.html firestore-*.js README.md FIRESTORE-MIGRATION.md`

Expected: no production-code matches. Historical migration prose may name RTDB conceptually but must not instruct current operation to use it.

- [ ] **Step 3: 운영 문서 갱신**

README에 Firestore 생성 위치 `asia-southeast1`, 익명 인증, `firestore.rules` 게시, 데이터 구조, 읽기 절감 원칙, JSON 데이터 이전, 실제 배포 검증 절차를 기록한다. 동시 접속 100명 제한과 학년별 RTDB 프로젝트 분리 안내는 제거한다.

`FIRESTORE-MIGRATION.md`는 미착수 안내 대신 완료 체크리스트와 배포 후 확인할 항목을 담는다.

- [ ] **Step 4: 전체 테스트와 문법 검사**

Run: `node --test tests/*.test.js`

Expected: all tests PASS with no warnings.

Run: `git diff --check`

Expected: no output, exit code 0.

- [ ] **Step 5: RTDB 규칙 제거와 커밋**

모든 자동 검증과 로컬 브라우저 검증이 끝난 뒤 `database.rules.json`을 삭제한다.

```bash
git add index.html firestore.rules README.md FIRESTORE-MIGRATION.md database.rules.json
git commit -m "Firestore 보안 규칙과 운영 문서를 완성하고 RTDB 설정을 제거"
```

---

### Task 8: Firebase 콘솔 설정과 실제 배포 전 회귀 검증

**Files:**
- Modify: `FIRESTORE-MIGRATION.md` — 검증 일시와 각 체크 항목의 성공 결과 기록

**Interfaces:**
- Consumes: Firebase project `video-quiz-65798`, `firestore.rules`, deployed application

- [ ] **Step 1: Firebase 콘솔에서 Firestore 생성**

Chrome의 기존 로그인 세션으로 Firebase 콘솔을 열고 프로젝트 `video-quiz-65798`인지 다시 확인한다. Firestore 데이터베이스가 없을 때만 프로덕션 모드, 위치 `asia-southeast1`로 생성한다. 다른 프로젝트나 위치가 보이면 중단하고 사용자에게 확인한다.

- [ ] **Step 2: 규칙 게시**

콘솔의 Firestore Rules에 저장소의 `firestore.rules` 전체를 붙여넣고 게시한다. 게시 후 표시되는 규칙이 로컬 파일과 일치하는지 확인한다.

- [ ] **Step 3: 기존 세트 데이터 이전**

전환 전 배포 앱에서 유일한 세트를 JSON으로 내보내 안전한 로컬 파일로 보관한다. Firestore 버전 앱에서 같은 파일을 가져온다. 제목, 5종 문항 설정과 이미지 수를 원본과 비교한다. 원본 RTDB 데이터 자체는 삭제하지 않는다.

- [ ] **Step 4: 로컬/미배포 버전 전체 브라우저 시나리오**

두 개 이상의 창을 사용해 다음을 확인한다.

1. 5종 문항 저장 후 재편집과 이미지 양쪽 표시
2. 같은 세트에서 두 반을 시작했을 때 서로 다른 코드와 분리된 응답
3. 학생 문항 표시가 1초 이내이며 타이머 오차가 1초 이내
4. 정답 공개 전 교사 화면에 정답과 분포가 없음
5. 단답 정규화, 복수 정답 완전 일치, 서술형 미채점과 O/X 채점
6. 문항 종료 후 교사/학생 순위 반영
7. CSV 텍스트 답안과 미채점 표시
8. 관리자 로그인, 전 세션 조회, 테스트 기간 삭제

- [ ] **Step 5: 최종 자동 검증**

Run: `node --test tests/*.test.js`

Expected: all tests PASS with no warnings.

Run: `git diff --check`

Expected: no output.

Run: `git status --short`

Expected: only intentional verification-note changes, or no output.

- [ ] **Step 6: 검증 기록 커밋**

```bash
git add FIRESTORE-MIGRATION.md
git commit -m "Firestore 실제 수업 흐름 검증 결과를 기록"
```

---

### Task 9: GitHub Pages 배포와 배포 주소 최종 확인

**Files:**
- No code changes expected

**Interfaces:**
- Consumes: clean `main` branch and GitHub Pages URL `https://shining-jade.github.io/video-quiz/`

- [ ] **Step 1: 배포 직전 저장소 상태 확인**

Run: `git status -sb`

Expected: `main` is ahead of `origin/main` only by intentional Firestore commits and worktree is clean.

Run: `git log --oneline origin/main..main`

Expected: only reviewed Korean Firestore migration commits.

- [ ] **Step 2: main 푸시**

Run: `git push origin main`

Expected: push succeeds without force.

- [ ] **Step 3: GitHub Pages 배포 대기와 확인**

GitHub Pages 또는 Actions 상태가 성공할 때까지 확인하고, 배포 주소에서 Firestore SDK 파일과 최신 커밋의 동작이 제공되는지 확인한다.

- [ ] **Step 4: 배포 주소 핵심 2창 회귀**

새 테스트 세션을 만들어 교사/학생 입장, 문항 열기, 1초 이내 타이머 일치, 답 제출, 공개 전 은닉, 정답 공개, 문항 닫기와 board 반영, 세션 종료를 다시 수행한다. 브라우저 콘솔에 Firebase permission 오류나 unhandled rejection이 없어야 한다.

- [ ] **Step 5: Firestore 사용량 확인**

Firebase 콘솔 사용량에서 테스트 세션의 읽기/쓰기 수가 학생의 live 문서 구독과 문항 단위 board 읽기 설계에 부합하며, 응답마다 학생 수만큼 board 읽기가 증가하지 않는지 확인한다.

- [ ] **Step 6: 최종 상태 보고**

배포 URL, 푸시 커밋, 자동 테스트 결과, 실제 검증한 시나리오, 데이터 이전 여부, 남은 운영상 주의사항을 사용자에게 전달한다.
