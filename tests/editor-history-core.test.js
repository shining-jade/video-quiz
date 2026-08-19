const test = require('node:test');
const assert = require('node:assert/strict');
const EditorHistoryCore = require('../editor-history-core');

test('편집 이력은 50단계 undo/redo와 저장 기준점 reset을 지킨다', () => {
  const history = EditorHistoryCore.create({ title: '0' }, { limit: 50 });
  for (let i = 1; i <= 55; i++) history.record({ title: String(i) }, { key: 'title' });
  for (let i = 0; i < 50; i++) history.undo();
  assert.equal(history.current().title, '5');
  assert.equal(history.canUndo(), false);
  assert.equal(history.redo().title, '6');
  history.reset({ title: 'saved' });
  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), false);
});

test('같은 필드의 짧은 연속 입력은 하나의 undo 단계로 합쳐진다', () => {
  const history = EditorHistoryCore.create({ title: '' });
  history.record({ title: '첫' }, { key: 'title', at: 100 });
  history.record({ title: '첫 글자' }, { key: 'title', at: 400 });
  history.record({ title: '완성' }, { key: 'title', at: 800 });
  assert.equal(history.current().title, '완성');
  assert.equal(history.undo().title, '');
  assert.equal(history.canUndo(), false);
});

test('서로 다른 필드 또는 시간 창 밖의 입력은 별도 undo 단계가 된다', () => {
  const history = EditorHistoryCore.create({ title: '', text: '' });
  history.record({ title: '제목', text: '' }, { key: 'title', at: 100 });
  history.record({ title: '제목', text: '본문' }, { key: 'text', at: 200 });
  history.record({ title: '제목 수정', text: '본문' }, { key: 'title', at: 1000 });
  assert.equal(history.undo().title, '제목');
  assert.equal(history.undo().text, '');
  assert.equal(history.undo().title, '');
});

test('손상된 snapshot은 현재 상태를 유지하고 실패 결과를 반환한다', () => {
  const history = EditorHistoryCore.create({ title: '정상' });
  const circular = {};
  circular.self = circular;
  const result = history.record(circular, { key: 'bad', at: 1 });
  assert.equal(result.ok, false);
  assert.deepEqual(history.current(), { title: '정상' });
  assert.equal(history.canUndo(), false);
  const resetResult = history.reset(circular);
  assert.equal(resetResult.ok, false);
  assert.deepEqual(history.current(), { title: '정상' });
});

test('ok:false/error 필드를 가진 정상 JSON 상태도 손상 snapshot으로 오인하지 않는다', () => {
  const initial = { ok: false, error: 'valid', title: '초기' };
  const history = EditorHistoryCore.create(initial);
  assert.deepEqual(history.current(), initial);
  const next = { ok: false, error: 'valid', title: '수정' };
  assert.deepEqual(history.record(next, { key: 'title', at: 1 }), next);
  assert.deepEqual(history.reset(initial), initial);
});

test('반환된 snapshot을 바꿔도 내부 이력은 오염되지 않는다', () => {
  const history = EditorHistoryCore.create({ nested: { value: 1 } });
  const current = history.current();
  current.nested.value = 99;
  assert.equal(history.current().nested.value, 1);
  history.record({ nested: { value: 2 } });
  const undone = history.undo();
  undone.nested.value = 88;
  assert.equal(history.current().nested.value, 1);
});
