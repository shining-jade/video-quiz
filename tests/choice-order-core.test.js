const test = require('node:test');
const assert = require('node:assert/strict');
const ChoiceOrderCore = require('../choice-order-core.js');

test('단일 정답 보기를 옮기면 보기와 정답 인덱스가 함께 이동한다', () => {
  const question = { type: 'choice', choices: ['가', '나', '다', '라'], answer: 1, answers: [] };

  const moved = ChoiceOrderCore.move(question, 1, 3);

  assert.deepEqual(moved.choices, ['가', '다', '라', '나']);
  assert.equal(moved.answer, 3);
  assert.deepEqual(question.choices, ['가', '나', '다', '라']);
});

test('복수 정답 보기를 옮기면 모든 정답 인덱스를 새 순서로 다시 매핑한다', () => {
  const question = { type: 'multi', choices: ['가', '나', '다', '라'], answer: 0, answers: [0, 2] };

  const moved = ChoiceOrderCore.move(question, 0, 2);

  assert.deepEqual(moved.choices, ['나', '다', '가', '라']);
  assert.deepEqual(moved.answers, [1, 2]);
});

test('O/X와 같은 위치 이동은 원본을 바꾸지 않고 거부한다', () => {
  assert.equal(ChoiceOrderCore.move({ type: 'ox', choices: ['O', 'X'], answer: 0 }, 0, 1), null);
  assert.equal(ChoiceOrderCore.move({ type: 'choice', choices: ['가', '나'], answer: 0 }, 1, 1), null);
});
