const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../playlist-core');

test('normalizes a legacy single-video quiz into one video entry', () => {
  assert.deepEqual(core.normalizeVideos({
    videoId: 'abc', videoUrl: 'https://youtu.be/abc',
    questions: [{ t: 90, text: 'question' }]
  }), [{
    videoId: 'abc', videoUrl: 'https://youtu.be/abc',
    startSec: 0, endSec: null,
    questions: [{ t: 90, text: 'question' }]
  }]);
});

test('maps the active playback range onto the timeline ratio', () => {
  assert.equal(core.timelineRatio(120, 120, 630), 0);
  assert.equal(core.timelineRatio(375, 120, 630), 0.5);
  assert.equal(core.timelineRatio(630, 120, 630), 1);
});

test('flattens questions with stable video metadata and global ordering', () => {
  const flat = core.flattenQuestions([
    { questions: [{ t: 10 }, { t: 20 }] },
    { questions: [{ t: 30 }] }
  ]);
  assert.deepEqual(flat.map(q => [q.key, q.number, q.videoIndex, q.questionIndex]), [
    ['v0q0', 1, 0, 0], ['v0q1', 2, 0, 1], ['v1q0', 3, 1, 0]
  ]);
});

test('validates the playback range and question times', () => {
  assert.deepEqual(core.validateVideo({
    startSec: 100, endSec: 90, questions: [{ t: 95 }]
  }, 120), ['醫낅즺 ?쒓컙? ?쒖옉 ?쒓컙蹂대떎 ?ㅼ뿬???⑸땲??']);
  assert.deepEqual(core.validateVideo({
    startSec: 10, endSec: 90, questions: [{ t: 95 }]
  }, 120), ['1踰?臾명빆???ъ깮 援ш컙 諛뽰뿉 ?덉뒿?덈떎.']);
  assert.deepEqual(core.validateVideo({
    startSec: 10, endSec: 130, questions: []
  }, 120), ['醫낅즺 ?쒓컙???곸긽 湲몄씠瑜??섏뒿?덈떎.']);
});

test('returns the next video start time or a completed playback state', () => {
  const videos = [{ startSec: 10 }, { startSec: 20 }];
  assert.deepEqual(core.nextPlaybackState(videos, 0), {
    done: false, videoIndex: 1, startSec: 20
  });
  assert.deepEqual(core.nextPlaybackState(videos, 1), {
    done: true, videoIndex: 1, startSec: null
  });
});

test('문항을 다른 영상으로 옮기면 상대 시각과 canonical 이미지 키가 함께 이동한다', () => {
  const videos = [
    { startSec: 10, endSec: 110, questions: [{ t: 60, q: '중간' }] },
    { startSec: 200, endSec: 240, questions: [] }
  ];
  const moved = core.moveQuestion(videos, { v0q0: 'data:image/png;base64,A' },
    { videoIndex: 0, questionIndex: 0 }, { videoIndex: 1, questionIndex: 0 });
  assert.equal(moved.videos[1].questions[0].t, 220);
  assert.equal(moved.images.v1q0, 'data:image/png;base64,A');
  assert.equal(moved.images.v0q0, undefined);
  assert.equal(videos[0].questions[0].t, 60);
});

test('같은 영상 아래로 이동할 때 제거 후 목적지 index를 보정한다', () => {
  const moved = core.moveQuestion([
    { questions: [{ t: 1, id: 'a' }, { t: 2, id: 'b' }, { t: 3, id: 'c' }] }
  ], {}, { videoIndex: 0, questionIndex: 0 }, { videoIndex: 0, questionIndex: 2 });
  assert.deepEqual(moved.videos[0].questions.map(q => q.id), ['b', 'a', 'c']);
});

