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

test('앞으로 seek하면 건너뛴 문항을 열지 않고 지나간 것으로 둔다', () => {
  const trigger = QuizTriggerCore.create([
    { t: 80, videoIndex: 0 }, { t: 20, videoIndex: 0 }, { t: 80, videoIndex: 0 }
  ]);
  const moved = trigger.advance({ videoIndex: 0, previousTime: 15, currentTime: 90, event: 'seek' });

  assert.deepEqual(moved.enqueue, []);
  assert.deepEqual(moved.skipped, [1, 0, 2]);
  assert.deepEqual(trigger.state(), ['completed', 'completed', 'completed']);
});

test('건너뛴 문항도 되감으면 다시 살아난다', () => {
  const trigger = QuizTriggerCore.create([{ t: 20, videoIndex: 0 }, { t: 80, videoIndex: 0 }]);
  trigger.advance({ videoIndex: 0, previousTime: 5, currentTime: 90, event: 'seek' });

  const back = trigger.advance({ videoIndex: 0, previousTime: 90, currentTime: 10, event: 'seek' });
  assert.deepEqual(back.rearmed, [0, 1]);
  assert.deepEqual(
    trigger.advance({ videoIndex: 0, previousTime: 19, currentTime: 21, event: 'tick' }).enqueue, [0]
  );
});

test('재생으로 지나간 문항은 그대로 queue한다', () => {
  const trigger = QuizTriggerCore.create([
    { t: 80, videoIndex: 0 }, { t: 20, videoIndex: 0 }, { t: 80, videoIndex: 0 }
  ]);
  const played = trigger.advance({ videoIndex: 0, previousTime: 15, currentTime: 90, event: 'tick' });

  assert.deepEqual(played.enqueue, [1, 0, 2]);
  assert.deepEqual(played.skipped, []);
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

/* 영상 이동 감지는 index.html 안에 있으므로 그 함수만 꺼내 검사한다. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadDetectSeek() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = html.indexOf('function plDetectSeek(');
  assert.ok(start >= 0, 'plDetectSeek must exist in index.html');
  const end = html.indexOf('\n}', start);
  const context = {};
  vm.runInNewContext(html.slice(start, end + 2), context);
  return context.plDetectSeek;
}

test('교사가 영상을 앞으로 옮기면 이동으로 본다', () => {
  const detect = loadDetectSeek();
  // 0.2초 만에 영상이 4분 넘게 흘렀다면 드래그다.
  assert.equal(detect(120, 380, 0.2, 1), true);
});

test('탭이 가려져 tick이 밀린 것은 이동으로 보지 않는다', () => {
  const detect = loadDetectSeek();
  // 30초 동안 화면이 가려져 있었고 영상도 30초 흘렀을 뿐이다.
  assert.equal(detect(100, 130, 30, 1), false);
});

test('배속 재생도 이동으로 오해하지 않는다', () => {
  const detect = loadDetectSeek();
  assert.equal(detect(100, 104, 2, 2), false);
});

test('되감기는 그대로 이동으로 본다', () => {
  const detect = loadDetectSeek();
  assert.equal(detect(300, 100, 0.2, 1), true);
});

test('보통 재생은 이동이 아니다', () => {
  const detect = loadDetectSeek();
  assert.equal(detect(100, 100.2, 0.2, 1), false);
});
