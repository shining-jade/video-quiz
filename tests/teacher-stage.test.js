const test = require('node:test');
const assert = require('node:assert/strict');
const TeacherStage = require('../teacher-stage.js');

test('QR bubble position stays inside the fullscreen container', () => {
  assert.deepEqual(
    TeacherStage.clampBubblePosition(
      { x: 980, y: -20 },
      { width: 260, height: 320 },
      { width: 1200, height: 800 },
      16
    ),
    { x: 924, y: 16 }
  );
});

test('a stage smaller than its bubble never produces negative coordinates', () => {
  assert.deepEqual(
    TeacherStage.clampBubblePosition(
      { x: 100, y: 100 },
      { width: 400, height: 400 },
      { width: 300, height: 300 },
      16
    ),
    { x: 16, y: 16 }
  );
});