test('빈 재생구간은 목적지 시작시각으로 안전하게 clamp하고, 동일位置는 no-op이다', () => {
  const videos = [
    { startSec: 10, endSec: 10, questions: [{ t: 10, id: 'a' }] },
    { startSec: 200, endSec: null, questions: [] }
  ];
  const moved = core.moveQuestion(videos, {}, { videoIndex: 0, questionIndex: 0 }, { videoIndex: 1, questionIndex: 0 });
  assert.equal(moved.videos[1].questions[0].t, 200);
  const same = core.moveQuestion(videos, {}, { videoIndex: 0, questionIndex: 0 }, { videoIndex: 0, questionIndex: 0 });
  assert.equal(same.moved, false);
  assert.deepEqual(same.videos, videos);
});

test('무효 위치는 입력을 변경하지 않고 이동하지 않는다', () => {
  const videos = [{ questions: [{ t: 1, id: 'a' }] }];
  const images = { v0q0: 'img' };
  const result = core.moveQuestion(videos, images, { videoIndex: 4, questionIndex: 0 }, { videoIndex: 0, questionIndex: 0 });
  assert.equal(result.moved, false);
  assert.deepEqual(result.videos, videos);
  assert.deepEqual(result.images, images);
});

test('영상 0의 legacy numeric 이미지 키만 v0qN으로 복원하고 다른 영상에 복제하지 않는다', () => {
  const moved = core.moveQuestion([
    { questions: [{ t: 1, id: 'a' }] },
    { questions: [{ t: 2, id: 'b' }] }
  ], { '0': 'legacy-a' },
    { videoIndex: 0, questionIndex: 0 }, { videoIndex: 1, questionIndex: 1 });
  assert.equal(moved.images.v0q0, undefined);
  assert.equal(moved.images.v1q0, undefined);
  assert.equal(moved.images.v1q1, 'legacy-a');
});

test('같은 영상의 끝 index로 이동하면 문항이 실제 마지막에 삽입된다', () => {
  const moved = core.moveQuestion([
    { questions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
  ], {}, { videoIndex: 0, questionIndex: 0 }, { videoIndex: 0, questionIndex: 3 });
  assert.deepEqual(moved.videos[0].questions.map(q => q.id), ['b', 'c', 'a']);
});

test('endSec이 null이면 durationSec을 원본 영상의 절대 끝 시각으로 사용한다', () => {
  const videos = [
    { startSec: 10, endSec: null, durationSec: 110, questions: [{ t: 60, id: 'middle' }] },
    { startSec: 200, endSec: null, durationSec: 240, questions: [] }
  ];
  const moved = core.moveQuestion(videos, {},
    { videoIndex: 0, questionIndex: 0 }, { videoIndex: 1, questionIndex: 0 });
  assert.equal(moved.videos[1].questions[0].t, 220);
  assert.equal(videos[0].questions[0].t, 60);
});

test('명시적 endSec은 durationSec보다 우선하고 durationSec이 start 이하이면 fail-safe한다', () => {
  const explicit = core.moveQuestion([
    { startSec: 10, endSec: 110, durationSec: 999, questions: [{ t: 60 }] },
    { startSec: 200, endSec: 240, durationSec: 999, questions: [] }
  ], {}, { videoIndex: 0, questionIndex: 0 }, { videoIndex: 1, questionIndex: 0 });
  assert.equal(explicit.videos[1].questions[0].t, 220);
  const invalid = core.moveQuestion([
    { startSec: 10, endSec: null, durationSec: 10, questions: [{ t: 60 }] },
    { startSec: 200, endSec: null, durationSec: 200, questions: [] }
  ], {}, { videoIndex: 0, questionIndex: 0 }, { videoIndex: 1, questionIndex: 0 });
  assert.equal(invalid.videos[1].questions[0].t, 200);
});

test('끝 시각과 duration을 알 수 없거나 유효하지 않으면 목적지 시작시각으로 clamp한다', () => {
  const moved = core.moveQuestion([
    { startSec: 10, endSec: null, durationSec: 'unknown', questions: [{ t: 80 }] },
    { start: 200, end: null, durationSec: -5, questions: [] }
  ], {}, { videoIndex: 0, questionIndex: 0 }, { videoIndex: 1, questionIndex: 0 });
  assert.equal(moved.videos[1].questions[0].t, 200);
});
