const test = require('node:test');
const assert = require('node:assert/strict');
const QuizTriggerCore = require('../quiz-trigger-core.js');

test('continue 직후 같은 시각 tick은 완료 문항을 다시 queue하지 않는다', () => {
  const trigger = QuizTriggerCore.create([{ t: 174, videoIndex: 0 }]);
  assert.deepEqual(trigger.advance({ videoIndex: 0, previousTime: 173.5, currentTime: 174.1, event: 'tick' }).enqueue, [0]);
  trigger.complete(0);
  assert.deepEqual(trigger.advance({ videoIndex: 0, previousTime: 174.1, currentTime: 174.2, event: 'tick' }).enqueue, []);
});

test('continue 직후 플레이어 시각이 1초 흔들려도 완료 문항을 재무장하지 않는다', () => {
  const trigger = QuizTriggerCore.create([{ t: 120, videoIndex: 0 }]);
  trigger.advance({ videoIndex: 0, previousTime: 119.5, currentTime: 120, event: 'tick' });
  trigger.complete(0);

  assert.deepEqual(
    trigger.advance({ videoIndex: 0, previousTime: 120, currentTime: 119, event: 'tick' }).rearmed,
    []
  );
  assert.deepEqual(
    trigger.advance({ videoIndex: 0, previousTime: 120, currentTime: 119, event: 'seek' }).rearmed,
    [0]
  );
});

test('문항 시각은 영상 시작 시각과 무관한 원본 YouTube 절대 초다', () => {
  const trigger = QuizTriggerCore.create([{ t: 174, videoIndex: 0 }]);
  assert.deepEqual(trigger.advance({ videoIndex: 0, previousTime: 15, currentTime: 173.9, event: 'tick' }).enqueue, []);
  assert.deepEqual(trigger.advance({ videoIndex: 0, previousTime: 173.9, currentTime: 174, event: 'tick' }).enqueue, [0]);
});

test('앞으로 seek하면 도착 시각까지 통과한 문항을 시각·전역 번호 순으로 queue한다', () => {
  const trigger = QuizTriggerCore.create([
    { t: 80, videoIndex: 0 }, { t: 20, videoIndex: 0 }, { t: 80, videoIndex: 0 }
  ]);
  assert.deepEqual(trigger.advance({ videoIndex: 0, previousTime: 15, currentTime: 90, event: 'seek' }).enqueue, [1, 0, 2]);
});

test('완료 문항은 marker보다 0.9초 전에는 재무장하지 않고 정확히 1초 전에서 재무장한다', () => {
  const trigger = QuizTriggerCore.create([{ t: 50, videoIndex: 0 }]);
  trigger.advance({ videoIndex: 0, previousTime: 49, currentTime: 50, event: 'tick' });
  trigger.complete(0);
  assert.deepEqual(trigger.advance({ videoIndex: 0, previousTime: 50, currentTime: 49.1, event: 'seek' }).rearmed, []);
  assert.deepEqual(trigger.advance({ videoIndex: 0, previousTime: 49.1, currentTime: 49, event: 'seek' }).rearmed, [0]);
  assert.deepEqual(trigger.advance({ videoIndex: 0, previousTime: 49, currentTime: 50, event: 'tick' }).enqueue, [0]);
});

test('다른 영상의 대기 문항은 현재 영상 queue에 섞이지 않는다', () => {
  const trigger = QuizTriggerCore.create([{ t: 10, videoIndex: 0 }, { t: 10, videoIndex: 1 }]);
  assert.deepEqual(trigger.advance({ videoIndex: 0, previousTime: 9, currentTime: 11, event: 'tick' }).enqueue, [0]);
  trigger.resetVideo(1);
  assert.deepEqual(trigger.advance({ videoIndex: 1, previousTime: 9, currentTime: 11, event: 'tick' }).enqueue, [1]);
  assert.equal(trigger.state()[0], 'queued');
  assert.equal(trigger.state()[1], 'queued');
});
