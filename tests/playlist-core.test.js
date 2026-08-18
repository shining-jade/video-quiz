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
