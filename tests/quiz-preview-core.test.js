const test = require('node:test');
const assert = require('node:assert/strict');

const Preview = require('../quiz-preview-core');

test('미리보기는 문항 3초 전부터 영상 단계를 시작하고 문항 시각에 열린다', () => {
  const state = Preview.create({ type: 'choice', t: 10, answer: 1 }, { startSec: 2 });

  assert.equal(state.phase, 'video');
  assert.equal(state.startAt, 7);
  assert.equal(Preview.advance(state, 9.9).phase, 'video');
  assert.equal(Preview.advance(state, 10).phase, 'question');
});

test('객관식 미리보기는 답을 고르기 전에는 어떤 보기에도 선택 상태가 없다', () => {
  const state = Preview.advance(
    Preview.create({ type: 'choice', t: 10, answer: 0, choices: ['정답', '오답'] }),
    10
  );

  assert.equal(state.answer, null);
  assert.equal(Preview.isSelected(state, 0), false);
  assert.equal(Preview.isSelected(state, 1), false);
  assert.equal(Preview.isSelected(Preview.select(state, 0), 0), true);
});

test('객관식과 복수선택과 단답형 답안을 실제 정답 기준으로 채점한다', () => {
  assert.equal(Preview.submit(Preview.select(Preview.create({ type: 'choice', t: 5, answer: 2 }), 2)).correct, true);
  assert.equal(Preview.submit(Preview.select(Preview.create({ type: 'multi', t: 5, answers: [0, 2] }), [2, 0])).correct, true);
  assert.equal(Preview.submit(Preview.select(Preview.create({ type: 'short', t: 5, accept: ['심폐 소생술'] }), '심폐소생술!')).correct, true);
});

test('제출 뒤 정답과 해설을 보여주고 계속 재생 단계로 전환한다', () => {
  const question = { type: 'ox', t: 5, answer: 0, explain: '맞는 설명입니다.' };
  const result = Preview.submit(Preview.select(Preview.advance(Preview.create(question), 5), 1));

  assert.equal(result.phase, 'result');
  assert.equal(result.correct, false);
  assert.equal(result.explanation, '맞는 설명입니다.');
  assert.equal(Preview.continuePlayback(result).phase, 'continued');
});

test('서술형은 자동 정오답 판정 없이 응답과 해설을 확인한다', () => {
  const result = Preview.submit(Preview.select(
    Preview.create({ type: 'long', t: 5, explain: '예시 해설' }),
    '학생이 작성한 답'
  ));

  assert.equal(result.correct, null);
  assert.equal(result.answer, '학생이 작성한 답');
  assert.equal(result.explanation, '예시 해설');
});
