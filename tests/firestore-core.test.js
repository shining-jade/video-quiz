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
    s1: { answers: { '0': { c: 1, ok: true }, '2': { txt: '서술' } } },
    s2: { answers: { '0': { c: 0, ok: false } } }
  };
  assert.deepEqual(core.responseDocsToQuestionMaps(docs), {
    '0': { s1: { c: 1, ok: true }, s2: { c: 0, ok: false } },
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

test('관리자 일괄 작업을 지정한 크기로 나눈다', () => {
  assert.deepEqual(core.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.throws(() => core.chunk([1], 0), /양수/);
});
