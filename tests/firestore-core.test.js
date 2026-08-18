const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../firestore-core.js');
const draft = require('../editor-draft.js');

function memoryStorage(initial = {}) {
  const values = { ...initial };
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null; },
    setItem(key, value) { values[key] = String(value); },
    removeItem(key) { delete values[key]; }
  };
}

test('편집 초안은 새 세트와 기존 세트를 서로 다른 키에 보관한다', () => {
  const storage = memoryStorage();
  draft.write(storage, '', { title: '새 세트', videos: [] }, 1000);
  draft.write(storage, 'set-a', { title: '기존 세트', videos: [] }, 2000);

  assert.equal(draft.read(storage, '').model.title, '새 세트');
  assert.equal(draft.read(storage, 'set-a').model.title, '기존 세트');
  assert.equal(draft.read(storage, 'set-b'), null);
});

test('편집 초안은 저장용 필드만 복제하고 저장 시각으로 복구 여부를 정한다', () => {
  const storage = memoryStorage();
  const model = {
    title: '수정', author: '교사', settings: { limitSec: 15 },
    videos: [{ videoUrl: 'https://youtu.be/x', videoId: 'x', questions: [{ text: '문항' }] }], createdAt: 10,
    archived: false, saved: false, settingsOpen: true
  };

  draft.write(storage, 'set-a', model, 2000);
  model.videos[0].questions[0].text = '나중 변경';
  const restored = draft.read(storage, 'set-a');

  assert.equal(restored.model.videos[0].questions[0].text, '문항');
  assert.equal(restored.model.videoId, undefined);
  assert.equal(restored.model.questions, undefined);
  assert.equal(restored.model.saved, undefined);
  assert.equal(restored.model.settingsOpen, undefined);
  assert.equal(draft.isNewer(restored, 1999), true);
  assert.equal(draft.isNewer(restored, 2000), false);
});

test('편집 초안은 다중 영상과 영상별 문항을 보존한다', () => {
  const storage = memoryStorage();
  const model = { title: '세트', videos: [
    { videoId: 'a', startSec: 10, endSec: 20, questions: [{ t: 15 }] },
    { videoId: 'b', startSec: 30, endSec: 60, questions: [{ t: 40 }] }
  ] };

  draft.write(storage, 'set-a', model, 1000);

  assert.deepEqual(draft.read(storage, 'set-a').model.videos, model.videos);
});

test('깨진 편집 초안은 무시하고 정식 저장 뒤 지울 수 있다', () => {
  const storage = memoryStorage({ vq_draft_set_a: '{broken' });
  assert.equal(draft.read(storage, 'set-a'), null);
  draft.write(storage, 'set-a', { title: '복구', questions: [] }, 1000);
  draft.clear(storage, 'set-a');
  assert.equal(draft.read(storage, 'set-a'), null);
});

test('충돌한 반 코드를 건너뛰고 다음 코드를 사용한다', async () => {
  const attempts = [];
  const claim = async code => { attempts.push(code); return code === 'NEW234'; };
  const result = await core.claimFirstAvailableCode(['OLD234', 'NEW234'], claim);
  assert.equal(result, 'NEW234');
  assert.deepEqual(attempts, ['OLD234', 'NEW234']);
});

test('Timestamp와 왕복 중간값으로 서버 시각 오프셋을 계산한다', () => {
  const ts = { toMillis: () => 10_250 };
  assert.equal(core.timestampMillis(ts), 10_250);
  assert.equal(core.offsetFromRoundTrip(10_250, 10_000, 10_100), 200);
});

test('학생별 응답 문서를 기존 문항별 화면 형태로 바꾼다', () => {
  const docs = {
    s1: { answers: { '0': { c: 1, ok: true }, '2': { txt: '서술' } } },
    s2: { answers: { '0': { c: 0, ok: false } } }
  };
  assert.deepEqual(core.responseDocsToQuestionMaps(docs), {
    '0': { s1: { c: 1 }, s2: { c: 0 } },
    '2': { s1: { txt: '서술' } }
  });
});

test('미제출 응답은 점수에서 빼고 등록 학생 모두의 점수를 만든다', () => {
  assert.deepEqual(core.buildBoard(
    { s1: { name: '가' }, s2: { name: '나' } },
    {
      s1: { answers: { '0': { ok: true }, '1': { txt: '서술' }, '2': { ok: false } } },
      s2: { answers: { '0': { ok: true }, '1': { ok: true } } }
    }
  ), { s1: 1, s2: 2 });
});

test('기존 응답은 제출로 보고 다시 고르는 응답은 집계와 점수에서 뺀다', () => {
  assert.equal(core.answerIsSubmitted({ c: 0 }), true);
  assert.equal(core.answerIsSubmitted({ c: 0, submitted: true }), true);
  assert.equal(core.answerIsSubmitted({ c: 0, submitted: false }), false);
  assert.equal(core.answerIsSubmitted(null), false);

  const docs = {
    s1: { answers: { '0': { c: 0, ok: true }, '1': { c: 1, ok: true, submitted: false } } },
    s2: { answers: { '0': { c: 1, ok: false, submitted: false } } }
  };
  assert.deepEqual(core.responseDocsToQuestionMaps(docs), {
    '0': { s1: { c: 0 } }
  });
  assert.deepEqual(core.buildBoard({ s1: {}, s2: {} }, docs), { s1: 1, s2: 0 });
});

test('현재 문항의 참여 제출 미제출 인원을 계산한다', () => {
  assert.deepEqual(core.submissionCounts(
    { a: {}, b: {}, c: {} },
    { a: { c: 0 }, b: { c: 1, submitted: false } }
  ), { participants: 3, submitted: 1, missing: 2 });
});

test('서버 마감 시각으로 타이머 비율과 색상 단계를 계산한다', () => {
  assert.deepEqual(core.timerView({ openedAt: 1000, limitSec: 15 }, 9000), {
    left: 7, ratio: 7 / 15, phase: 'warning'
  });
  assert.equal(core.timerView({ openedAt: 1000, limitSec: 15 }, 13000).phase, 'urgent');
  assert.equal(core.timerView({ openedAt: 0, limitSec: 0 }, 9000), null);
});

test('관리자 일괄 작업을 지정한 크기로 나눈다', () => {
  assert.deepEqual(core.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.throws(() => core.chunk([1], 0), /양수/);
});

test('private grades join only the matching response revision and raw response ok is discarded', () => {
  const responses = {
    s1: { uid: 's1', answers: {
      '0': { answer: 1, submitted: true, revision: 2, ok: true },
      '1': { answer: 'new', submitted: true, revision: 4, ok: false }
    } }
  };
  const grades = {
    's1__0': { uid: 's1', questionIndex: 0, revision: 2, ok: false },
    's1__1': { uid: 's1', questionIndex: 1, revision: 3, ok: true }
  };

  assert.deepEqual(core.responseDocsToQuestionMaps(responses, grades), {
    '0': { s1: { answer: 1, submitted: true, revision: 2, ok: false } },
    '1': { s1: { answer: 'new', submitted: true, revision: 4 } }
  });
});
